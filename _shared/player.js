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

  // Gunzips while downloading; also accepts servers that already applied Content-Encoding.
  async function decodedBody(response) {
    const reader = response.body.getReader();
    const first = await reader.read();
    const head = first.value || new Uint8Array(0);
    const body = new ReadableStream({
      start(controller) { if (!first.done) controller.enqueue(head); else controller.close(); },
      async pull(controller) {
        const next = await reader.read();
        if (next.done) controller.close(); else controller.enqueue(next.value);
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
    const cached = await readCached(cache, asset, type);
    if (cached) return cached;
    const response = await fetch(new URL(asset.path, document.baseURI));
    if (!response.ok) throw new Error(`Unable to download ${label} (${response.status}).`);
    const bytes = await decodedBody(response);
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

  async function preparePayloads(onAssetReady) {
    const [manifest, cache] = await Promise.all([readManifest(), openCache()]);
    const keep = new Set();
    for (const asset of Object.values(manifest.files)) {
      for (const file of asset.segments ?? [asset]) if (file.sha256) keep.add(cacheKey(file.sha256));
    }
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
    const blobs = await (earlyPayloads ?? preparePayloads(() => { readyAssets++; reportProgress(); }));
    const urls = [];
    try {
      for (const key of Object.keys(payloadTypes)) {
        const url = URL.createObjectURL(blobs[key]);
        urls.push(url);
        config[key] = url;
      }
      return await window.createUnityInstance(canvas, config, progress => onProgress?.(0.5 + progress * 0.5));
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
