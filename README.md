# YouTube Next Upload

Single codebase, two builds:
- Firefox (Manifest V2)
- Chrome (Manifest V3)

## Build

From this folder:

```powershell
.\build.ps1 -Target firefox
.\build.ps1 -Target chrome
```

Outputs:
- `dist\firefox\`
- `dist\chrome\`

## Install (Firefox)

1) Open `about:debugging#/runtime/this-firefox`
2) Click “Load Temporary Add-on…”
3) Select `dist\firefox\manifest.json`

## Install (Chrome / Chromium)

1) Open `chrome://extensions`
2) Enable “Developer mode”
3) Click “Load unpacked”
4) Select the `dist\chrome\` folder

## Package for upload

- Chrome Web Store: zip the contents of `dist\chrome\` (manifest.json at zip root).
- AMO (Firefox): zip the contents of `dist\firefox\` (manifest.json at zip root).
