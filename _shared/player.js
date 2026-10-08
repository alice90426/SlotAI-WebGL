// Shared Pages adapter: the original Unity loader and game payloads stay unchanged.
(() => {
  "use strict";
  const siteRoot = new URL("../", document.currentScript.src);
  const payloadTypes = { dataUrl: "application/octet-stream", codeUrl: "application/wasm", frameworkUrl: "text/javascript" };
  // Decoded, integrity-verified payloads keyed by their SHA-256. The key is the
  // content hash, so a hit never needs a network request, gunzip, or rehash.
  // The wasm/framework are shared by every game, so one visit warms all games.
  const cacheName = "slotai-assets-v1";
  const maxCachedAssets = 24;
  const cacheKey = sha256 => new URL(`_slotai-cache/${sha256}`, siteRoot).href;

  async function getJson(url) {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error(`Unable to load ${url} (${response.status}).`);
    return response.json();
  }

  // Publisher-inlined manifest avoids one round trip; older pages fall back to the JSON file.
  const readManifest = () => window.slotaiSharedAssets
    ? Promise.resolve(window.slotaiSharedAssets)
    : getJson(new URL("shared-assets.json", document.baseURI));

  async function openCache() {
    try { return typeof caches === "object" ? await caches.open(cacheName) : null; }
    catch (error) { console.warn("Asset cache unavailable", error); return null; }
  }

  async function readCached(cache, asset, type) {
    if (!cache) return null;
    try {
      const hit = await cache.match(cacheKey(asset.sha256));
      if (!hit) return null;
      const blob = await hit.blob();
      return blob.size === asset.bytes ? new Blob([blob], { type }) : null;
    } catch (error) { console.warn("Asset cache read failed", error); return null; }
  }

  async function writeCached(cache, asset, blob, keep) {
    if (!cache) return;
    try {
      await cache.put(cacheKey(asset.sha256), new Response(blob, { headers: { "Content-Type": blob.type } }));
      // Evict oldest entries (insertion order) that the current game does not use.
      const keys = await cache.keys();
      for (let i = 0; keys.length - i > maxCachedAssets && i < keys.length; i++) {
        if (!keep.has(keys[i].url)) await cache.delete(keys[i]);
      }
    } catch (error) { console.warn("Asset cache write failed", error); }
  }

  // Startup progress: downloaded (compressed) bytes against the manifest total, then
  // Unity's own initialization. Shown in place of the template's loading bar.
  const progress = { total: 0, loaded: 0, starting: false, unity: 0, failed: false };
  let progressView = null;
  let progressFrame = 0;
  const formatMB = bytes => (bytes / 1048576).toFixed(1);

  function showProgress() {
    if (progressFrame) return;
    // A timer, not requestAnimationFrame: rAF stops while the tab is in the background.
    progressFrame = setTimeout(() => {
      progressFrame = 0;
      const container = document.getElementById("unity-container");
      if (!container) return;
      if (!progressView) {
        progressView = document.createElement("div");
        progressView.className = "slotai-loader";
        progressView.setAttribute("role", "progressbar");
        progressView.innerHTML = '<div class="slotai-loader-text"></div><div class="slotai-loader-track"><div class="slotai-loader-fill"></div></div>';
        container.append(progressView);
      }
      const text = progressView.querySelector(".slotai-loader-text");
      const fill = progressView.querySelector(".slotai-loader-fill");
      let fraction;
      if (progress.failed) {
        text.textContent = "Loading failed. Reload to retry.";
        fraction = 1;
      } else if (progress.starting) {
        fraction = progress.unity;
        text.textContent = `Starting game… ${Math.round(fraction * 100)}%`;
      } else {
        const total = Math.max(progress.total, progress.loaded);
        fraction = total > 0 ? progress.loaded / total : 0;
        text.textContent = `Downloading ${formatMB(progress.loaded)} / ${formatMB(total)} MB (${Math.round(fraction * 100)}%)`;
      }
      fill.style.width = `${Math.min(100, fraction * 100)}%`;
      progressView.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
    }, 50);
  }

  function hideProgress() {
    clearTimeout(progressFrame);
    progressFrame = 0;
    progressView?.remove();
    progressView = null;
  }

  // Gunzips while downloading; also accepts servers that already applied Content-Encoding.
  async function decodedBody(response, onBytes) {
    const reader = response.body.getReader();
    const first = await reader.read();
    const head = first.value || new Uint8Array(0);
    onBytes(head.length);
    const body = new ReadableStream({
      start(controller) { if (!first.done) controller.enqueue(head); else controller.close(); },
      async pull(controller) {
        const next = await reader.read();
        if (next.done) controller.close(); else { onBytes(next.value.length); controller.enqueue(next.value); }
      },
      cancel(reason) { return reader.cancel(reason); }
    });
    const gzip = head[0] === 0x1f && head[1] === 0x8b;
    return new Uint8Array(await new Response(gzip ? body.pipeThrough(new DecompressionStream("gzip")) : body).arrayBuffer());
  }

  async function sha256Hex(bytes) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
  }

  // Resolves every payload to a verified Blob. Payload preparation (cache lookup or
  // download + gunzip + hash) does not depend on the Unity loader script.
  // One content-addressed file: verified cache hit, or download + gunzip + hash + cache.
  async function loadVerified(cache, asset, type, keep, label) {
    const size = downloadSize(asset);
    const cached = await readCached(cache, asset, type);
    if (cached) {
      progress.loaded += size;
      showProgress();
      return cached;
    }
    const response = await fetch(new URL(asset.path, document.baseURI));
    if (!response.ok) throw new Error(`Unable to download ${label} (${response.status}).`);
    let received = 0;
    const bytes = await decodedBody(response, count => { received += count; progress.loaded += count; showProgress(); });
    // Without compressedBytes (older manifests) the estimate may differ; settle on the size.
    progress.loaded += size - received;
    showProgress();
    if (bytes.length !== asset.bytes || await sha256Hex(bytes) !== asset.sha256) {
      throw new Error(`Game asset failed integrity check: ${label}`);
    }
    const blob = new Blob([bytes], { type });
    writeCached(cache, asset, blob, keep); // Not awaited: storage must not delay startup.
    return blob;
  }

  const inlineBytes = base64 => Uint8Array.from(atob(base64), c => c.charCodeAt(0));

  // Format 3 splits .data into segments shared across games (IL2CPP metadata, default
  // resources) plus small inlined ones. Concatenation restores the original container;
  // the publisher verified that byte-for-byte, and each external segment is hash-checked.
  async function loadAsset(cache, asset, type, keep, key) {
    if (!asset.segments) return loadVerified(cache, asset, type, keep, key);
    const parts = await Promise.all(asset.segments.map((segment, index) => segment.inline !== undefined
      ? inlineBytes(segment.inline)
      : loadVerified(cache, segment, "application/octet-stream", keep, `${key} segment ${index}`)));
    const blob = new Blob(parts, { type });
    if (blob.size !== asset.bytes) throw new Error(`Game asset failed integrity check: ${key}`);
    return blob;
  }

  // Bytes this file transfers: the gzip size when the manifest records it.
  const downloadSize = asset => asset.compressedBytes ?? asset.bytes;

  async function preparePayloads(onAssetReady) {
    const [manifest, cache] = await Promise.all([readManifest(), openCache()]);
    const keep = new Set();
    for (const key of Object.keys(payloadTypes)) {
      const asset = manifest.files[key];
      for (const file of asset?.segments ?? (asset ? [asset] : [])) {
        if (!file.sha256) continue;
        keep.add(cacheKey(file.sha256));
        progress.total += downloadSize(file);
      }
    }
    showProgress();
    const blobs = {};
    // allSettled lets every download finish or fail before the caller reports an error.
    const results = await Promise.allSettled(Object.keys(payloadTypes).map(async key => {
      const asset = manifest.files[key];
      if (!asset) throw new Error(`Missing game asset: ${key}`);
      blobs[key] = await loadAsset(cache, asset, payloadTypes[key], keep, key);
      onAssetReady();
    }));
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
    return blobs;
  }

  // Game pages inline the manifest before this script, so payloads start loading
  // here in <head>, in parallel with the Unity loader script and page parsing.
  let readyAssets = 0;
  let reportProgress = null;
  const earlyPayloads = window.slotaiSharedAssets && typeof DecompressionStream === "function"
    ? preparePayloads(() => { readyAssets++; reportProgress?.(); })
    : null;
  earlyPayloads?.catch(() => {}); // Surfaced by slotaiCreateUnityInstance.

  window.slotaiCreateUnityInstance = async (canvas, config, onProgress) => {
    if (typeof DecompressionStream !== "function") {
      throw new Error("Please update your browser to play this game (gzip decompression is required).");
    }
    const total = Object.keys(payloadTypes).length;
    reportProgress = () => onProgress?.(readyAssets / total * 0.5);
    reportProgress();
    showProgress();
    const urls = [];
    try {
      const blobs = await (earlyPayloads ?? preparePayloads(() => { readyAssets++; reportProgress(); }));
      progress.starting = true;
      showProgress();
      for (const key of Object.keys(payloadTypes)) {
        const url = URL.createObjectURL(blobs[key]);
        urls.push(url);
        config[key] = url;
      }
      const instance = await window.createUnityInstance(canvas, config, value => {
        progress.unity = value;
        showProgress();
        onProgress?.(0.5 + value * 0.5);
      });
      hideProgress();
      return instance;
    } catch (error) {
      progress.failed = true;
      showProgress();
      throw error;
    } finally {
      urls.forEach(url => URL.revokeObjectURL(url));
    }
  };
  async function addNavigation() {
    const nav = document.createElement("nav");
    nav.className = "slotai-navigation";
    nav.setAttribute("aria-label", "Game navigation");
    const home = document.createElement("a");
    home.href = siteRoot.href;
    home.textContent = "SlotAI Games";
    const label = document.createElement("label");
    label.textContent = "Game ";
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Select game");
    select.disabled = true;
    label.append(select);
    nav.append(home, label);
    document.body.prepend(nav);
    // Embedded by the portfolio site (?embed=1): hide the game switcher bar.
    if (new URLSearchParams(location.search).has("embed")) {
      nav.hidden = true;
      nav.style.display = "none";
      document.documentElement.style.setProperty("--slotai-nav-height", "0px");
    }
    try {
      const catalog = await getJson(new URL("catalog.json", siteRoot));
      const placeholder = new Option("Choose a game", "");
      select.add(placeholder);
      for (const game of catalog.games) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(game)) continue;
        const url = new URL(`${game}/`, siteRoot);
        select.add(new Option(game, url.href, false, location.pathname === url.pathname || location.pathname === `${url.pathname}index.html`));
        const list = document.getElementById("slotai-game-list");
        if (list) {
          const link = document.createElement("a");
          link.href = url.href;
          link.textContent = game;
          list.append(link);
        }
      }
      select.disabled = false;
      select.addEventListener("change", () => { if (select.value) location.assign(select.value); });
      const requested = new URL(location.href).searchParams.get("game");
      if (requested && catalog.games.includes(requested) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(requested)) {
        const url = new URL(`${requested}/`, siteRoot);
        if (location.pathname !== url.pathname) location.replace(url);
      }
    } catch (error) {
      const message = document.createElement("span");
      message.textContent = "Game list unavailable. Reload to retry.";
      nav.append(message);
      console.error(error);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addNavigation);
  else addNavigation();
})();
