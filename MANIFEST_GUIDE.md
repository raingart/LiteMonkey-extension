# 📜 Manifest V3 Configuration & Cross-Browser Guide — Lite Monkey

This document provides a comprehensive breakdown of the Manifest V3 configurations used in **Lite Monkey** for **Chromium** (Chrome, Edge, Brave, Vivaldi) and **Mozilla Firefox**.

---

## 📂 Manifest Files Overview

| File | Purpose | Browser Target |
| :--- | :--- | :--- |
| **`manifest.json`** | Active root manifest used for local development, unpacked testing, and Chrome builds. | Chromium |
| **`manifest.chrome.json`** | Dedicated, release-ready Chrome MV3 manifest. | Google Chrome / Chromium |
| **`manifest.firefox.json`** | Dedicated, release-ready Firefox WebExtensions MV3 manifest. | Mozilla Firefox (Gecko) |

---

## 🔑 Permissions & Architecture Breakdown

### 1. Core Permissions (`permissions`)

- **`activeTab`**: Grants temporary active tab metadata access (such as `tab.url`) when the user opens the browser action popup. Enables active tab script status calculation without requiring unprompted broad host permissions.
- **`scripting`**: Required by Manifest V3 to inject content scripts and CSS programmatically into web pages (`browser.scripting.executeScript`, `browser.scripting.insertCSS`). Primary injection path in Firefox and fallback in Chrome.
- **`userScripts`** *(Chrome only)*: Primary Chromium API for registering and executing userscripts in isolated worlds. Provides native performance and context isolation.
- **`declarativeNetRequest`**: Used by `UserScriptInterceptor` to intercept main frame navigations to `.user.js` URLs and redirect them to `html/installer.html`. Eliminates background Service Worker wake-up overhead.
- **`offscreen`** *(Chrome only)*: Creates a hidden offscreen DOM document to execute APIs unavailable in Service Workers (`GM_xmlhttpRequest` binary payloads and `execCommand('copy')` fallback).
- **`storage`**: Used for `browser.storage.sync` (extension settings), `browser.storage.local`, and `browser.storage.session` (session logs and active script tokens).
- **`alarms`**: Used by `UpdateScheduler` to schedule background userscript update checks.
- **`cookies`**: Powers the Greasemonkey `GM_cookie` API (list, set, delete cookies).

---

### 2. Optional Permissions (`optional_permissions`)

- **`notifications`**: Requested at runtime when a userscript invokes `GM_notification`.
- **`downloads`**: Requested at runtime when a userscript invokes `GM_download`.
- **`clipboardWrite`**: Requested at runtime when a userscript invokes `GM_setClipboard`.
- **`tabs`**: Requested at runtime for `GM_getTab`, `GM_getTabs`, and `GM_closeTab`.
- **`identity`**: Requested at runtime when the user enables Google Drive cloud synchronization (`GDriveService`).

---

### 3. Host Permissions & Scope

- **`host_permissions`**: Minimal set of trusted installer source domains (`greasyfork.org`, `sleazyfork.org`, `openuserjs.org`, `github.com`, `userscript.zone`) granted at install time for navigation interception.
- **`optional_host_permissions` (`<all_urls>`)**: Broad web access is optional. Requested dynamically at runtime when a script requires execution on specific target host domains.

---

## 🦊 Firefox vs. Chrome Differences

1. **Background Service Worker**:
   - Chrome requires `"background": { "service_worker": "js/background/main.js", "type": "module" }`.
   - Firefox WebExtensions MV3 supports background service workers starting in Firefox 115+.

2. **Firefox Extension ID (`browser_specific_settings`)**:
   - Firefox requires an explicit add-on ID in `manifest.firefox.json`:
     ```json
     "browser_specific_settings": {
        "gecko": {
           "id": "raingart@protonmail.com",
           "strict_min_version": "113.0"
        }
     }
     ```

3. **OAuth2 Identity Flow**:
   - Chrome uses native `chrome.identity.getAuthToken`.
   - Firefox uses `browser.identity.launchWebAuthFlow` against Google OAuth2 authorization endpoints.
