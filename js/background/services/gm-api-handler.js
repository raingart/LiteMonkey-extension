import browser from '../../libs/browser-support.js';
import { MSG } from '../../message-types.js';
import { agents } from '../../database.js';
import { ErrorCollector } from '../../libs/error-collector.js';
import Utils from '../utils.js';
import { logger } from '../../libs/logger.js';
import CacheManager from './cache-manager.js';

const CONTEXT = 'ApiHandler';
const OFFSCREEN_DOCUMENT_PATH = 'html/offscreen.html';

// Security and performance limits
const MAX_STORAGE_VALUE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_STORAGE_KEYS_PER_SCRIPT = 500;
const NOTIFICATION_RATE_LIMIT = { COUNT: 5, SECONDS: 10 };

/**
 * Handles Greasemonkey / Tampermonkey API calls from userscripts, acting as a secure bridge
 * between sandboxed page content scripts and background extension services in Manifest V3.
 */
class ApiHandler {
   #registeredCommands = new Map();
   #notificationCallbacks = new Map();
   #notificationTimestamps = new Map();
   #offscreenDocumentPromise = null;
   #tabCloseSubscribers = new Set();
   #tabLocks = new Map();
   #tabUrls = new Map(); // Track main-frame tab URLs to prevent false-positive SPA resets

   constructor() {
      this.initialize();
   }

   // helper to clear tokens for a specific tab
   async #clearTokensForTab(tabId) {
      try {
         const prefix = `token_${tabId}_`;
         if (browser.storage?.session) {
            const sessionData = await browser.storage.session.get(null);
            const keysToDelete = Object.keys(sessionData).filter((k) => k.startsWith(prefix));
            if (keysToDelete.length > 0) {
               await browser.storage.session.remove(keysToDelete);
            }
         } else if (browser.storage?.local) {
            // Only scan storage.local if storage.session is unsupported in the current browser
            const localData = await browser.storage.local.get(null);
            const localKeysToDelete = Object.keys(localData).filter((k) => k.startsWith(prefix));
            if (localKeysToDelete.length > 0) {
               await browser.storage.local.remove(localKeysToDelete);
            }
         }

         if (globalThis.__litemonkey_tokens) {
            for (const key of Object.keys(globalThis.__litemonkey_tokens)) {
               if (key.startsWith(prefix)) {
                  delete globalThis.__litemonkey_tokens[key];
               }
            }
         }
      } catch (err) {
         logger.warn(CONTEXT, 'Failed to clean up tab tokens:', err);
      }
   }

   // Helper to clean up unstable diagnostic flags when a tab navigates to a new page
   async #clearUnstableFlagsForTab(tabId) {
      try {
         if (!browser.storage?.session) return;
         const sessionData = await browser.storage.session.get(null);
         const keysToDelete = Object.keys(sessionData).filter((k) => k.startsWith(`unstable_${tabId}_`));
         if (keysToDelete.length > 0) {
            await browser.storage.session.remove(keysToDelete);
         }
      } catch (err) { }
   }

   /**
    * Attaches global browser extension event listeners.
    */
   initialize() {
      browser?.notifications?.onClicked?.addListener((id) =>
         this.#sendNotificationEvent(id, MSG.EVENT_NOTIFICATION_CLICKED)
      );

      browser?.notifications?.onClosed?.addListener((id) => {
         this.#sendNotificationEvent(id, MSG.EVENT_NOTIFICATION_CLOSED);
         this.#notificationCallbacks.delete(id);
      });

      browser?.tabs?.onRemoved?.addListener((tabId) => {
         this.#tabUrls.delete(tabId); // Clean up tracked tab URL on tab close
         this.handleTabRemoved(tabId);
      });

      // Only clear menu commands on real top-level main frame navigation (changeInfo.url present)
      browser?.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
         if (changeInfo.status === 'loading' && changeInfo.url) {
            this.#tabUrls.set(tabId, changeInfo.url);
            browser?.storage?.session?.remove(`menu_cmds_${tabId}`).catch(() => { });
            this.#clearTokensForTab(tabId); // Prevent token memory leak on page reloads/SPA navigation
            this.#clearUnstableFlagsForTab(tabId);
         }
      });

      logger.debug(CONTEXT, 'Initialized');
   }

   // --- Private Helpers ---

   /**
    * Checks if the extension holds a specific manifest permission.
    * @private
    * @param {string} permission - Extension permission string.
    * @returns {Promise<boolean>}
    */
   async #hasPermission(permission) {
      return browser.permissions.contains({ permissions: [permission] });
   }

   /**
    * Evaluates target URL against a script's `@connect` manifest rules and same-origin policies.
    * @private
    * @param {number} scriptId - Script database ID.
    * @param {string} url - Target request URL.
    * @param {Object} sender - WebExtension MessageSender context.
    * @returns {Promise<{allowed: boolean, error?: string}>}
    */
   async #isUrlAllowedByConnectRules(scriptId, url, sender) {
      const script = await CacheManager.getById(scriptId);
      if (!script) return { allowed: false, error: 'Script not found.' };

      // Inherently safe local URLs (data/blob) do not require @connect host permissions
      if (url.startsWith('data:') || url.startsWith('blob:')) {
         return { allowed: true };
      }

      const connectRules = [].concat(script.meta?.connect || []);

      // Extract current page origin hostname from sender tab
      let documentHost = null;
      if (sender?.tab?.url) {
         try {
            documentHost = new URL(sender.tab.url).hostname;
         } catch {
            // Ignore malformed sender tab URL
         }
      }

      let targetHost = null;
      try {
         targetHost = new URL(url).hostname;
      } catch {
         return { allowed: false, error: 'Invalid target URL.' };
      }

      const isAllowed = connectRules.some((rule) => {
         if (rule === '*') return true;

         // Support '@connect self' directive matching origin page host
         if (rule === 'self' && documentHost) {
            return targetHost === documentHost || targetHost.endsWith('.' + documentHost);
         }

         // Clean rule domain from protocol and path prefixes
         let ruleDomain = rule;
         if (rule.includes('://')) {
            try {
               ruleDomain = new URL(rule).hostname;
            } catch {
               ruleDomain = rule.split('://')[1].split('/')[0];
            }
         }
         ruleDomain = ruleDomain.split(':')[0].split('/')[0].trim();

         if (ruleDomain.startsWith('*.')) {
            const baseDomain = ruleDomain.substring(2);
            return targetHost === baseDomain || targetHost.endsWith('.' + baseDomain);
         }

         // Greasemonkey/Tampermonkey spec: domain "domain.com" allows domain.com and *.domain.com
         return targetHost === ruleDomain || targetHost.endsWith('.' + ruleDomain);
      });

      // Same-origin fallback: grant access without explicit @connect if requesting the page's own domain
      if (!isAllowed && documentHost) {
         if (targetHost === documentHost || targetHost.endsWith('.' + documentHost)) {
            return { allowed: true };
         }
      }

      return isAllowed
         ? { allowed: true }
         : { allowed: false, error: `The URL "${url}" is not included in the script's @connect domains.` };
   }

   /**
    * Ensures offscreen document exists for features unsupported directly in MV3 Service Workers
    * (e.g. DOM parsing, streaming XHR responses, clipboard write).
    * @private
    * @returns {Promise<void>}
    */
   #getOffscreenDocument() {
      if (!this.#offscreenDocumentPromise) {
         this.#offscreenDocumentPromise = (async () => {
            try {
               let hasContexts = false;
               if (typeof browser.runtime.getContexts === 'function') {
                  try {
                     const contexts = await browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
                     hasContexts = contexts.length > 0;
                  } catch (e) {
                     logger.warn(CONTEXT, 'browser.runtime.getContexts failed:', e);
                  }
               }
               if (hasContexts) {
                  logger.debug(CONTEXT, 'Offscreen document already exists.');
                  return;
               }
               await browser.offscreen.createDocument({
                  url: OFFSCREEN_DOCUMENT_PATH,
                  reasons: ['CLIPBOARD', 'DOM_PARSER'],
                  justification: 'Required for GM_xmlhttpRequest and GM_setClipboard to bypass Service Worker limitations.',
               });
               logger.debug(CONTEXT, 'Offscreen document created successfully.');
            } catch (err) {
               if (err?.message && err.message.includes('Only a single offscreen document may be created')) {
                  logger.debug(CONTEXT, 'Offscreen document already exists (caught exception).');
                  return;
               }
               logger.error(CONTEXT, 'Failed to create offscreen document:', err);
               this.#offscreenDocumentPromise = null; // Reset cached promise to allow retries on failure
               throw err;
            }
         })();
      }
      return this.#offscreenDocumentPromise;
   }

   /**
    * Proxies a message payload to the offscreen document with dynamic re-creation if evicted by Chrome.
    * @private
    * @param {string} type - Message type identifier.
    * @param {Object} payload - Data object.
    * @returns {Promise<Object>} Response from offscreen handler.
    */
   async #proxyToOffscreen(type, payload) {
      const currentPromise = this.#offscreenDocumentPromise;
      await this.#getOffscreenDocument();

      try {
         return await browser.runtime.sendMessage({ target: 'offscreen', type, payload });
      } catch (err) {
         if (err?.message && err.message.includes('Receiving end does not exist')) {
            logger.debug(CONTEXT, 'Offscreen document was closed by OS/Browser. Re-creating on the fly...');

            // Thread-safe reset. Only nullify if another concurrent request hasn't already done it.
            // Prevents multiple simultaneous calls to browser.offscreen.createDocument()
            if (this.#offscreenDocumentPromise === currentPromise) {
               this.#offscreenDocumentPromise = null;
            }

            await this.#getOffscreenDocument();
            return await browser.runtime.sendMessage({ target: 'offscreen', type, payload });
         }
         logger.error(CONTEXT, `Error communicating with offscreen document for ${type}:`, err);
         return { success: false, error: err.message };
      }
   }

   /**
    * Dispatches notification click/close events back to originating tab.
    * @private
    * @param {string} notificationId - Notification ID.
    * @param {string} eventType - Notification event type message identifier.
    */
   #sendNotificationEvent(notificationId, eventType) {
      const context = this.#notificationCallbacks.get(notificationId);
      if (!context?.tabId) return;

      browser.tabs.sendMessage(context.tabId, { type: eventType, payload: { notificationId } })
         .catch(() => logger.warn(CONTEXT, `Could not send notification event to tab ${context.tabId}. It may have been closed.`));
   }

   /**
    * Pre-checks permissions and tab origin for GM_cookie actions.
    * @private
    * @param {Object} sender - WebExtension MessageSender object.
    * @returns {Promise<Object|null>} Error object or null if pre-check passes.
    */
   async #cookiePrecheck(sender) {
      if (!(await this.#hasPermission('cookies'))) {
         return { success: false, error: 'Missing "cookies" permission.' };
      }
      if (!sender?.tab?.url) {
         return { success: false, error: 'Cannot determine the origin URL for the operation.' };
      }
      return null;
   }

   // --- Greasemonkey API Handlers ---

   /**
    * Handles GM_notification creation with sliding rate-limiting checks.
    */
   async handleNotification({ notificationId, hasOnClick, hasOnDone, details, scriptId }, sender) {
      const now = Date.now();
      const timestamps = this.#notificationTimestamps.get(scriptId) || [];
      const recentTimestamps = timestamps.filter((ts) => now - ts < NOTIFICATION_RATE_LIMIT.SECONDS * 1000);

      if (recentTimestamps.length >= NOTIFICATION_RATE_LIMIT.COUNT) {
         logger.warn(CONTEXT, `Script ${scriptId} exceeded notification rate limit. Ignoring.`);
         return { success: true, ignored: true };
      }

      this.#notificationTimestamps.set(scriptId, [...recentTimestamps, now]);

      try {
         const iconUrl = await Utils.fetchIconAsDataUrl(details.iconUrl);
         await browser.notifications.create(notificationId, { ...details, iconUrl });

         if ((hasOnClick || hasOnDone) && sender.tab?.id) {
            this.#notificationCallbacks.set(notificationId, { tabId: sender.tab.id });

            setTimeout(() => {
               this.#notificationCallbacks.delete(notificationId);
            }, 30000);
         }
      } catch (err) {
         logger.error(CONTEXT, `Failed to create notification ${notificationId}:`, err.message);
         ErrorCollector.captureAndReport(err, { trace_name: 'ApiHandler.handleNotification' });
      }
      return { success: true };
   }

   // --- Menu Command Management ---

   /**
    * Retrieves menu commands registered for a specific tab ID.
    * @param {number} tabId
    * @returns {Promise<Record<number, Array<{commandId: string, caption: string}>>>}
    */
   async getCommandsForTab(tabId) {
      if (!tabId || !browser.storage?.session) return {};
      try {
         const key = `menu_cmds_${tabId}`;
         const data = await browser.storage.session.get(key);
         return data[key] || {};
      } catch {
         return {};
      }
   }

   // Actually remove orphaned menu commands from browser.storage.session to prevent memory leaks
   async clearCommandsForScript(scriptId) {
      try {
         if (!browser.storage?.session) return;
         const sessionData = await browser.storage.session.get(null);
         const updates = {};
         let hasUpdates = false;

         for (const [key, tabCommands] of Object.entries(sessionData)) {
            if (key.startsWith('menu_cmds_') && tabCommands[scriptId]) {
               delete tabCommands[scriptId];
               updates[key] = tabCommands;
               hasUpdates = true;
            }
         }

         if (hasUpdates) {
            await browser.storage.session.set(updates);
         }
      } catch (err) {
         logger.warn(CONTEXT, 'Failed to clear commands for deleted script:', err);
      }
   }

   /**
    * Executes an async action sequentially per tabId.
    * @private
    */
   #withTabLock(tabId, action) {
      const prevPromise = this.#tabLocks.get(tabId) || Promise.resolve();
      const newPromise = prevPromise.then(async () => {
         try {
            return await action();
         } catch (err) {
            logger.error(CONTEXT, `Tab lock error for tab ${tabId}:`, err);
         }
      });
      this.#tabLocks.set(tabId, newPromise);
      return newPromise;
   }

   /**
    * Registers a menu command for a script in a tab.
    */
   async registerMenuCommand({ scriptId, commandId, caption }, sender) {
      const tabId = sender?.tab?.id;
      if (!tabId || !scriptId || !commandId) return { success: false };

      return this.#withTabLock(tabId, async () => {
         logger.debug(CONTEXT, `Registering command for script ${scriptId} in tab ${tabId}: "${caption}"`);
         const key = `menu_cmds_${tabId}`;
         const tabCommands = await this.getCommandsForTab(tabId);
         const scriptCmds = tabCommands[scriptId] || [];

         const filtered = scriptCmds.filter((c) => c.commandId !== commandId);
         filtered.push({ commandId, caption });

         tabCommands[scriptId] = filtered;
         await browser.storage.session.set({ [key]: tabCommands });
         return { success: true };
      });
   }

   /**
    * Unregisters a menu command for a script in a tab.
    */
   async unregisterMenuCommand({ scriptId, commandId }, sender) {
      const tabId = sender?.tab?.id;
      if (!tabId || !scriptId || !commandId) return { success: false };

      return this.#withTabLock(tabId, async () => {
         const key = `menu_cmds_${tabId}`;
         const tabCommands = await this.getCommandsForTab(tabId);
         const scriptCmds = tabCommands[scriptId] || [];

         tabCommands[scriptId] = scriptCmds.filter((c) => c.commandId !== commandId);
         await browser.storage.session.set({ [key]: tabCommands });
         return { success: true };
      });
   }

   // --- Resource Handling ---

   async #findResourceUrl(scriptId, name) {
      const script = await CacheManager.getById(scriptId);
      if (!script) return null;

      // Read resource map directly from metadata cache
      return script.meta?.resource?.[name] || null;
   }

   async getResourceText({ scriptId, name }) {
      const resourceUrl = await this.#findResourceUrl(scriptId, name);
      if (!resourceUrl) return { value: null };
      try {
         const response = await Utils.fetchWithTimeout(resourceUrl);
         return { value: await response.text() };
      } catch (err) {
         logger.error(CONTEXT, `Failed to fetch resource text "${name}" (${resourceUrl}):`, err);
         return { value: null };
      }
   }

   async getResourceUrl({ scriptId, name }) {
      const resourceUrl = await this.#findResourceUrl(scriptId, name);
      if (!resourceUrl) return { value: null };
      try {
         return { value: await Utils.fetchResourceAsDataUrl(resourceUrl) };
      } catch (err) {
         logger.error(CONTEXT, `Failed to fetch resource URL "${name}" (${resourceUrl}):`, err);
         return { value: null };
      }
   }

   /**
    * Validates @connect domain policies and proxies GM_xmlhttpRequest execution to Offscreen.
    */
   async handleXmlHttpRequest(payload, sender) {
      const { scriptId, details, requestId } = payload;
      const { url } = details;
      const check = await this.#isUrlAllowedByConnectRules(scriptId, url, sender);

      if (!check.allowed) {
         logger.warn(CONTEXT, `GM_xmlhttpRequest error: ${check.error}`);
         browser.tabs.sendMessage(
            sender.tab.id,
            {
               type: MSG.GM_XMLHTTPREQUEST_CALLBACK,
               payload: {
                  scriptId, // Include scriptId for targeted downlink dispatch
                  requestId,
                  eventType: 'onerror',
                  response: {
                     status: 0,
                     statusText: 'Forbidden by @connect rules',
                     error: check.error,
                  },
               },
            },
            { frameId: sender.frameId ?? 0 }
         ).catch(() => { });
         return { success: false, error: check.error };
      }

      try {
         const result = await this.#proxyToOffscreen(MSG.GM_XMLHTTPREQUEST, {
            requestId,
            scriptId, // Pass scriptId to offscreen payload
            details,
            tabId: sender.tab.id,
            frameId: sender.frameId ?? 0,
         });

         if (result && !result.success) {
            throw new Error(result.error || 'Offscreen document rejected request');
         }
         return result;
      } catch (err) {
         logger.error(CONTEXT, `GM_xmlhttpRequest offscreen proxy dispatch failed for req ${requestId}:`, err);

         if (sender?.tab?.id) {
            browser.tabs.sendMessage(
               sender.tab.id,
               {
                  type: MSG.GM_XMLHTTPREQUEST_CALLBACK,
                  payload: {
                     scriptId, // Include scriptId for targeted downlink dispatch
                     requestId,
                     eventType: 'onerror',
                     response: {
                        status: 0,
                        statusText: 'Offscreen Request Execution Error',
                        error: err.message || 'Offscreen document proxy failure',
                     },
                  },
               },
               { frameId: sender.frameId ?? 0 }
            ).catch(() => { });
         }
         return { success: false, error: err.message };
      }
   }

   async handleXmlHttpRequestAbort(payload) {
      return this.#proxyToOffscreen(MSG.GM_XMLHTTPREQUEST_ABORT, payload);
   }

   // --- Storage API ---

   // Batch fetch all GM_storage entries for a script in a single Dexie database transaction
   async getFullStorage({ scriptId }) {
      try {
         const keys = await agents.listSettings(scriptId);
         const entries = await Promise.all(
            keys.map(async (k) => [k, await agents.getSetting(scriptId, k)])
         );
         return { success: true, value: Object.fromEntries(entries) };
      } catch (err) {
         logger.error(CONTEXT, `Failed to get full storage for script ${scriptId}:`, err);
         return { success: false, value: {}, error: err.message };
      }
   }

   listGmValues = async ({ scriptId }) => ({ value: await agents.listSettings(scriptId) });
   getGmValue = async ({ scriptId, key, defaultValue }) => ({ value: await agents.getSetting(scriptId, key, defaultValue) });

   async setGmValue({ scriptId, key, value }) {
      try {
         const valueSize = new TextEncoder().encode(JSON.stringify(value)).length;
         if (valueSize > MAX_STORAGE_VALUE_SIZE_BYTES) {
            throw new Error(`Value for key "${key}" exceeds the ${MAX_STORAGE_VALUE_SIZE_BYTES / 1024 / 1024}MB size limit.`);
         }

         const [oldValue, currentKeys] = await Promise.all([
            agents.getSetting(scriptId, key),
            agents.listSettings(scriptId),
         ]);

         if (!currentKeys.includes(key) && currentKeys.length >= MAX_STORAGE_KEYS_PER_SCRIPT) {
            throw new Error(`Script has reached the storage limit of ${MAX_STORAGE_KEYS_PER_SCRIPT} keys.`);
         }

         // Helper function comparing binary TypedArrays and objects safely
         const isValueEqual = (a, b) => {
            if (a === b) return true;
            if (a == null || b == null) return false;
            if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
               if (a.byteLength !== b.byteLength) return false;
               return a.every((val, i) => val === b[i]);
            }
            try { return JSON.stringify(a) === JSON.stringify(b); }
            catch { return false; }
         };

         if (isValueEqual(oldValue, value)) {
            return { success: true, changed: false };
         }

         await agents.setSetting(scriptId, key, value);
         return { success: true, changed: true, oldValue, newValue: value };
      } catch (err) {
         logger.error(CONTEXT, `Failed to set value for script ${scriptId}:`, err.message);
         return { success: false, error: err.message };
      }
   }

   async deleteGmValue({ scriptId, key }) {
      try {
         const oldValue = await agents.getSetting(scriptId, key);
         if (oldValue === undefined) {
            return { success: true, changed: false };
         }
         await agents.deleteSetting(scriptId, key);
         return { success: true, changed: true, oldValue };
      } catch (err) {
         logger.error(CONTEXT, `Failed to delete value for script ${scriptId}:`, err.message);
         return { success: false, error: err.message };
      }
   }

   // --- Cookie API ---

   // Helper to validate that requested cookie domains/URLs match the executing page's origin
   #validateCookieOrigin(pageUrlStr, targetUrlStr, targetDomain) {
      const pageUrl = new URL(pageUrlStr);
      if (targetUrlStr) {
         const targetUrl = new URL(targetUrlStr);
         // Verify page origin is equal to or a subdomain of target host (parent domain access)
         if (!pageUrl.hostname.endsWith(targetUrl.hostname) && pageUrl.hostname !== targetUrl.hostname) {
            return `Security Error: Cannot access cookies for cross-origin URL: ${targetUrlStr}`;
         }
      }
      if (targetDomain) {
         const cleanDomain = targetDomain.startsWith('.') ? targetDomain.substring(1) : targetDomain;
         // Verify page origin is equal to or a subdomain of requested cookie domain
         if (!pageUrl.hostname.endsWith(cleanDomain) && pageUrl.hostname !== cleanDomain) {
            return `Security Error: Cannot access cookies for cross-origin domain: ${targetDomain}`;
         }
      }
      return null;
   }

   async handleCookieList(details, sender) {
      const precheckError = await this.#cookiePrecheck(sender);
      if (precheckError) return precheckError;

      try {
         const frameUrl = sender.url || sender.tab.url;
         // Enforce Same-Origin Policy for cookie reading
         const originError = this.#validateCookieOrigin(frameUrl, details.url, details.domain);
         if (originError) return { success: false, error: originError };

         const query = { url: frameUrl, ...details };
         if (sender.tab?.cookieStoreId) {
            query.storeId = sender.tab.cookieStoreId;
         }
         const cookies = await browser.cookies.getAll(query);
         return { success: true, value: cookies };
      } catch (err) {
         logger.error(CONTEXT, 'GM_cookie "list" failed:', err);
         return { success: false, error: err.message };
      }
   }

   // Hardened GM_cookie set implementation preventing cross-origin scope escape
   async handleCookieSet(details, sender) {
      const precheckError = await this.#cookiePrecheck(sender);
      if (precheckError) return precheckError;
      if (!details?.name) return { success: false, error: 'GM_cookie "set" requires a "name" property.' };

      try {
         const frameUrl = sender.url || sender.tab.url;
         const pageUrl = new URL(frameUrl);
         const { name, value, path, secure, httpOnly, sameSite, expirationDate } = details;

         // Validate requested domain matches current page origin or valid parent domain
         let cookieDomain = details.domain;
         if (cookieDomain) {
            cookieDomain = cookieDomain.startsWith('.') ? cookieDomain.substring(1) : cookieDomain;
            if (!pageUrl.hostname.endsWith(cookieDomain) && pageUrl.hostname !== cookieDomain) {
               return { success: false, error: `Cannot set cookie for domain "${cookieDomain}" from "${pageUrl.hostname}".` };
            }
         }

         // Explicit whitelist preventing parameter overrides via rest spread
         const cookieToSet = {
            url: frameUrl,
            name: String(name),
            value: String(value ?? ''),
            ...(cookieDomain && { domain: cookieDomain }),
            ...(path && { path }),
            ...(secure !== undefined && { secure }),
            ...(httpOnly !== undefined && { httpOnly }),
            ...(sameSite && { sameSite }),
            // Allow expirationDate of 0 (Epoch) to correctly expire cookies immediately
            ...(expirationDate !== undefined && { expirationDate: Number(expirationDate) }),
            ...(sender.tab.cookieStoreId && { storeId: sender.tab.cookieStoreId }),
         };

         const cookie = await browser.cookies.set(cookieToSet);
         if (!cookie) throw new Error('Browser rejected the cookie.');
         return { success: true, value: cookie };
      } catch (err) {
         logger.error(CONTEXT, `GM_cookie "set" failed for cookie "${details.name}":`, err);
         return { success: false, error: `Failed to set cookie. Browser error: ${err.message}` };
      }
   }

   async handleCookieDelete(details, sender) {
      const precheckError = await this.#cookiePrecheck(sender);
      if (precheckError) return precheckError;

      const name = details?.name;
      if (!name) return { success: false, error: 'GM_cookie "delete" requires a "name" property.' };

      try {
         const frameUrl = sender.url || sender.tab.url;

         // Enforce Same-Origin Policy for cookie deletion
         const originError = this.#validateCookieOrigin(frameUrl, details.url, details.domain);
         if (originError) return { success: false, error: originError };

         const targetStoreId = sender.tab?.cookieStoreId || details.storeId;

         const query = {
            name,
            url: details.url || frameUrl,
            ...(details.path && { path: details.path }),
            ...(targetStoreId && { storeId: targetStoreId }),
         };

         const removedCookie = await browser.cookies.remove(query);
         return { success: true, value: removedCookie };
      } catch (err) {
         logger.error(CONTEXT, 'GM_cookie "delete" failed:', err);
         return { success: false, error: err.message };
      }
   }

   // --- Tab Event Handling ---

   handleOnTabCloseSubscribe(sender) {
      if (sender.tab?.id) {
         logger.debug(CONTEXT, `Tab ${sender.tab.id} subscribed to tab close events.`);
         this.#tabCloseSubscribers.add(sender.tab.id);
      }
   }

   /**
    * Cleans up transient session tokens and storage entries bound to closed tab IDs.
    * @param {number} tabId - ID of closed tab.
    */
   async handleTabRemoved(tabId) {
      if (tabId && browser.storage?.session) {
         await browser.storage.session.remove(`menu_cmds_${tabId}`).catch(() => { });
      }

      await this.#clearTokensForTab(tabId);

      // Prevent unbounded memory leak of tab locks
      this.#tabLocks.delete(tabId);

      if (this.#tabCloseSubscribers.size === 0) return;

      // If the closed tab itself was subscribed, remove it from subscribers set
      this.#tabCloseSubscribers.delete(tabId);

      // Broadcast tab closed event to all active subscriber tabs
      const message = { type: MSG.EVENT_TAB_CLOSED, payload: { tabId } };
      for (const subscriberTabId of [...this.#tabCloseSubscribers]) {
         browser.tabs.sendMessage(subscriberTabId, message)
            .catch(() => this.#tabCloseSubscribers.delete(subscriberTabId));
      }
   }

   // --- Other APIs ---

   executeMenuCommand({ tabId, scriptId, commandId }) {
      logger.info(CONTEXT, `Executing menu command "${commandId}" for script ${scriptId} on tab ${tabId}`);
      browser.tabs.sendMessage(tabId, { type: MSG.EVENT_EXECUTE_MENU_COMMAND, payload: { scriptId, commandId } })
         .catch(() => logger.warn(CONTEXT, `Could not send executeMenuCommand to tab ${tabId}. It may have been closed.`));
      return { success: true };
   }

   /**
    * Handles GM_setClipboard calls by proxying the request to offscreen document.
    * @param {Object} details - Request details containing target clipboard text.
    * @returns {Promise<Object>}
    */
   async handleSetClipboard(details) {
      if (!(await this.#hasPermission('clipboardWrite'))) {
         return { success: false, error: 'Missing "clipboardWrite" permission.' };
      }
      return this.#proxyToOffscreen(MSG.GM_SET_CLIPBOARD, details);
   }

   /**
    * Handles GM_download calls with connect rule check and browser downloads API initiation.
    */
   async handleDownload(payload, sender) {
      const { url, name, scriptId, saveAs } = payload; // Extract saveAs from payload

      if (!(await this.#hasPermission('downloads'))) return { success: false, error: 'Missing "downloads" permission.' };

      // Allow data: URLs (converted from blobs) to be downloaded
      if (!url?.startsWith('http') && !url?.startsWith('data:')) {
         return { success: false, error: 'GM_download error: URL must be a valid HTTP/HTTPS or Data URL.' };
      }

      const check = await this.#isUrlAllowedByConnectRules(scriptId, url, sender);
      if (!check.allowed) {
         logger.warn(CONTEXT, `GM_download error: ${check.error}`);
         return { success: false, error: check.error };
      }

      try {
         // Sanitize filename to prevent directory traversal and invalid OS characters
         let safeFilename = name ? String(name).trim() : '';
         if (safeFilename) {
            safeFilename = safeFilename
               .replace(/^[\/\\]+/, '')
               .replace(/\.\.[\/\\]/g, '')
               .replace(/[<>:"|?*]/g, '_');
         }

         const downloadId = await browser.downloads.download({
            url: url,
            ...(safeFilename && { filename: safeFilename }),
            saveAs: Boolean(saveAs), // Respect userscript's saveAs preference
         });

         logger.debug(CONTEXT, `Download started for URL: ${url}. Download ID: ${downloadId}`);
         return { success: true, value: { downloadId } };
      } catch (err) {
         logger.error(CONTEXT, `GM_download failed for URL "${url}":`, err);
         return { success: false, error: err.message };
      }
   }

   async handleGetTab(sender) {
      if (!(await this.#hasPermission('tabs'))) return { success: false, error: 'Missing "tabs" permission.' };
      return { success: true, value: sender.tab };
   }

   async handleGetTabs() {
      if (!(await this.#hasPermission('tabs'))) return { success: false, error: 'Missing "tabs" permission.' };
      try {
         return { success: true, value: await browser.tabs.query({}) };
      } catch (err) {
         logger.error(CONTEXT, 'Failed to query tabs:', err);
         return { success: false, error: err.message };
      }
   }

   async handleCloseTab({ tabId }, sender) {
      if (!(await this.#hasPermission('tabs'))) return { success: false, error: 'Missing "tabs" permission.' };
      const tabIdToClose = tabId ?? sender.tab?.id;
      if (!tabIdToClose) return { success: false, error: 'Could not determine which tab to close.' };
      try {
         await browser.tabs.remove(tabIdToClose);
         return { success: true };
      } catch (err) {
         logger.error(CONTEXT, `Failed to close tab ${tabIdToClose}:`, err);
         return { success: false, error: err.message };
      }
   }

   async handleOpenInTab({ url, active, insert }, sender) {
      try {
         const options = { url, active };
         if (insert && sender?.tab?.index !== undefined) {
            options.index = sender.tab.index + 1;
         }
         await browser.tabs.create(options);
         return { success: true };
      } catch (err) {
         logger.error(CONTEXT, `Failed to open URL "${url}":`, err);
         return { success: false, error: err.message };
      }
   }
}

// WARNING: Exported as a singleton default instance. Do not re-instantiate ApiHandler.
export default new ApiHandler();
