<div align="center">

# 🐵 Lite Monkey

**Lightweight, High-Performance Manifest V3 Userscript & UserStyle Manager**  
*Built for Chromium (Chrome, Edge, Brave, Vivaldi) & Mozilla Firefox*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-success.svg)](MANIFEST_GUIDE.md)
[![Node Test Suite](https://img.shields.io/badge/Tests-Passing-brightgreen.svg)](tests/)

</div>

---

## ✨ Features

- ⚡ **Manifest V3 Native Performance**: Strict non-blocking Service Worker architecture with DeclarativeNetRequest navigation interception.
- 🎨 **CodeMirror 6 Editor & UserStyles**: Built-in syntax highlighting, live formatting with Prettier, and full `@-moz-document` UserStyle support.
- 🔒 **Security First**: Cryptographic `pageToken` isolation preventing host page spoofing or event hijacking of privileged `GM_*` APIs.
- ☁️ **Google Drive Backup Sync**: Seamless `appDataFolder` cloud synchronization for scripts and GM storage data.
- 🌐 **Cross-Browser Core**: Fully compliant with Chrome Web Store and Firefox AMO submission standards.
- 🧪 **Automated Testing Suite**: Native zero-dependency unit and integration test suite covering pattern matching, metadata parsing, versioning, and rules evaluation.

---

## 🚀 Quick Start & Installation

### Option 1: Chrome / Chromium Browsers
1. Download `lite-monkey-chrome-v1.0.0.zip` from [Releases](../../releases) or run `./package-extensions.sh`.
2. Open `chrome://extensions` in your browser.
3. Enable **Developer mode** in the top-right toggle.
4. Drag and drop the extracted extension folder or click **Load unpacked**.

### Option 2: Mozilla Firefox
1. Download `lite-monkey-firefox-v1.0.0.zip` from [Releases](../../releases).
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Click **Load Temporary Add-on...** and select `manifest.json`.

---

## 🛠️ Developer Setup & Testing

### Running Tests
Execute the native Node.js ESM test suite:
```bash
npm test
```

### Packaging Store Releases
Generate clean, distribution-ready release ZIP packages for Chromium and Firefox:

**Linux / macOS (Bash)**:
```bash
npm run build        # or ./package-extensions.sh
```

**Windows (PowerShell)**:
```powershell
npm run build:win    # or .\package-extensions.ps1
```

Build archives will be generated in `./build/`:
- `build/lite-monkey-chrome-v1.0.0.zip`
- `build/lite-monkey-firefox-v1.0.0.zip`

---

## 📖 Architecture & Guides

- 🗺️ [Project & Architecture Map](PROJECT_MAP.md)
- 📋 [Comprehensive Code Audit & QA Report](AUDIT_REPORT.md)
- 📜 [Manifest V3 & Cross-Browser Guide](MANIFEST_GUIDE.md)
- 🛠️ [Build & Asset Mirroring Guide](BUILD_INSTRUCTIONS.md)
- 🧪 [Test Userscripts Collection](tests/test-scripts/)

---

## ⚖️ License

Distributed under the [MIT License](LICENSE). Made with ❤️ for the open-source community.
