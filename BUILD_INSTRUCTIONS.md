# 🛠️ Build & Asset Mirroring Guide — Lite Monkey

This guide explains how **Lite Monkey** manages its local dependencies (CodeMirror 6, Prettier, Dexie.js) to adhere to strict Manifest V3 offline execution standards.

---

## 🏛️ Dependency Mirroring Philosophy

Chrome Web Store and Firefox AMO policies for Manifest V3 extensions **prohibit remote code execution** (fetching executable JS libraries at runtime from CDNs like `unpkg.com` or `esm.sh`).

All editor libraries used by Lite Monkey are bundled locally within the extension:
- `js/libs/codemirror/`: CodeMirror 6 core modules, syntax parsers, and themes.
- `js/libs/codemirror/prettier/`: Prettier code formatting engine and plugins.
- `js/libs/dexie.mjs`: Dexie.js IndexedDB wrapper.

---

## 🔄 Re-generating or Updating Local Dependencies

The repository includes a dedicated ESM dependency mirroring script located at `tools/collect-mirror-esm.js`.

### How `collect-mirror-esm.js` Works:
1. Queries target ES module packages from `esm.sh`.
2. Recursively resolves and downloads all sub-dependencies (`@lezer/common`, `style-mod`, etc.).
3. Rewrites `import` / `export` specifiers into relative local paths (`./state.js`).
4. Saves output into `js/libs/codemirror/`.

### Running the Mirror Script
To re-mirror or update CodeMirror and Prettier dependencies:

```bash
# Execute via Node.js
node tools/collect-mirror-esm.js
```

---

## 📦 Extension Packaging

To build clean, store-ready ZIP packages:
```bash
./package-extensions.sh
```
Outputs:
- `build/lite-monkey-chrome-v1.0.0.zip`
- `build/lite-monkey-firefox-v1.0.0.zip`
