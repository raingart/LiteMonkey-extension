# Privacy Policy for Lite Monkey

**Effective Date**: August 14, 2026

**Lite Monkey** ("we", "our", or "us") is committed to protecting your privacy. This Privacy Policy explains our data practices regarding the **Lite Monkey** browser extension for Google Chrome, Mozilla Firefox, and Chromium-based browsers.

---

## 1. Zero Data Collection

**Lite Monkey does NOT collect, store, transmit, or monitor any personal data or web history on our servers.** There is no Lite Monkey backend.

- We do NOT collect personally identifiable information (name, email address, IP address).
- We do NOT send your browsing history, visited URLs, or website content to us or to advertisers.
- We do NOT use analytics, telemetry, tracking pixels, or third-party advertising scripts.
- We do NOT sell, rent, or transfer any user data to third parties.

The extension **reads page URLs locally** so it can match `@match` / `@include` rules, update the toolbar badge, and show the popup list. Those URLs stay in the browser (memory, IndexedDB, or `chrome.storage`) unless **you** export a backup or enable Google Drive sync.

---

## 2. Local Execution & Storage

- **Scripts and GM storage**: Installed userscripts/userstyles and `GM_setValue` data are stored in IndexedDB on your device (Dexie). Settings use `chrome.storage.sync` / `local`. Session logs and page tokens use `chrome.storage.session` (with a local fallback).
- **Google Drive backup (optional)**: If you turn it on, backup payloads (script source, GM storage, `customUrls`, `sourceUrl`) go **directly** from the extension to your Google Drive `appDataFolder` via Google OAuth2. We do not run a proxy.

---

## 3. Browser Permissions

Required for the manager to run:

- **`scripting`** (and **`userScripts`** on Chrome): run user-installed scripts/styles on sites allowed by their headers and by the host permissions you grant.
- **`declarativeNetRequest`**: intercept `.user.js` downloads and open the installer (GitHub blob HTML pages are not intercepted).
- **`storage`**: local settings, tokens, logs.
- **`alarms`**: scheduled update checks you configured.
- **`cookies`**: `GM_cookie` for scripts that `@grant` it. Cookie access is limited to the executing page’s origin (no cross-site cookie dump).
- **`activeTab`**: read the current tab URL when you open the popup.
- **`offscreen`** (Chrome only): `GM_xmlhttpRequest` / clipboard helpers that a service worker cannot run.
- **`tabs`**: required on Firefox; optional on Chrome for `GM_getTab` / `GM_getTabs` / `GM_closeTab`.

Requested only when a script or feature needs them:

- **`notifications`**: `GM_notification`
- **`downloads`**: `GM_download`
- **`clipboardWrite`**: `GM_setClipboard`
- **`identity`**: Google Drive sync
- **`<all_urls>`** (optional host permission): only after you confirm, when a script’s `@match` / `@include` needs origins not already granted

`@grant none` scripts do not get XHR, cookies, downloads, or tabs APIs.

---

## 4. Single Purpose

Lite Monkey’s sole purpose is to manage and run user-installed JavaScript userscripts and CSS userstyles on your device.

---

## 5. Contact & Open Source

Lite Monkey is open-source software licensed under the MIT License. Review the source in this repository.

Questions about this policy: open an issue on the project’s GitHub repository.
