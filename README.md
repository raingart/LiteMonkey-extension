<div align="center">

# 🐵 Lite Monkey

**Lightweight Manifest V3 Userscript & UserStyle Manager**  
*Chrome, Edge, Brave, Vivaldi, and Firefox — plain JS ESM, no bundler*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-success.svg)](MANIFEST_GUIDE.md)
[![Node Test Suite](https://img.shields.io/badge/Tests-Passing-brightgreen.svg)](tests/)

</div>

---

## Features

- **Userscripts & UserStyles**: Greasemonkey/Tampermonkey-style `.user.js` plus `.user.css`. UserStyles without `@match` pick up `@-moz-document` rules automatically.
- **`@grant` enforcement**: Only APIs listed in the script header are exposed in the page and accepted by the background handler.
- **Installer**: Top-level navigations to `.user.js` open the install UI. GitHub **blob** pages are not intercepted (they are HTML); `raw.githubusercontent.com` and Greasy Fork CDNs are. Downloads must be JavaScript or `text/plain`, not `text/html`.
- **SPA re-evaluation**: History / URL changes re-run match rules and inject newly matching scripts and styles.
- **Isolation**: Isolated-world `bootstrap.js` talks to MAIN-world `gm-api-provider.js` over a per-page `pageToken` (CustomEvent uplink, not `postMessage('*')`).
- **Chrome vs Firefox**: Chrome uses a module service worker and an offscreen document for XHR/clipboard. Firefox uses an event page (`background.scripts` + `service_worker` + `"type": "module"`) and runs XHR in the worker when offscreen is unavailable.
- **Backup & Drive**: Local import/export and Google Drive `appDataFolder` sync keep `customUrls` and `sourceUrl` (site exclusions and update URLs).
- **Editor**: CodeMirror 6, Prettier, GM storage panel, URL tester that uses the same match engine as injection (including regex `@include`).

---

## Quick start

### Chrome / Chromium

Root `manifest.json` is the Chromium manifest. Load the repo folder unpacked, or a built zip:

1. `npm run build` (Linux/macOS) or `npm run build:win` (Windows), then unpack `build/lite-monkey-chrome-v1.0.0.zip`.
2. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked**.

### Firefox

Root `manifest.json` is **not** the Firefox manifest. Use the Firefox zip (it copies `manifest.firefox.json` → `manifest.json`):

1. `npm run build:win` or `npm run build`.
2. Unpack `build/lite-monkey-firefox-v1.0.0.zip`.
3. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → select that folder’s `manifest.json`.

Temporary add-ons are cleared when Firefox restarts.

---

## Developer setup & tests

```bash
npm test
```

That runs `node --test tests/*.test.js` (ESM, no extra test runner). Coverage includes metadata parsing, match/`@include` rules, `@grant` allow-lists, origin/`@connect`/cookie host checks, installer DNR regex, script Content-Type allowlist, backup field mapping, and UserStyle `@-moz-document` inference.

### Packaging

```bash
npm run build        # Linux / macOS → ./package-extensions.sh
npm run build:win    # Windows     → .\package-extensions.ps1
```

Output:

- `build/lite-monkey-chrome-v1.0.0.zip`
- `build/lite-monkey-firefox-v1.0.0.zip`

---

## Architecture & guides

- [Project & Architecture Map](PROJECT_MAP.md)
- [Manifest V3 & Cross-Browser Guide](MANIFEST_GUIDE.md)
- [Build & Asset Mirroring Guide](BUILD_INSTRUCTIONS.md)
- [Test Userscripts](tests/test-scripts/)

---

## License

[MIT](LICENSE).
