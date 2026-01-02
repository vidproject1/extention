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

const metadata = extractWatchMetadata();
console.log("[yt-next-upload] extracted watch metadata", metadata);

browser.runtime
  .sendMessage({ type: "yt_watch_metadata", data: metadata })
  .then((result) => {
    if (result === undefined) {
      console.log("[yt-next-upload] next upload result", {
        nextVideoId: null,
        reason: "no_background_response"
      });
      return;
    }
    console.log("[yt-next-upload] next upload result", result);
  })
  .catch((err) => {
    console.log("[yt-next-upload] next upload error", String(err?.message ?? err));
  });
