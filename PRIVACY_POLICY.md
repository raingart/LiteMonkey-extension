# Privacy Policy for Lite Monkey

**Effective Date**: August 5, 2026

**Lite Monkey** ("we", "our", or "us") is committed to protecting your privacy. This Privacy Policy explains our data practices regarding the **Lite Monkey** browser extension for Google Chrome, Mozilla Firefox, and Chromium-based browsers.

---

## 1. Zero Data Collection

**Lite Monkey does NOT collect, store, transmit, or monitor any personal data or web history.**

- We do NOT collect personally identifiable information (name, email address, IP address).
- We do NOT track, log, or store your browsing history, visited URLs, or website content.
- We do NOT use analytics, telemetry, tracking pixels, or third-party advertising scripts.
- We do NOT sell, rent, or transfer any user data to third parties.

---

## 2. Local Execution & Storage

All data created or managed by Lite Monkey stays strictly local on your device:

- **Userscript Source Code & Storage Values**: Installed userscripts and their associated `GM_setValue` data are saved locally within your browser's IndexedDB and Extension Local Storage (`chrome.storage.local`).
- **Google Drive Backup (Optional)**: If you choose to enable Google Drive Synchronization, backup data is transferred directly between your browser and your personal Google Drive account using official Google OAuth2 APIs. We do not host or operate any intermediary proxy servers.

---

## 3. Browser Permissions

Lite Monkey requests permissions strictly necessary to execute user-installed scripts:

- **`userScripts` / `scripting`**: To run userscripts on matching websites defined by script headers (`@match`).
- **`declarativeNetRequest`**: To intercept `.user.js` links and show the script installer.
- **`storage` / `unlimitedStorage`**: To store userscripts and settings locally without size truncation.
- **`offscreen`**: To handle DOM parsing and binary file transfers for userscripts offline.
- **`notifications`**: To show desktop notifications requested by userscripts via `GM_notification`.
- **`identity`**: To authenticate directly with Google Drive for optional user-initiated backups.

---

## 4. Single Purpose

Lite Monkey's sole purpose is to serve as an offline manager for user-installed JavaScript userscripts and CSS userstyles.

---

## 5. Contact & Open Source

Lite Monkey is open-source software licensed under the MIT License. You can review the complete source code and verify our privacy practices on GitHub.

If you have any questions regarding this Privacy Policy, please open an issue on our GitHub repository.
