function getMetaContent(selector) {
  const el = document.querySelector(selector);
  if (!el) {
    return null;
  }
  const value = el.getAttribute("content");
  return value && value.trim() ? value.trim() : null;
}

function getVideoIdFromLocation() {
  try {
    const url = new URL(window.location.href);
    const v = url.searchParams.get("v");
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

function parseJsonObjectFromScriptText(scriptText, anchor) {
  const anchorIndex = scriptText.indexOf(anchor);
  if (anchorIndex === -1) {
    return null;
  }

  const firstBrace = scriptText.indexOf("{", anchorIndex);
  if (firstBrace === -1) {
    return null;
  }

  let depth = 0;
  for (let i = firstBrace; i < scriptText.length; i++) {
    const ch = scriptText[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth === 0) {
      const jsonText = scriptText.slice(firstBrace, i + 1);
      try {
        return JSON.parse(jsonText);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function extractPlayerResponseFromScripts() {
  const scripts = Array.from(document.scripts);
  for (const script of scripts) {
    const text = script.textContent;
    if (!text) continue;
    if (!text.includes("ytInitialPlayerResponse")) continue;

    const obj = parseJsonObjectFromScriptText(text, "ytInitialPlayerResponse");
    if (obj) return obj;
  }
  return null;
}

function normalizeText(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return value.trim() ? value.trim() : null;
  }

  if (typeof value === "object") {
    const simpleText = value.simpleText;
    if (typeof simpleText === "string" && simpleText.trim()) {
      return simpleText.trim();
    }

    const runs = value.runs;
    if (Array.isArray(runs)) {
      const joined = runs
        .map((r) => (typeof r?.text === "string" ? r.text : ""))
        .join("")
        .trim();
      return joined ? joined : null;
    }
  }

  return null;
}

function pickFirstNonEmpty(...values) {
  for (const v of values) {
    const normalized = normalizeText(v);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function extractWatchMetadata() {
  const videoId = getVideoIdFromLocation();

  const metaChannelId = getMetaContent('meta[itemprop="channelId"]');
  const metaDatePublished = getMetaContent('meta[itemprop="datePublished"]');
  const metaUploadDate = getMetaContent('meta[itemprop="uploadDate"]');

  const playerResponse = extractPlayerResponseFromScripts();
  const microformat = playerResponse?.microformat?.playerMicroformatRenderer ?? null;

  const channelId = pickFirstNonEmpty(
    metaChannelId,
    microformat?.externalChannelId
  );

  const publishDate = pickFirstNonEmpty(
    metaDatePublished,
    metaUploadDate,
    microformat?.publishDate,
    microformat?.uploadDate
  );

  const title = pickFirstNonEmpty(microformat?.title);

  return {
    videoId,
    channelId,
    publishDate,
    title
  };
}

const extApi =
  typeof browser !== "undefined"
    ? browser
    : typeof chrome !== "undefined"
      ? chrome
      : null;
const SETTINGS_DEFAULTS = { openInNewTab: true };

let ytNextUploadUi = null;
let lastProcessedVideoId = null;
let lastNextVideoId = null;
let lastRunTimer = null;
let lastLookupAtMs = 0;
let lastLookupOutcome = null;
let activeRunId = 0;

async function loadSettings() {
  try {
    if (!extApi) {
      return { ...SETTINGS_DEFAULTS };
    }
    const settings = await extApi.storage.sync.get(SETTINGS_DEFAULTS);
    return { ...SETTINGS_DEFAULTS, ...settings };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

function buildNextVideoUrl(videoId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitterMs(baseMs, factor = 0.25) {
  const delta = baseMs * factor;
  const min = Math.max(0, baseMs - delta);
  const max = baseMs + delta;
  return Math.floor(min + Math.random() * (max - min));
}

function extractHttpStatus(err) {
  const message = String(err?.message ?? "");
  const m = message.match(/\bHTTP\s+(\d{3})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function isRetryableHttpStatus(status) {
  if (!status) return false;
  if (status === 403) return true;
  if (status === 408) return true;
  if (status === 425) return true;
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

async function withRetries(fn, { attempts, baseDelayMs, onAttempt } = {}) {
  const maxAttempts = Math.max(1, Number(attempts ?? 3));
  const baseDelay = Math.max(50, Number(baseDelayMs ?? 250));

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (typeof onAttempt === "function") {
        onAttempt({ attempt, maxAttempts });
      }
      return await fn({ attempt, maxAttempts });
    } catch (err) {
      lastErr = err;
      const status = extractHttpStatus(err);
      if (!isRetryableHttpStatus(status) || attempt === maxAttempts) {
        throw err;
      }
      const delay = jitterMs(baseDelay * Math.pow(2, attempt - 1));
      await sleep(delay);
    }
  }
  throw lastErr ?? new Error("Retry failed");
}

function getCacheKeyForNextVideo(videoId) {
  return `yt_next_upload_v2_${videoId}`;
}

async function readNextVideoCache(videoId, ttlMs) {
  if (!extApi?.storage?.local || !videoId) return null;
  try {
    const key = getCacheKeyForNextVideo(videoId);
    const result = await extApi.storage.local.get(key);
    const entry = result?.[key] ?? null;
    if (!entry || typeof entry !== "object") return null;
    const ts = Number(entry.ts ?? 0);
    if (!Number.isFinite(ts) || ts <= 0) return null;
    if (Date.now() - ts > ttlMs) return null;
    const nextVideoId = typeof entry.nextVideoId === "string" ? entry.nextVideoId : null;
    if (!nextVideoId) return null;
    return { nextVideoId };
  } catch {
    return null;
  }
}

async function writeNextVideoCache(videoId, nextVideoId) {
  if (!extApi?.storage?.local || !videoId) return;
  try {
    const key = getCacheKeyForNextVideo(videoId);
    await extApi.storage.local.set({
      [key]: {
        ts: Date.now(),
        nextVideoId: typeof nextVideoId === "string" ? nextVideoId : null
      }
    });
  } catch {}
}

async function waitForWatchMetadata({ timeoutMs, intervalMs, runId } = {}) {
  const timeout = Math.max(500, Number(timeoutMs ?? 8000));
  const interval = Math.max(100, Number(intervalMs ?? 250));
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (runId !== undefined && runId !== activeRunId) {
      return null;
    }
    const metadata = extractWatchMetadata();
    const urlVideoId = getVideoIdFromLocation();
    if (metadata?.videoId && metadata?.videoId === urlVideoId && metadata?.channelId) {
      return metadata;
    }
    await sleep(interval);
  }
  return extractWatchMetadata();
}

function findFirstStringInText(text, regex) {
  const m = text.match(regex);
  if (!m) return null;
  return m[1] ? String(m[1]) : null;
}

function extractJsonObjectFromText(text, anchor) {
  const anchorIndex = text.indexOf(anchor);
  if (anchorIndex === -1) {
    return null;
  }

  const firstBrace = text.indexOf("{", anchorIndex);
  if (firstBrace === -1) {
    return null;
  }

  let depth = 0;
  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth === 0) {
      const jsonText = text.slice(firstBrace, i + 1);
      try {
        return JSON.parse(jsonText);
      } catch {
        return null;
      }
    }
  }

  return null;
}

function extractJsonObjectAfterProperty(text, propertyName) {
  const idx = text.indexOf(propertyName);
  if (idx === -1) {
    return null;
  }

  const colonIdx = text.indexOf(":", idx);
  if (colonIdx === -1) {
    return null;
  }

  const firstBrace = text.indexOf("{", colonIdx);
  if (firstBrace === -1) {
    return null;
  }

  let depth = 0;
  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth === 0) {
      const jsonText = text.slice(firstBrace, i + 1);
      try {
        return JSON.parse(jsonText);
      } catch {
        return null;
      }
    }
  }

  return null;
}

function findInObject(obj, predicate) {
  if (!obj) return null;
  const queue = [obj];
  while (queue.length) {
    const node = queue.shift();
    if (predicate(node)) return node;
    if (Array.isArray(node)) {
      for (const item of node) queue.push(item);
    } else if (typeof node === "object") {
      for (const key of Object.keys(node)) queue.push(node[key]);
    }
  }
  return null;
}

function extractRichGridContents(initialData) {
  const found = findInObject(initialData, (node) => {
    return (
      node &&
      typeof node === "object" &&
      node.richGridRenderer &&
      Array.isArray(node.richGridRenderer.contents)
    );
  });
  return found?.richGridRenderer?.contents ?? null;
}

function extractContinuationTokenFromItems(items) {
  for (const item of items) {
    const token = item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (typeof token === "string" && token) {
      return token;
    }
  }
  return null;
}

function extractVideoIdsFromItems(items) {
  const ids = [];
  for (const item of items) {
    const videoId =
      item?.richItemRenderer?.content?.videoRenderer?.videoId ??
      item?.richItemRenderer?.content?.gridVideoRenderer?.videoId ??
      item?.gridVideoRenderer?.videoId ??
      item?.videoRenderer?.videoId ??
      null;

    if (typeof videoId === "string" && videoId) {
      ids.push(videoId);
    }
  }
  return ids;
}

function extractContinuationItemsFromBrowseResponse(responseJson) {
  const actions = responseJson?.onResponseReceivedActions ?? responseJson?.onResponseReceivedEndpoints ?? null;
  if (!Array.isArray(actions)) {
    return [];
  }

  for (const action of actions) {
    const items =
      action?.appendContinuationItemsAction?.continuationItems ??
      action?.reloadContinuationItemsCommand?.continuationItems ??
      null;
    if (Array.isArray(items)) {
      return items;
    }
  }

  return [];
}

function extractYtCfg(html) {
  const apiKey = findFirstStringInText(html, /"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
  if (!apiKey) {
    return null;
  }

  const clientName =
    findFirstStringInText(html, /"INNERTUBE_CLIENT_NAME"\s*:\s*"([^"]+)"/) ??
    findFirstStringInText(html, /"INNERTUBE_CONTEXT_CLIENT_NAME"\s*:\s*([0-9]+)/);
  const clientVersion = findFirstStringInText(html, /"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/);
  const visitorData = findFirstStringInText(html, /"VISITOR_DATA"\s*:\s*"([^"]+)"/);

  const context =
    extractJsonObjectAfterProperty(html, '"INNERTUBE_CONTEXT"') ??
    extractJsonObjectAfterProperty(html, "INNERTUBE_CONTEXT");

  if (!context) {
    return null;
  }

  return { apiKey, context, clientName, clientVersion, visitorData };
}

function extractInitialData(html) {
  const anchors = ["var ytInitialData =", "window[\"ytInitialData\"] =", "ytInitialData ="];
  for (const anchor of anchors) {
    const obj = extractJsonObjectFromText(html, anchor);
    if (obj) return obj;
  }
  return null;
}

async function fetchText(url) {
  return await withRetries(
    async () => {
      const res = await fetch(url, {
        credentials: "include",
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.text();
    },
    { attempts: 4, baseDelayMs: 250 }
  );
}

async function postJson(url, body, { ytCfg, referrer } = {}) {
  return await withRetries(
    async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(ytCfg?.clientName ? { "x-youtube-client-name": String(ytCfg.clientName) } : null),
          ...(ytCfg?.clientVersion ? { "x-youtube-client-version": String(ytCfg.clientVersion) } : null),
          ...(ytCfg?.visitorData ? { "x-goog-visitor-id": String(ytCfg.visitorData) } : null)
        },
        body: JSON.stringify(body),
        ...(referrer ? { referrer, referrerPolicy: "origin-when-cross-origin" } : null),
        credentials: "include"
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    },
    { attempts: 4, baseDelayMs: 250 }
  );
}

async function findNextUploadVideoIdViaPage({ channelId, currentVideoId, maxPages = 20 }) {
  if (!channelId || !currentVideoId) {
    return null;
  }
  const channelVideosUrl = `https://www.youtube.com/channel/${encodeURIComponent(channelId)}/videos?view=0&sort=dd&flow=grid`;
  const html = await fetchText(channelVideosUrl);

  const ytCfg = extractYtCfg(html);
  const initialData = extractInitialData(html);
  if (!ytCfg || !initialData) {
    throw new Error("Failed to extract channel videos data");
  }

  let prevVideoId = null;
  let pages = 0;

  let items = extractRichGridContents(initialData);
  if (!items) {
    throw new Error("Failed to locate rich grid contents");
  }

  while (pages < maxPages) {
    pages++;

    const videoIds = extractVideoIdsFromItems(items);
    for (const vid of videoIds) {
      if (vid === currentVideoId) {
        return prevVideoId;
      }
      prevVideoId = vid;
    }

    const token = extractContinuationTokenFromItems(items);
    if (!token) {
      return null;
    }

    const browseUrl = `https://www.youtube.com/youtubei/v1/browse?key=${encodeURIComponent(
      ytCfg.apiKey
    )}`;
    const responseJson = await postJson(
      browseUrl,
      { context: ytCfg.context, continuation: token },
      { ytCfg, referrer: channelVideosUrl }
    );

    const continuationItems = extractContinuationItemsFromBrowseResponse(responseJson);
    if (!continuationItems.length) {
      return null;
    }

    items = continuationItems;
  }

  return null;
}

function extractVideoIdsFromRss(xmlText) {
  const ids = [];
  const re = /<yt:videoId>([^<]+)<\/yt:videoId>/g;
  let m;
  while ((m = re.exec(xmlText))) {
    const id = String(m[1] ?? "").trim();
    if (id && !ids.includes(id)) {
      ids.push(id);
    }
  }

  if (ids.length) {
    return ids;
  }

  const re2 = /yt:video:([a-zA-Z0-9_-]{11})/g;
  while ((m = re2.exec(xmlText))) {
    const id = String(m[1] ?? "").trim();
    if (id && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

async function fetchRssText(url) {
  return await withRetries(
    async () => {
      const res = await fetch(url, {
        credentials: "include",
        headers: {
          accept: "application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8"
        }
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.text();
    },
    { attempts: 3, baseDelayMs: 250 }
  );
}

async function findNextUploadVideoIdViaRss({ channelId, currentVideoId }) {
  if (!channelId || !currentVideoId) {
    return null;
  }
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(
    channelId
  )}`;
  const xmlText = await fetchRssText(url);
  const ids = extractVideoIdsFromRss(xmlText);

  let prevVideoId = null;
  for (const vid of ids) {
    if (vid === currentVideoId) {
      return prevVideoId;
    }
    prevVideoId = vid;
  }
  return null;
}

function ensureUi() {
  if (ytNextUploadUi) {
    return ytNextUploadUi;
  }

  const container = document.createElement("div");
  container.id = "yt-next-upload-container";
  container.style.position = "fixed";
  container.style.right = "16px";
  container.style.bottom = "16px";
  container.style.zIndex = "2147483647";
  container.style.pointerEvents = "auto";
  container.style.display = "flex";
  container.style.flexDirection = "column";
  container.style.gap = "8px";
  container.style.alignItems = "flex-end";

  const button = document.createElement("button");
  button.type = "button";
  button.id = "yt-next-upload-button";
  button.textContent = "Next upload";
  button.style.cursor = "pointer";
  button.style.border = "1px solid rgba(255,255,255,0.25)";
  button.style.borderRadius = "999px";
  button.style.padding = "10px 14px";
  button.style.background = "rgba(0,0,0,0.72)";
  button.style.color = "white";
  button.style.fontSize = "13px";
  button.style.fontFamily =
    "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
  button.style.backdropFilter = "blur(6px)";
  button.style.boxShadow = "0 6px 18px rgba(0,0,0,0.28)";
  button.disabled = true;
  button.style.opacity = "0.55";
  button.style.cursor = "not-allowed";

  const status = document.createElement("div");
  status.id = "yt-next-upload-status";
  status.style.color = "rgba(255,255,255,0.85)";
  status.style.fontSize = "12px";
  status.style.fontFamily =
    "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif";
  status.style.background = "rgba(0,0,0,0.5)";
  status.style.border = "1px solid rgba(255,255,255,0.14)";
  status.style.borderRadius = "10px";
  status.style.padding = "6px 10px";
  status.style.maxWidth = "320px";
  status.style.whiteSpace = "nowrap";
  status.style.overflow = "hidden";
  status.style.textOverflow = "ellipsis";
  status.textContent = "Open a video to enable. If it doesn’t load, refresh once.";

  button.addEventListener("click", async () => {
    const nextVideoId = lastNextVideoId;
    if (!nextVideoId) {
      return;
    }
    const settings = await loadSettings();
    const url = buildNextVideoUrl(nextVideoId);
    if (settings.openInNewTab) {
      window.open(url, "_blank", "noopener,noreferrer");
    } else {
      window.location.href = url;
    }
  });

  container.appendChild(button);
  container.appendChild(status);

  const root = document.body || document.documentElement;
  if (root) {
    root.appendChild(container);
  } else {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        const lateRoot = document.body || document.documentElement;
        if (lateRoot && !document.getElementById(container.id)) {
          lateRoot.appendChild(container);
        }
      },
      { once: true }
    );
  }

  ytNextUploadUi = { container, button, status };
  return ytNextUploadUi;
}

function updateUiState({ nextVideoId, reason, title, detail }) {
  const ui = ensureUi();
  lastNextVideoId = nextVideoId ?? null;

  if (nextVideoId) {
    ui.button.disabled = false;
    ui.button.style.opacity = "1";
    ui.button.style.cursor = "pointer";
    const label = title ? `Next upload after: ${title}` : "Next upload ready";
    ui.status.textContent = label;
  } else {
    ui.button.disabled = true;
    ui.button.style.opacity = "0.55";
    ui.button.style.cursor = "not-allowed";
    ui.status.textContent =
      reason === "not_on_watch"
        ? "Open a video to enable. If it doesn’t load, refresh once."
        : 
      reason === "loading"
        ? "Finding next upload…"
        : reason === "waiting"
          ? "Waiting for video data…"
          : reason === "retrying"
            ? detail || "Retrying…"
            : reason === "cached"
              ? "Loaded from cache"
        : reason === "no_background_response"
          ? "Background not responding"
          : reason === "not_found"
        ? "No newer upload found"
        : reason === "missing_channel_or_video"
          ? "Missing channel/video data"
          : reason === "error"
            ? "Error finding next upload"
            : "Waiting…";
  }
}

async function runLookupForCurrentVideo() {
  const urlVideoId = getVideoIdFromLocation();
  if (!urlVideoId) {
    lastLookupOutcome = "not_on_watch";
    updateUiState({ nextVideoId: null, reason: "not_on_watch" });
    return;
  }

  const now = Date.now();
  if (urlVideoId === lastProcessedVideoId) {
    const since = now - lastLookupAtMs;
    if (lastLookupOutcome && lastLookupOutcome !== "error" && since < 15000) {
      return;
    }
    if (since < 2000) {
      return;
    }
  }

  lastProcessedVideoId = urlVideoId;
  lastLookupAtMs = now;
  lastLookupOutcome = "loading";
  const runId = ++activeRunId;

  updateUiState({ nextVideoId: null, reason: "waiting" });
  const metadata = await waitForWatchMetadata({ timeoutMs: 8000, intervalMs: 250, runId });
  if (runId !== activeRunId) {
    return;
  }

  console.log("[yt-next-upload] extracted watch metadata", metadata);

  const channelId = metadata?.channelId ?? null;
  const currentVideoId = metadata?.videoId ?? null;
  if (!channelId || !currentVideoId) {
    lastLookupOutcome = "missing_channel_or_video";
    updateUiState({
      nextVideoId: null,
      reason: "missing_channel_or_video",
      title: metadata?.title ?? null
    });
    return;
  }

  const cached = await readNextVideoCache(currentVideoId, 10 * 60 * 1000);
  if (runId !== activeRunId) {
    return;
  }
  if (cached?.nextVideoId) {
    lastLookupOutcome = "cached";
    updateUiState({
      nextVideoId: cached.nextVideoId,
      reason: "cached",
      title: metadata?.title ?? null
    });
    return;
  }

  updateUiState({ nextVideoId: null, reason: "loading", title: metadata?.title ?? null });

  let nextVideoId = null;
  let pageErrored = false;

  try {
    nextVideoId = await withRetries(
      async ({ attempt, maxAttempts }) => {
        if (runId !== activeRunId) {
          return null;
        }
        if (attempt > 1) {
          updateUiState({
            nextVideoId: null,
            reason: "retrying",
            title: metadata?.title ?? null,
            detail: `Retrying… (${attempt}/${maxAttempts})`
          });
        }
        return await findNextUploadVideoIdViaPage({ channelId, currentVideoId });
      },
      { attempts: 2, baseDelayMs: 400 }
    );
  } catch (err) {
    pageErrored = true;
    console.log("[yt-next-upload] page lookup error", String(err?.message ?? err));
  }

  if (runId !== activeRunId) {
    return;
  }

  if (nextVideoId) {
    await writeNextVideoCache(currentVideoId, nextVideoId);
    lastLookupOutcome = "found";
    updateUiState({
      nextVideoId,
      reason: "found",
      title: metadata?.title ?? null
    });
    return;
  }

  if (pageErrored) {
    try {
      nextVideoId = await findNextUploadVideoIdViaRss({ channelId, currentVideoId });
    } catch (err) {
      console.log("[yt-next-upload] rss lookup error", String(err?.message ?? err));
    }
  }

  if (runId !== activeRunId) {
    return;
  }

  if (nextVideoId) {
    await writeNextVideoCache(currentVideoId, nextVideoId);
    lastLookupOutcome = "found";
    updateUiState({
      nextVideoId,
      reason: "found",
      title: metadata?.title ?? null
    });
    return;
  }

  if (extApi?.runtime?.sendMessage) {
    try {
      const result = await extApi.runtime.sendMessage({
        type: "yt_watch_metadata",
        data: metadata
      });
      if (runId !== activeRunId) {
        return;
      }
      if (result?.nextVideoId) {
        await writeNextVideoCache(currentVideoId, result.nextVideoId);
        lastLookupOutcome = "found";
        updateUiState({
          nextVideoId: result.nextVideoId,
          reason: "found",
          title: metadata?.title ?? null
        });
        return;
      }
    } catch (err) {
      pageErrored = true;
      console.log("[yt-next-upload] background lookup error", String(err?.message ?? err));
    }
  }

  lastLookupOutcome = pageErrored ? "error" : "not_found";
  updateUiState({
    nextVideoId: null,
    reason: pageErrored ? "error" : "not_found",
    title: metadata?.title ?? null
  });
}

function scheduleRun() {
  if (lastRunTimer) {
    clearTimeout(lastRunTimer);
  }
  lastRunTimer = setTimeout(() => {
    runLookupForCurrentVideo();
  }, 250);
}

console.log("[yt-next-upload] content script loaded", window.location.href);
ensureUi();
scheduleRun();

document.addEventListener("yt-navigate-finish", scheduleRun, true);
window.addEventListener("popstate", scheduleRun, true);
setInterval(() => {
  const videoId = getVideoIdFromLocation();
  if (videoId && videoId !== lastProcessedVideoId) {
    scheduleRun();
    return;
  }
  if (!videoId && lastProcessedVideoId) {
    scheduleRun();
  }
}, 1000);
