# Lite Monkey — Project & Architecture Map

Functional map of the codebase: tiers, security, files, and why they exist.

---

## High-level architecture

Four tiers. Chrome background is a module **service worker**; Firefox is an **event page** (`background.scripts` + `service_worker` + `"type": "module"`). Offscreen exists only on Chrome.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        MAIN WORLD (Page Context)                       │
│  - gm-api-provider.js (GM_* / GM.* filtered by @grant)                 │
│  - log-wrapper.js (console + errors; CustomEvent uplink)               │
└──────────────────────────────────▲─────────────────────────────────────┘
                                   │ CustomEvent (pageToken)
┌──────────────────────────────────▼─────────────────────────────────────┐
│                      ISOLATED WORLD (Content Script)                   │
│  - bootstrap.js (IPC bridge, pageToken, SPA re-eval)                   │
└──────────────────────────────────▲─────────────────────────────────────┘
                                   │ chrome.runtime IPC
┌──────────────────────────────────▼─────────────────────────────────────┐
│                   BACKGROUND (SW on Chrome / event page on Firefox)    │
│  - main.js · core/ · services/                                         │
└──────────────────────────────────▲─────────────────────────────────────┘
                                   │ Offscreen IPC (Chrome only)
┌──────────────────────────────────▼─────────────────────────────────────┐
│                    OFFSCREEN DOCUMENT (offscreen.html)                  │
│  - GM_xmlhttpRequest / clipboard; Firefox uses gm-xhr.js in-worker     │
└────────────────────────────────────────────────────────────────────────┘
```

---

## File map

### Root & manifests

- **`manifest.json`**: Chromium unpacked / local testing (same shape as Chrome store).
- **`manifest.chrome.json`**: Chrome zip (`service_worker` only).
- **`manifest.firefox.json`**: Firefox zip (event page + SW key + `type: module`). Load this zip, not the repo root, in Firefox.
- **`package-extensions.sh`** / **`package-extensions.ps1`**: Dual-target zips into `build/`. Names starting with `-` are omitted.
- **`package.json`**: `"type": "module"`, `npm test` → `node --test tests/*.test.js`.

### Core (`js/`)

- **`js/bootstrap.js`**: Isolated-world content script. Validates `pageToken`, proxies GM calls, re-requests scripts on SPA URL changes (`EVENT_REEVALUATE_TAB_SCRIPTS`). Forwards handshake on `postMessage`; logs use `litemonkey-up-${token}` CustomEvents.
- **`js/gm-api-provider.js`**: Stringified into the page. Exposes only APIs allowed by `@grant` (`js/gm-grants.js`).
- **`js/gm-grants.js`**: Grant → API surface and background `gm-*` message allow-list. Enforced in the injector and `MessageRouter`.
- **`js/database.js`**: Dexie wrapper (`scripts` metadata, `scriptCodes`, GM storage). Persists `sourceUrl` / `customUrls`.
- **`js/constants.js`**: Trusted installer hosts, default settings, restricted URLs, script Content-Type allowlist (`isAllowedScriptContentType`).
- **`js/message-types.js`**: IPC `MSG` enum.
- **`js/theme-applier.js`**: Dark / light / auto on options, popup, installer.

### Shared libs (`js/libs/`)

- **`match-pattern.js`**: Chrome/GM match patterns → regex and host permissions.
- **`match-rule.js`**: `@match` / `@include` / `@exclude` (wildcards and `/regex/` literals) — same engine for injection and the editor URL tester.
- **`userstyle-rules.js`**: Infers `@match` from `@-moz-document` when a UserStyle has no header matches.
- **`origin-guard.js`**: Cookie domain suffix checks, `@connect` host equality (`self` / same-origin = frame host, not tab URL), popup exclude-by-hostname.
- **`meta-parser.js`**: Userscript / UserStyle headers. Header search is capped to the first 32 KB (ignores GitHub HTML wrappers).
- **`gm-xhr.js`**: `GM_xmlhttpRequest` implementation used by offscreen (Chrome) and the background worker (Firefox).
- **`browser-support.js`**, **`localization.js`**, **`logger.js`**, **`message-service.js`**, **`error-collector.js`**.

### Background (`js/background/`)

- **`main.js`**: Tiered init (logging → lifecycle → router → interceptor → API → cache → styles → badges → scheduler).
- **`log-wrapper.js`**: Page-world console wrapper; uplink is a token-scoped CustomEvent, not `postMessage('*')`.
- **`utils.js`**: `@require` CacheStorage fetch (strict Content-Type), `getEffectiveRules`, `handlePermissionCheck`, `buildUserScriptConfig`.

#### `js/background/core/`

- **`app-lifecycle.js`**: `onInstalled` / `onStartup`.
- **`lock-manager.js`**: Web Locks around Dexie mutations.
- **`message-router.js`**: Dispatcher; `pageToken` check; `@grant` check on `gm-*`.

#### `js/background/services/`

- **`script-registry.js`**: CRUD, `injectImmediately` / `runAt`, SPA re-eval.
- **`gm-api-handler.js`**: Storage, cookies, notification, download, openInTab (http(s) only), offscreen or in-worker XHR.
- **`cache-manager.js`**: RAM map; Dexie refresh failure keeps the previous map.
- **`gdrive-service.js`**: OAuth + `appDataFolder`; import/export includes `customUrls` / `sourceUrl`.
- **`userscript-interceptor.js`**: DNR `.user.js` → installer; excludes `github.com` (blob HTML), `gitlab.com`, `pastebin.com`.
- **`badge-manager.js`**: Toolbar badge (works when `tab.url` is hidden via `activeTab`).
- **`style-injector.js`**: UserStyles, including subframes and URL-change updates.
- **`update-scheduler.js`** / **`update-service.js`**: `@updateURL` / `@downloadURL` / `sourceUrl`; same Content-Type allowlist as `@require`.
- **`log-manager.js`**: Session logs, rate limit, debounce.

### UI

- **`html/options.html`**, **`js/pages/options.js`**, **`js/pages/options/`**: Manager, editor (`script-editor-manager.js` — storage hydrate flag, URL tester via `evaluateUrlRules`), list, settings, import/export.
- **`html/popup.html`**, **`js/pages/popup.js`**: Per-tab toggles, exclude (hostname, not substring), logs, menu commands.
- **`html/installer.html`**, **`js/pages/installer.js`**: Fetch + Content-Type check + metadata; not framed.
- **`html/offscreen.html`**, **`js/pages/offscreen.js`**: Chrome-only XHR / clipboard.

### Tests (`tests/`)

`npm test` → `node --test tests/*.test.js`.

| File | What it covers |
| :--- | :--- |
| `e2e-extension.test.js` | Manifest JSON, file presence, ESM imports, Firefox `scripts === [service_worker]`, i18n placeholders |
| `gm-grants.test.js` | Page-world and background `@grant` allow-lists |
| `origin-guard.test.js` | Cookie hosts, `@connect self`, exclude hostname |
| `content-type.test.js` | Script media types (`text/html` rejected) |
| `match-rule.test.js` | Regex `@include` / `@exclude` (editor = injection) |
| `userstyle-rules.test.js` | `@-moz-document` → match patterns |
| `interceptor.test.js` | DNR `.user.js` regex; `github.com` excluded |
| `meta-parser.test.js` | Headers; 32 KB search cap |
| `backup-import.test.js` | JSON / `.user.js` / `.user.css` import |
| `match-pattern.test.js` | Wildcards, `<all_urls>`, host permissions |
| `utils-rules.test.js` | `getEffectiveRules` / `isRunnableOnUrl` |
| `permissions-sync.test.js` | `@grant` → browser permissions |
| `update-service.test.js` | `compareSemanticVersions` |
| `dom-utils.test.js` | `escapeHTML`, `sanitizeSafeUrl` |
| `logger.test.js` | Log levels |
| `test-scripts/` | Five sandbox userscripts / one userstyle |

---

## Why these choices

1. **Plain ESM, no bundler** — the code that runs is the code in the tree.
2. **`pageToken` + CustomEvent** — the page cannot spoof GM calls or read the log uplink with `postMessage`.
3. **Offscreen on Chrome only** — SW has no DOM/XHR; Firefox has no offscreen, so `gm-xhr.js` runs in the event page.
4. **Dexie for script bodies** — large strings and transactions without `chrome.storage` quotas.
5. **`@grant` in two places** — hiding functions in MAIN world is not enough; the router still rejects ungranted `gm-*` messages.
6. **Pause, cookies-required, no `userScripts.register`, Firefox implicit OAuth, isolated `import(blob)`/`eval`** — intentional MV3 / product limits, not unfinished bugs. Reasons: [MANIFEST_GUIDE.md](MANIFEST_GUIDE.md#intentional-limitations).
