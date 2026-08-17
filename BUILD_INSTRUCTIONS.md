# Build & Asset Mirroring Guide — Lite Monkey

How **Lite Monkey** keeps editor libraries local so Manifest V3 store policies (no remote executable JS) are met, and how release zips are built.

---

## Local libraries

Chrome Web Store and Firefox AMO prohibit fetching executable JS from CDNs at runtime.

Vendored in-tree:

- `js/libs/codemirror/` — CodeMirror 6, parsers, themes
- `js/libs/codemirror/prettier/` — Prettier + plugins
- `js/libs/dexie.mjs` — Dexie IndexedDB wrapper

---

## Re-mirroring CodeMirror / Prettier

`tools/collect-mirror-esm.js`:

1. Pulls ESM packages from `esm.sh`.
2. Recursively downloads sub-dependencies.
3. Rewrites import specifiers to relative paths.
4. Writes into `js/libs/codemirror/`.

```bash
node tools/collect-mirror-esm.js
```

---

## Packaging store zips

The root `manifest.json` is Chromium. Each zip gets its own manifest copied to `manifest.json`:

| Zip | Manifest copied in |
| :--- | :--- |
| `build/lite-monkey-chrome-v1.0.0.zip` | `manifest.chrome.json` |
| `build/lite-monkey-firefox-v1.0.0.zip` | `manifest.firefox.json` |

Also copied: `_locales`, `css`, `html`, `icons`, `js`, `README.md`, `LICENSE`.

Names starting with `-` (scratch docs such as `-AUDIT_REPORT.md`) are **not** included.

```bash
npm run build        # Linux / macOS → ./package-extensions.sh
npm run build:win    # Windows     → .\package-extensions.ps1
```

Load the **extracted zip folder**, not the git root, in Firefox.
