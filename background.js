let lastWatchMetadata = null;

console.log("[yt-next-upload] background ready");

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

function findFirstStringInText(text, regex) {
  const m = text.match(regex);
  if (!m) return null;
  return m[1] ? String(m[1]) : null;
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
  const anchors = [
    "var ytInitialData =",
    "window[\"ytInitialData\"] =",
    "ytInitialData ="
  ];

  for (const anchor of anchors) {
    const obj = extractJsonObjectFromText(html, anchor);
    if (obj) return obj;
  }
  return null;
}

async function fetchText(url) {
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
}

async function postJson(url, body, { ytCfg, referer } = {}) {
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
    ...(referer ? { referrer: referer, referrerPolicy: "origin-when-cross-origin" } : null),
    credentials: "include"
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.json();
}

async function findNextUploadVideoId({ channelId, currentVideoId, maxPages = 20 }) {
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
      {
      context: ytCfg.context,
      continuation: token
      },
      { ytCfg, referer: channelVideosUrl }
    );

    const continuationItems = extractContinuationItemsFromBrowseResponse(responseJson);
    if (!continuationItems.length) {
      return null;
    }

    items = continuationItems;
  }

  return null;
}

browser.runtime.onMessage.addListener(async (message) => {
  if (!message || message.type !== "yt_watch_metadata") {
    return;
  }

  lastWatchMetadata = message.data ?? null;
  console.log("[yt-next-upload] watch metadata", lastWatchMetadata);

  const channelId = lastWatchMetadata?.channelId;
  const currentVideoId = lastWatchMetadata?.videoId;
  if (!channelId || !currentVideoId) {
    console.log("[yt-next-upload] missing channelId or videoId; skipping next upload lookup");
    return { nextVideoId: null, reason: "missing_channel_or_video" };
  }

  try {
    const nextVideoId = await findNextUploadVideoId({ channelId, currentVideoId });
    console.log("[yt-next-upload] next upload result", { currentVideoId, nextVideoId, channelId });
    return { nextVideoId: nextVideoId ?? null, reason: nextVideoId ? "found" : "not_found" };
  } catch (err) {
    const message = String(err?.message ?? err);
    console.log("[yt-next-upload] next upload error", message);
    return { nextVideoId: null, reason: "error", error: message };
  }
});
