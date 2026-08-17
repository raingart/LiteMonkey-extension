# Manifest V3 Configuration & Cross-Browser Guide — Lite Monkey

Breakdown of the Manifest V3 configurations used in **Lite Monkey** for **Chromium** (Chrome, Edge, Brave, Vivaldi) and **Mozilla Firefox**.

---

## Manifest files

| File | Purpose | Browser |
| :--- | :--- | :--- |
| **`manifest.json`** | Root manifest for local Chromium unpacked loads. Same shape as the Chrome store build. | Chromium |
| **`manifest.chrome.json`** | Copied to `manifest.json` inside the Chrome zip. Service worker only (Chrome &lt;121 rejects `background.scripts`). | Chrome / Chromium |
| **`manifest.firefox.json`** | Copied to `manifest.json` inside the Firefox zip. Do **not** load the repo root in Firefox — that file is the Chrome manifest. | Firefox (Gecko) |

Packaging: `npm run build` / `npm run build:win` (`package-extensions.sh` / `package-extensions.ps1`). Files whose names start with `-` are stripped from zips.

---

## Permissions

### Required (`permissions`)

- **`activeTab`**: Temporary `tab.url` when the user opens the popup (badge / per-site list).
- **`scripting`**: `executeScript` / `insertCSS`. Primary injection path in Firefox; fallback in Chrome.
- **`userScripts`** *(Chrome only)*: Isolated-world execution via `userScripts.execute`. Not in the Firefox manifest.
- **`declarativeNetRequest`**: Redirects main-frame navigations to `.user.js` URLs into `html/installer.html`. `github.com` is in `excludedRequestDomains` (blob pages are HTML). `raw.githubusercontent.com` is still intercepted.
- **`offscreen`** *(Chrome only)*: Hidden document for `GM_xmlhttpRequest` binary payloads and `execCommand('copy')`. Firefox has no `offscreen`; those APIs run in the background worker via `js/libs/gm-xhr.js`.
- **`storage`**: Settings (`sync`), logs/tokens (`session`, with `local` fallback).
- **`alarms`**: Periodic userscript update checks.
- **`cookies`**: `GM_cookie`. Always required (not optional).
- **`tabs`** *(Firefox required, Chrome optional)*: Firefox needs it for tab URL / injection bookkeeping. Chrome requests it at runtime for `GM_getTab` / `GM_getTabs` / `GM_closeTab`.

### Optional (`optional_permissions`)

- **`notifications`**: `GM_notification`.
- **`downloads`**: `GM_download`.
- **`clipboardWrite`**: `GM_setClipboard`.
- **`tabs`**: Chrome only (see above).
- **`identity`**: Google Drive `appDataFolder` sync.

### Host permissions

Install-time `host_permissions` cover installer / update CDNs, not the whole web:

- `greasyfork.org`, `update.greasyfork.org`
- `sleazyfork.org`, `update.sleazyfork.org`
- `openuserjs.org`
- `github.com`, `raw.githubusercontent.com`, `gist.githubusercontent.com`
- `www.userscript.zone`

`optional_host_permissions`: `<all_urls>` — requested when a script’s `@match` / `@include` needs origins the user has not granted yet.

`@grant` is **not** a manifest permission. Page-world APIs and background `gm-*` messages are filtered in `js/gm-grants.js`.

---

## Firefox vs Chrome

1. **Background**
   - Chrome: `"background": { "service_worker": "js/background/main.js", "type": "module" }`.
   - Firefox: both `"scripts": ["js/background/main.js"]` and `"service_worker": "js/background/main.js"` plus `"type": "module"`. Firefox uses the event page (`scripts`); Chrome ignores `scripts` on 121+ and would reject it on older Chrome, which is why the Chrome manifest stays SW-only.

2. **Gecko ID** (`manifest.firefox.json`):
   ```json
   "browser_specific_settings": {
      "gecko": {
         "id": "raingart@protonmail.com",
         "strict_min_version": "121.0"
      }
   }
   ```

3. **OAuth**
   - Chrome: `chrome.identity.getAuthToken`.
   - Firefox: `browser.identity.launchWebAuthFlow` (implicit `response_type=token`; see below).

4. **Injection**
   - Chrome prefers `userScripts.execute` + `injectImmediately` (approximate `document-start`). `userScripts.register` is not used; see below.
   - Firefox uses `scripting.executeScript`.

---

## Intentional limitations

These are product / MV3 constraints, not leftover bugs. Do not “fix” them without changing the product.

| Choice | Why it stays |
| :--- | :--- |
| **No `userScripts.register`** | That API is persistent, Chrome-only, and a different injection model. Current path is `userScripts.execute` (Chrome) / `scripting.executeScript` (Firefox) with `injectImmediately`. A service-worker wake race vs true `document-start` remains until register is the product. |
| **`cookies` is required** | Moving it to `optional_permissions` would make `GM_cookie` fail until a separate prompt. Store review friction is accepted so cookie scripts work after install. |
| **Firefox Drive uses `response_type=token`** | Chrome uses `getAuthToken`. Firefox has no equivalent, so Drive uses implicit `launchWebAuthFlow`. Authorization-code / PKCE is a separate OAuth rewrite, not a sync bug. |
| **Isolated world: `import(blob)` then `eval`** | MAIN-world scripts are a `<script>` tag (Trusted Types / blob fallback). Isolated world has no DOM script node, so the injected function uses dynamic `import` of a blob URL and `(0, eval)` if CSP blocks the import. That is the isolated-world ceiling, not a grant bypass. |
| **Pause is load-time only** | Pause stops *new* injections (scripts, styles, SPA re-eval). Scripts already running in the page are not torn down. It is not a live kill switch. |
