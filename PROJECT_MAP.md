# 🗺️ Lite Monkey — Project & Architecture Map

This document provides a transparent, functional map of the **Lite Monkey** codebase. It outlines the architectural tiers, security design decisions, file structure, and technical rationale behind each component.

---

## 🏛️ High-Level Architecture Overview

Lite Monkey is built on a 4-Tier Manifest V3 architecture designed for zero memory leaks, fast startup time, and strict main-world security isolation.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        MAIN WORLD (Page Context)                       │
│  - gm-api-provider.js (Exposes GM_*, GM.* APIs)                       │
│  - log-wrapper.js (Shadows console & intercepts uncaught errors)       │
└──────────────────────────────────▲─────────────────────────────────────┘
                                   │ CustomEvent (pageToken)
┌──────────────────────────────────▼─────────────────────────────────────┐
│                      ISOLATED WORLD (Content Script)                   │
│  - bootstrap.js (Secure IPC bridge, pageToken authentication)          │
└──────────────────────────────────▲─────────────────────────────────────┘
                                   │ chrome.runtime IPC
┌──────────────────────────────────▼─────────────────────────────────────┐
│                   BACKGROUND SERVICE WORKER (Tier 0..3)                │
│  - main.js (Entry point & tiered initialization)                       │
│  - core/ (Lifecycle, MessageRouter, LockManager)                       │
│  - services/ (ScriptRegistry, ApiHandler, CacheManager, GDrive)        │
└──────────────────────────────────▲─────────────────────────────────────┘
                                   │ Offscreen IPC
┌──────────────────────────────────▼─────────────────────────────────────┐
│                    OFFSCREEN DOCUMENT (offscreen.html)                  │
│  - GM_xmlhttpRequest binary streaming & DOM parsing                    │
│  - GM_setClipboard fallback execution                                 │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 📂 Detailed File & Directory Map

### 1. Root Configuration & Manifests
- **`manifest.json`**: Active Manifest V3 configuration used for local Chrome development and testing.
- **`manifest.chrome.json`**: Standardized release manifest for Google Chrome Web Store.
- **`manifest.firefox.json`**: Gecko-compatible release manifest for Mozilla Firefox (AMO).
- **`package-extensions.sh`**: Dual-target packaging shell script generating Chrome and Firefox ZIP releases into `build/`.
- **`package.json`**: Standard Node.js metadata enabling native ESM test execution (`npm test`).

### 2. Core Execution Engine (`js/`)
- **`js/bootstrap.js`**: Content script running in the ISOLATED world. Listens for `CustomEvent` calls from the page context, validates secret `pageToken` tokens, and proxies API calls to the background Service Worker.
- **`js/gm-api-provider.js`**: Main-world JavaScript provider stringified and injected directly into host pages. Exposes standard Greasemonkey/Tampermonkey `GM_*` and `GM.*` functions to userscripts.
- **`js/database.js`**: Dexie.js (IndexedDB) database wrapper encapsulating `scripts` metadata and `scriptCodes` source strings into distinct stores to keep memory overhead minimal during background operations.
- **`js/constants.js`**: Single source of truth for constants, trusted domain hostnames (`TRUSTED_SCRIPT_HOSTS`), default settings, and restricted browser URL helpers (`isRestrictedUrl`).
- **`js/message-types.js`**: Immutable enum (`MSG`) defining IPC communication action strings across all tiers.
- **`js/theme-applier.js`**: Lightweight UI theme applier script managing dark/light/auto themes across options, popup, and installer pages.

### 3. Background Service Worker (`js/background/`)
- **`js/background/main.js`**: Service Worker entry point. Initializes extension services in sequential tiers (Logging -> Lifecycle -> Router -> Interceptor -> API -> Cache -> Styling -> Badges -> Scheduler).
- **`js/background/log-wrapper.js`**: Generates sandboxed JS wrapper code stringified into page context for console logging and uncaught error stack filtering.
- **`js/background/utils.js`**: Core background utilities for `@require` fetch caching, `@match` wildcard matching, rules evaluation (`getEffectiveRules`), and permission calculation (`handlePermissionCheck`).

#### Service Worker Core Orchestration (`js/background/core/`)
- **`app-lifecycle.js`**: Handlers for `runtime.onInstalled` and `runtime.onStartup` migrations and context setups.
- **`lock-manager.js`**: Web Locks API (`navigator.locks`) wrapper enforcing sequential, non-race mutation locks over IndexedDB operations.
- **`message-router.js`**: Central IPC message dispatcher. Enforces `handleMessage` synchronous `return true` contracts for async responses and validates `pageToken` authenticity.

#### Extension Services (`js/background/services/`)
- **`script-registry.js`**: Installs, updates, deletes, and reorders userscripts. Manages dynamic script execution injection (`userScripts.execute` or `scripting.executeScript`).
- **`gm-api-handler.js`**: Backend implementation for `GM_setValue`, `GM_getValue`, `GM_notification`, `GM_cookie`, and offscreen proxying.
- **`cache-manager.js`**: SW RAM cache layer featuring an `_initPromise` mutex flag to prevent thundering herd IndexedDB reads on Service Worker wake-up.
- **`gdrive-service.js`**: Handles OAuth2 authentication and `appDataFolder` cloud synchronization for Google Drive.
- **`userscript-interceptor.js`**: Configures `declarativeNetRequest` dynamic rules to capture `.user.js` navigations and redirect them to the installer UI.
- **`badge-manager.js`**: Manages browser action icon badge counters indicating active scripts per tab.
- **`style-injector.js`**: Programmatically injects UserStyles (`.user.css`) using `browser.scripting.insertCSS`.
- **`update-scheduler.js`**: Alarm-based periodic update scheduler for userscripts.
- **`update-service.js`**: Fetches `@updateURL` / `@downloadURL` headers and compares semantic versions (`compareSemanticVersions`).
- **`log-manager.js`**: Session storage logger with rate-limiting and debounced storage flushes.

### 4. User Interface & Pages (`html/`, `js/pages/`, `js/ui/`)
- **`html/options.html` & `js/pages/options.js`**: Full-page management interface, code editor, settings panel, import/export, and Google Drive sync triggers.
- **`html/popup.html` & `js/pages/popup.js`**: Browser action popup for toggling scripts on active tabs, viewing execution logs, and running menu commands.
- **`html/installer.html` & `js/pages/installer.js`**: Security-first script installation page displaying source code, metadata, permissions, and trusted site warnings.
- **`html/offscreen.html` & `js/pages/offscreen.js`**: Offscreen DOM document for handling DOM parsing, streaming XHR responses, and clipboard fallback operations.

### 5. Automated Test Suites & Test Assets (`tests/`)
- **`tests/e2e-extension.test.js`**: Manifest V3 JSON validation, file existence, and ES module import integrity tests.
- **`tests/match-pattern.test.js`**: MatchPattern wildcard parsing and host permission checks.
- **`tests/meta-parser.test.js`**: MetadataParser header directive parsing and serialization tests.
- **`tests/update-service.test.js`**: Semantic versioning comparison tests.
- **`tests/utils-rules.test.js`**: Rules evaluation (`getEffectiveRules` and `isRunnableOnUrl`) tests.
- **`tests/permissions-sync.test.js`**: Permissions aggregation and `@grant` mapping tests.
- **`tests/test-scripts/`**: Suite of 5 sandbox userscripts covering GM storage, XHR, DOM/CSS, menu commands, and UserStyles.

---

## 🎯 Rationale Behind Key Architectural Decisions

1. **Why Plain JavaScript (ESM) with No Build Pipeline?**
   - Eliminates build step complexity, source map mapping issues, and hidden compiled code vulnerabilities. Code running in production is 100% readable and auditable.

2. **Why Separate Main World (`gm-api-provider.js`) and Isolated World (`bootstrap.js`) via `pageToken`?**
   - Host web pages can attempt to forge events or spy on extension IPC messages. By generating a unique `pageToken` per page context and verifying it in `bootstrap.js` and `message-router.js`, malicious page scripts cannot hijack `GM_*` APIs.

3. **Why Offscreen Document (`offscreen.html`) in MV3?**
   - Manifest V3 Service Workers lack DOM access (no `document`, `XMLHttpRequest`, or `window`). Offscreen document provides a dedicated DOM context for binary XHR streaming and clipboard fallbacks without polluting background Service Worker RAM.

4. **Why Dexie.js (IndexedDB) Instead of `chrome.storage.local` for Script Source Storage?**
   - IndexedDB supports large string storage, indexed querying, and transactional isolation without encountering `chrome.storage` quota limits or blocking extension messaging.
