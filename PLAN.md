# Firefox Extension Plan: “Next Upload” for YouTube

## 1) Goal
When a user is watching a YouTube video, provide a small on-page control that finds and opens the *very next video uploaded after the current one* on the same channel (chronological next/newer neighbor). Optionally, show a short list of upcoming “next uploads”.

## 2) Non-goals (for MVP)
- Do not attempt to infer “Part 2” via titles, playlists, or topic similarity.
- Do not change YouTube’s autoplay system.
- Do not require user login or OAuth for MVP.
- Do not support non-YouTube sites.

## 3) User Experience (MVP)
- On `https://www.youtube.com/watch?v=...`, show an unobtrusive overlay button (top-right by default):
  - Label: “Next upload”
  - States: loading, ready, not found (e.g., current is latest), error (fallbacks attempted)
- Click navigates to the next upload’s watch URL.
- Optional: a small expandable list (next 3–10 uploads) with titles + dates.

## 4) Data & Identification Requirements
From the current watch page, we need:
- `videoId` (current video)
- channel identity (prefer `channelId`; otherwise canonical channel URL / handle)
- publish time/date for the current video (prefer an exact timestamp if available)

From the channel, we need:
- a sequence of uploads with `(videoId, publish time/date)` in upload order

## 5) Proposed Implementations (Scrape-first)

### Method A (Preferred): Parse watch-page JSON + channel uploads listing via “Videos/Uploads”
**Idea**
1) Extract `channelId` and current publish timestamp from watch page data blobs.
2) Fetch the channel’s videos feed (uploads) and parse items + publish times.
3) Compute the “next upload” (closest newer upload than current).

**Why this is preferred**
- No API key.
- Works for most channels.
- Keeps the extension self-contained.

**Typical sources to parse (subject to change by YouTube)**
- Watch page embedded JSON blobs (commonly `ytInitialData` and/or `ytInitialPlayerResponse`).
- Channel videos page HTML (which contains an initial data JSON + continuation tokens).

**Contingencies if a field is missing**
- If publish timestamp is missing on watch page: try player “microformat” fields; if only a date is available, treat it as day-level and use a tie-breaker strategy.
- If channelId is missing: use channel URL / handle from the watch page and resolve to channelId by fetching the channel page once.

### Method B: Use uploads playlist (“UU…”) and playlist browsing
**Idea**
- Many channels map to an “uploads playlist” id derived from channel id (commonly `UU` + channelId without leading `UC`).
- Fetch the uploads playlist view and parse items in order; find neighbor.

**Pros**
- Playlist ordering can be stable and directly represents uploads.

**Cons**
- Still relies on YouTube page formats and/or internal browse endpoints.
- Some edge cases (Shorts, live, mixed tabs) may complicate list composition.

### Method C (Fallback): Channel RSS feed for “recent next”
**Idea**
- Fetch `https://www.youtube.com/feeds/videos.xml?channel_id=...` and parse entries.

**Pros**
- Very stable format.

**Cons**
- Usually limited to a recent window (often ~15 items); won’t find the next upload for older videos unless that “next” is still in the feed.

### Method D (Optional Reliability Mode): YouTube Data API v3 (user-provided key)
**Idea**
- Allow users to paste their own API key in extension settings; use official endpoints to fetch channel uploads and publish dates.

**Pros**
- Most stable long-term.

**Cons**
- Onboarding friction; key management; quota concerns.

## 6) “Next Upload” Selection Algorithm
We want the upload that is:
- on the same channel
- strictly newer than the current video’s publish time
- and the *closest* newer upload (immediate next chronologically)

If we can obtain an ordered list of uploads in descending order (newest → oldest):
- Iterate from newest to oldest, tracking the last-seen item as `candidateNewer`.
- When we encounter an item whose publish time is `<= currentPublishTime`, return `candidateNewer`.
- If we never hit `<= currentPublishTime`, then the current video is newer than everything we fetched (or missing from the list); treat as “not found” and fall back to neighbor-by-id if possible.

Tie-breakers (same date/time granularity):
- Prefer exact timestamp when available.
- If only day-level dates are available, treat same-day as ambiguous:
  - If current video appears in the list, choose the adjacent item immediately newer by list position.
  - Otherwise, return “not found” or expand fetch window.

## 7) SPA Navigation & Trigger Points (YouTube-specific)
YouTube changes videos without full page reload. The extension should:
- Detect navigation to a new watch page and re-run extraction.
- Debounce repeated updates while the page is still loading.
- Re-render or update overlay state appropriately.

## 8) Caching Strategy
- Cache per channel:
  - last fetch time
  - parsed upload list segment(s)
  - continuation tokens (if used)
- Cache current-video lookup results (videoId → nextVideoId) for a short TTL.
- Invalidate cache on errors or schema mismatch.

## 9) Permissions & Privacy
- Minimum host permissions: `https://www.youtube.com/*` (and optionally `https://m.youtube.com/*`).
- Do not collect or transmit personal data.
- Keep all computation local.
- Avoid storing watch history beyond small, short-lived cache entries needed for function.

## 10) Testing Plan

### A) Parser Unit Tests (recommended)
Goal: ensure the “extract channelId/publish time” and “parse uploads list” logic stays correct.
- Store small fixture inputs (sanitized HTML/JSON snippets captured from YouTube pages).
- Tests validate:
  - channelId extraction from watch page
  - publish timestamp extraction
  - uploads list parsing (videoId + publish time)
  - “next upload” selection algorithm across edge cases

### B) Manual Browser Tests (MVP gate)
Install temporarily via Firefox’s temporary add-on workflow and test:
- Standard watch pages on multiple channels
- Very old videos (years back)
- Channels with frequent uploads (dense timelines)
- Shorts-heavy channels
- Live/premiere videos
- Logged-in and logged-out sessions

Acceptance checks:
- Button appears on watch pages and not elsewhere (or is safely hidden).
- Clicking “Next upload” opens the correct next upload (spot-check 10–20 examples).
- Handles “current is latest” case cleanly.

### C) Regression Checklist (before release)
- Confirm no console spam or performance regressions on YouTube.
- Confirm UI positioning doesn’t block native controls.
- Confirm caching reduces repeated requests when navigating within same channel.

## 11) Contingencies (if scraping breaks)
If a YouTube change breaks Method A:
1) Switch to Method B parsing (uploads playlist based).
2) Fall back to Method C RSS when it can answer the question.
3) Offer Method D (user key) as an opt-in stable alternative.

Operational contingencies:
- If publish time extraction fails: attempt neighbor-by-position (find current video in uploads list).
- If current video can’t be found (unlisted/members-only): show “Not available for this video” and allow “Open channel uploads” as a secondary action.

## 12) Milestones
1) MVP button + next-upload navigation on most watch pages (Method A).
2) Add robust SPA navigation handling + caching.
3) Add list UI (next 3–10) and options (include Shorts/live).
4) Add fallback modes (RSS, uploads playlist) and clear error messaging.

