const extApi =
  typeof browser !== "undefined"
    ? browser
    : typeof chrome !== "undefined"
      ? chrome
      : null;
const SETTINGS_DEFAULTS = { openInNewTab: true };

function byId(id) {
  return document.getElementById(id);
}

async function loadSettings() {
  const settings = await extApi.storage.sync.get(SETTINGS_DEFAULTS);
  return { ...SETTINGS_DEFAULTS, ...settings };
}

async function saveSettings(settings) {
  await extApi.storage.sync.set(settings);
}

function showStatus(text) {
  const status = byId("status");
  status.textContent = text;
  if (text) {
    window.clearTimeout(showStatus._t);
    showStatus._t = window.setTimeout(() => {
      status.textContent = "";
    }, 1200);
  }
}

async function init() {
  if (!extApi) {
    throw new Error("Extension API unavailable");
  }
  const openInNewTab = byId("openInNewTab");
  const settings = await loadSettings();
  openInNewTab.checked = !!settings.openInNewTab;

  openInNewTab.addEventListener("change", async () => {
    await saveSettings({ openInNewTab: !!openInNewTab.checked });
    showStatus("Saved");
  });
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((err) => {
    const status = byId("status");
    status.style.color = "#b00";
    status.textContent = String(err?.message ?? err);
  });
});
