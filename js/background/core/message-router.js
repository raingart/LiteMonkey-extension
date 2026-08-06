import browser from '../../libs/browser-support.js';
import { MSG } from '../../message-types.js';
import { agents } from '../../database.js';
import { ErrorCollector } from '../../libs/error-collector.js';
import ScriptRegistry from '../services/script-registry.js';
import CacheManager from '../services/cache-manager.js';
import ApiHandler from '../services/gm-api-handler.js';
import LogManager from '../services/log-manager.js';
import UpdateService from '../services/update-service.js';
import GDriveService from '../services/gdrive-service.js';
import UpdateScheduler from '../services/update-scheduler.js';
import BadgeManager from '../services/badge-manager.js';
import LockManager from './lock-manager.js';
import Utils from '../utils.js';
import { logger } from '../../libs/logger.js';
import { isRestrictedUrl } from '../../constants.js';

const CONTEXT = 'MessageRouter';

/**
 * Sentinel symbol indicating that no explicit payload response should be sent back to the caller.
 * @type {symbol}
 */
const FIRE_AND_FORGET = Symbol('fire-and-forget');

/**
 * Messages allowed to be processed from external contexts (content scripts/external tabs).
 * @type {Set<string>}
 */
const ALLOWED_EXTERNAL_MESSAGES = new Set([
   MSG.GET_TAB_SCRIPTS,
   MSG.EXECUTE_SCRIPT_IN_TAB,
   MSG.GET_LOG_LEVEL,
   MSG.LOG_MESSAGE,
   MSG.CLEAR_LOGS_FOR_SCRIPT_IN_TAB,
]);

// Messages originating prior to script token generation (bootstrap calls)
const UNTOKENIZED_TAB_MESSAGES = new Set([
   MSG.GET_TAB_SCRIPTS,
   MSG.GET_LOG_LEVEL,
   MSG.EXECUTE_SCRIPT_IN_TAB,
]);

/**
 * Decorator that acquires an execution lock before executing an action.
 *
 * @param {Function} action The async function to execute.
 * @returns {Function} A function executing the action within a lock context.
 */
const withLock = (action) => (...args) => LockManager.withLock(() => action(...args));

/**
 * Decorator for script-mutating operations. Ensures that after a successful
 * execution, the script cache in RAM is refreshed.
 *
 * @param {Function} action The async function to execute.
 * @returns {Function} An async function executing the action and refreshing cache on success.
 */
const withCacheRefresh = (action) => async (...args) => {
   const result = await action(...args);
   if (result?.success) {
      await CacheManager.refresh();
   }
   return result;
};

/**
 * Composes the withLock and withCacheRefresh decorators.
 *
 * @param {Function} action The async function to execute.
 * @returns {Function} A function executing within a lock and refreshing cache on success.
 */
const withLockAndRefresh = (action) => withLock(withCacheRefresh(action));

/**
 * Map of message types to their corresponding request handler functions.
 * Using a routing table avoids large switch statements and modularizes route execution.
 */
const requestHandlers = {
   // --- Script Read Operations ---
   [MSG.GET_ALL_SCRIPTS]: async () => ({
      scripts: (await CacheManager.get()).map(({ userCode, ...rest }) => rest),
   }),
   [MSG.GET_ALL_SCRIPTS_WITH_CODE]: () => agents.getAllFullScripts().then((scripts) => ({ scripts })),
   [MSG.GET_SCRIPT_WITH_CODE]: ({ scriptId }) => agents.getFullScript(scriptId).then((script) => ({ script })),

   // Await injection execution and token persistence before returning response
   [MSG.EXECUTE_SCRIPT_IN_TAB]: async ({ scriptId, target, injectionContext = {} }, sender) => {
      injectionContext.url = sender.url || sender.tab?.url;
      await ScriptRegistry.executeScriptInTab(scriptId, target, injectionContext);
      return { success: true };
   },
   [MSG.GET_TAB_SCRIPTS]: ({ url }, sender) => ScriptRegistry.getActiveScriptsForBootstrap(url, sender),
   [MSG.GET_APPLICABLE_SCRIPTS]: (payload, sender) => ScriptRegistry.getApplicableScriptsForURL(payload?.url, sender, payload),
   [MSG.CHECK_PERMISSIONS_FOR_SCRIPT]: ({ scriptObject }) => Utils.handlePermissionCheck(scriptObject),
   [MSG.CHECK_SCRIPT_EXISTS]: async ({ name, namespace }) => ({
      existingScript: await ScriptRegistry.findExistingScript(name, namespace),
   }),
   [MSG.OPEN_SCRIPT_IN_EDITOR]: async ({ scriptId }) => {
      if (typeof scriptId !== 'number') return { success: false, error: 'Invalid scriptId' };

      const optionsPageUrl = browser.runtime.getURL('html/options.html');
      const targetUrl = `${optionsPageUrl}?scriptId=${scriptId}`;
      const [existingTab] = await browser.tabs.query({ url: `${optionsPageUrl}*` });

      if (existingTab) {
         await browser.tabs.update(existingTab.id, { active: true, url: targetUrl });
         await browser.windows.update(existingTab.windowId, { focused: true });
      } else {
         await browser.tabs.create({ url: targetUrl });
      }
      return { success: true };
   },

   // --- Script Write Operations (locked and cache-refreshed) ---
   [MSG.INSTALL_SCRIPT_FROM_URL]: withLockAndRefresh((payload) => ScriptRegistry.installScript(payload)),
   [MSG.SAVE_SCRIPT]: withLockAndRefresh(({ scriptObject }) => ScriptRegistry.createOrUpdateFromSource(scriptObject)),
   [MSG.DELETE_SCRIPT]: withLockAndRefresh(({ scriptId }) => ScriptRegistry.delete(scriptId)),
   [MSG.UPDATE_SCRIPT_PROPS]: withLockAndRefresh(({ scriptId, props }) => ScriptRegistry.updateScriptProperties(scriptId, props)),
   [MSG.REORDER_SCRIPTS]: withLockAndRefresh(async ({ scripts }) => {
      const updates = scripts.map(s => ({ id: s.id, position: s.position }));
      await agents.updatePositions(updates);
      return { success: true };
   }),
   [MSG.IMPORT_SCRIPTS]: withLockAndRefresh(({ scripts }) => ScriptRegistry.importScripts(scripts)),
   [MSG.DELETE_ALL_SCRIPTS]: withLockAndRefresh(async () => {
      await agents.clearAll();
      return { success: true };
   }),
   [MSG.SET_SCRIPT_STORAGE]: withLock(async ({ scriptId, storageObject }) => {
      await agents.setFullStorage(scriptId, storageObject);
      return { success: true };
   }),

   // --- GM API ---
   // Registered batch storage endpoint in message routing dictionary
   [MSG.GM_GET_FULL_STORAGE]: (payload) => ApiHandler.getFullStorage(payload),
   [MSG.GM_LIST_VALUES]: (payload) => ApiHandler.listGmValues(payload),
   [MSG.GM_GET_VALUE]: (payload) => ApiHandler.getGmValue(payload),
   [MSG.GM_SET_VALUE]: async (payload, sender) => {
      const result = await ApiHandler.setGmValue(payload, sender);
      if (result.success && result.changed) {
         MessageRouter.broadcastValueChange({
            scriptId: payload.scriptId,
            key: payload.key,
            oldValue: result.oldValue,
            newValue: result.newValue,
            remote: true,
            originatingTabId: sender.tab?.id,
         });
      }
      return { success: result.success, error: result.error };
   },
   [MSG.GM_DELETE_VALUE]: async (payload, sender) => {
      const result = await ApiHandler.deleteGmValue(payload, sender);
      if (result.success && result.changed) {
         MessageRouter.broadcastValueChange({
            scriptId: payload.scriptId,
            key: payload.key,
            oldValue: result.oldValue,
            newValue: undefined,
            remote: true,
            originatingTabId: sender.tab?.id,
         });
      }
      return { success: result.success, error: result.error };
   },
   [MSG.GM_REGISTER_MENU_COMMAND]: (payload, sender) => ApiHandler.registerMenuCommand(payload, sender),
   [MSG.GM_UNREGISTER_MENU_COMMAND]: (payload, sender) => ApiHandler.unregisterMenuCommand(payload, sender),
   [MSG.GM_GET_RESOURCE_TEXT]: (payload) => ApiHandler.getResourceText(payload),
   [MSG.GM_GET_RESOURCE_URL]: (payload) => ApiHandler.getResourceUrl(payload),
   [MSG.GM_XMLHTTPREQUEST]: (payload, sender) => ApiHandler.handleXmlHttpRequest(payload, sender),
   [MSG.GM_XMLHTTPREQUEST_ABORT]: (payload) => ApiHandler.handleXmlHttpRequestAbort(payload),

   // Transit route: Receives offscreen document events and forwards them to the target tab
   [MSG.GM_XMLHTTPREQUEST_CALLBACK]: ({ tabId, frameId, scriptId, requestId, eventType, response }) => {
      browser.tabs.sendMessage(tabId, {
         type: MSG.GM_XMLHTTPREQUEST_CALLBACK,
         payload: { scriptId, requestId, eventType, response },
      }, { frameId }).catch(() => {
         // Ignore errors if target tab was closed or unreachable
      });
      return FIRE_AND_FORGET;
   },
   [MSG.GM_SET_CLIPBOARD]: (payload) => ApiHandler.handleSetClipboard(payload),
   [MSG.GM_DOWNLOAD]: (payload, sender) => ApiHandler.handleDownload(payload, sender),
   [MSG.GM_NOTIFICATION]: (payload, sender) => ApiHandler.handleNotification(payload, sender),
   [MSG.GM_OPEN_IN_TAB]: (payload, sender) => ApiHandler.handleOpenInTab(payload, sender),
   [MSG.GM_GET_TAB]: (_, sender) => ApiHandler.handleGetTab(sender),
   [MSG.GM_GET_TABS]: () => ApiHandler.handleGetTabs(),
   [MSG.GM_CLOSE_TAB]: (payload, sender) => ApiHandler.handleCloseTab(payload, sender),
   [MSG.EXECUTE_MENU_COMMAND]: (payload) => ApiHandler.executeMenuCommand(payload),
   [MSG.GM_COOKIE_LIST]: (payload, sender) => ApiHandler.handleCookieList(payload, sender),
   [MSG.GM_COOKIE_SET]: (payload, sender) => ApiHandler.handleCookieSet(payload, sender),
   [MSG.GM_COOKIE_DELETE]: (payload, sender) => ApiHandler.handleCookieDelete(payload, sender),
   [MSG.GM_ON_TAB_CLOSE_SUBSCRIBE]: (_, sender) => {
      ApiHandler.handleOnTabCloseSubscribe(sender);
      return FIRE_AND_FORGET;
   },

   // --- Google Drive REST API ---
   [MSG.GDRIVE_GET_STATUS]: withLock(async (payload) => {
      const isInteractive = Boolean(payload?.interactive);
      const statusMap = await GDriveService.getSyncStatuses(isInteractive);
      return { success: true, statuses: Array.from(statusMap.entries()) };
   }),
   [MSG.GDRIVE_UPLOAD]: withLock(async ({ scriptId }) => {
      const cloudFileId = await GDriveService.uploadScript(scriptId);
      return { success: true, cloudFileId };
   }),
   [MSG.GDRIVE_DOWNLOAD]: withLockAndRefresh(async ({ cloudFileId }) => {
      await GDriveService.downloadScript(cloudFileId);
      return { success: true };
   }),
   [MSG.GDRIVE_DELETE_CLOUD]: withLock(async ({ cloudFileId }) => {
      await GDriveService.deleteCloudFile(cloudFileId);
      return { success: true };
   }),

   // --- Extension Management ---
   [MSG.CHECK_SCRIPTS_UPDATES]: withLock(async () => {
      const result = await UpdateService.checkForUpdates();
      // Refresh RAM cache if scripts were updated or update errors occurred
      if (result && (result.updated > 0 || result.failed > 0)) {
         await CacheManager.refresh();
      }
      return result;
   }),
   [MSG.GET_PAUSE_STATE]: () => browser.storage.session.get({ isPaused: false }),
   [MSG.SET_PAUSE_STATE]: async ({ isPaused }) => {
      await browser.storage.session.set({ isPaused });
      await BadgeManager.updateBadgeForAllTabs();
      return { success: true };
   },
   [MSG.SETTINGS_UPDATED]: async () => {
      await UpdateScheduler.scheduleUpdateCheck();
      return { success: true };
   },
   [MSG.PING]: () => ({ success: true, status: 'pong' }),

   // --- Logging ---
   [MSG.GET_LOGS_FOR_TAB]: async ({ tabId }) => ({ logs: await LogManager.getLogs(tabId) }),
   [MSG.GET_LOG_LEVEL]: () => browser.storage.local.get({ logLevel: 3 }),
   [MSG.LOG_MESSAGE]: ({ scriptId, log }, sender) => {
      LogManager.addLog(sender.tab?.id, scriptId, log);
      return FIRE_AND_FORGET;
   },
   [MSG.CLEAR_LOGS_FOR_SCRIPT_IN_TAB]: ({ scriptId }, sender) => {
      LogManager.clearLogsForScript(sender.tab?.id, scriptId);
      return FIRE_AND_FORGET;
   },
};

/**
 * Central message router for the extension background service worker.
 * Receives all messages from content scripts and extension UI pages, delegating
 * execution to domain services.
 */
const MessageRouter = {
   /**
    * Registers extension runtime listeners and logs initial startup.
    */
   initialize() {
      browser.runtime.onMessage.addListener(this.handleMessage.bind(this));
      browser.storage.onChanged.addListener(this.handleStorageChange.bind(this));
      logger.debug(CONTEXT, 'Initialized');
   },

   /**
    * Handles all incoming messages and routes them to the appropriate handler.
    *
    * ==========================================================================
    * CRITICAL ARCHITECTURAL NOTE: DO NOT CONVERT THIS FUNCTION TO `async`.
    * ==========================================================================
    *
    * The Chrome Extension `runtime.onMessage` API has specific requirements for
    * handling asynchronous responses. This function MUST follow the classic
    * callback pattern:
    *
    * 1. It must NOT be an `async` function.
    * 2. It MUST return `true` synchronously to signal that the response will be
    *    sent asynchronously.
    * 3. The `sendResponse` callback must be called exactly once when the async
    *    operation is complete.
    *
    * Attempting to convert this to an `async` function will break the message
    * channel in many cases, causing the caller to receive `undefined` as a response.
    * This is a known, previously encountered issue.
    *
    * @param {object} message The message object from the sender.
    * @param {browser.runtime.MessageSender} sender The sender of the message.
    * @param {function(any): void} sendResponse The callback to send a response.
    * @returns {boolean} Returns `true` to indicate an asynchronous response.
    */
   handleMessage(message, sender, sendResponse) {
      const { type, payload, pageToken } = message ?? {};
      if (!type) {
         logger.warn(CONTEXT, 'Received invalid message (no type).', { message, sender });
         return false; // No async response needed.
      }

      logger.debug(CONTEXT, '◀️ RX', { type, from: sender.tab?.id ?? 'popup/options' });

      const isSensitiveApi = type.startsWith('gm-');

      // Determine if request originates from extension internal pages (options, popup, installer)
      const isFromExtensionPage = Boolean(sender.url && sender.url.startsWith(browser.runtime.getURL('')));

      if (!isFromExtensionPage) {
         const isAllowedGeneric = ALLOWED_EXTERNAL_MESSAGES.has(type);
         if (!isAllowedGeneric && !isSensitiveApi) {
            logger.error(CONTEXT, `Blocked unauthorized background message "${type}" from external tab.`);
            sendResponse({ success: false, error: 'Unauthorized access. Command rejected.' });
            return false;
         }
      }

      // Safe wrapper to prevent unhandled exceptions when sender tab/popup is closed early
      const safeSendResponse = (data) => {
         try {
            sendResponse(data);
         } catch (err) {
            logger.debug(CONTEXT, `Cannot send response for "${type}", port already closed.`);
         }
      };

      const executeHandler = () => {
         const handler = requestHandlers[type];
         if (!handler) {
            const error = `Unknown message type: ${type}`;
            logger.error(CONTEXT, error);
            safeSendResponse({ success: false, error });
            return;
         }

         Promise.resolve(handler(payload ?? {}, sender))
            .then((response) => {
               // Guarantee closing Chrome IPC ports for "fire and forget" messages
               if (response !== FIRE_AND_FORGET) {
                  safeSendResponse(response);
               } else {
                  safeSendResponse({ success: true });
               }
            })
            .catch((error) => {
               const errorMsg = error?.message ?? String(error);
               logger.error(CONTEXT, `Error handling message "${type}":`, error);
               ErrorCollector.captureAndReport(error, { trace_name: 'MessageRouter.handleMessage', type });
               safeSendResponse({ success: false, error: errorMsg });
            });
      };

      // Comprehensive token validation for all tab requests associated with a script context
      if (sender.tab && !isFromExtensionPage) {
         const isUntokenized = UNTOKENIZED_TAB_MESSAGES.has(type);
         // WARNING: Validate security token specifically for external userscript API calls
         const requiresTokenCheck = !isUntokenized && (
            isSensitiveApi ||
            Boolean(payload?.scriptId) ||
            type === MSG.LOG_MESSAGE ||
            type === MSG.CLEAR_LOGS_FOR_SCRIPT_IN_TAB
         );

         if (requiresTokenCheck) {
            const scriptId = payload?.scriptId;
            const tabId = sender.tab.id;
            const frameId = sender.frameId || 0;
            const sessionKey = `token_${tabId}_${frameId}_${scriptId}`;

            // Safe cross-platform token retrieval (supporting legacy environments and Firefox fallbacks)
            const getSessionToken = async () => {
               // Check in-memory SW RAM cache first (0ms latency, no storage races)
               if (globalThis.__litemonkey_tokens?.[sessionKey]) {
                  return globalThis.__litemonkey_tokens[sessionKey];
               }

               if (browser.storage?.session) {
                  try {
                     const data = await browser.storage.session.get(sessionKey);
                     if (data?.[sessionKey]) return data[sessionKey];
                  } catch (e) {
                     logger.warn(CONTEXT, 'Failed to read from browser.storage.session, using fallback.', e);
                  }
               }

               if (browser.storage?.local) {
                  try {
                     const localData = await browser.storage.local.get(sessionKey);
                     if (localData?.[sessionKey]) return localData[sessionKey];
                  } catch (e) {
                     logger.warn(CONTEXT, 'Failed to read from browser.storage.local fallback.', e);
                  }
               }

               return globalThis.__litemonkey_tokens?.[sessionKey];
            };

            getSessionToken()
               .then((expectedToken) => {
                  if (!expectedToken || expectedToken !== pageToken) {
                     logger.error(CONTEXT, `Blocked unauthorized message "${type}" from tab ${tabId}. Token mismatch or missing.`);
                     sendResponse({ success: false, error: 'Unauthorized access. Token mismatch or missing.' });
                     return;
                  }
                  executeHandler();
               })
               .catch((err) => {
                  logger.error(CONTEXT, 'Verification system error:', err);
                  sendResponse({ success: false, error: 'Verification system error.' });
               });
            return true;
         }
      }

      executeHandler();
      return true; // Keep message channel open for async response
   },

   /**
    * Listens for changes in extension storage and broadcasts events if needed.
    *
    * @param {object} changes Map of changed storage keys.
    * @param {string} areaName Storage area ('local', 'session', or 'sync').
    */
   async handleStorageChange(changes, areaName) {
      if (areaName === 'local' && changes.logLevel) {
         await this._broadcastToAllTabs({
            type: MSG.EVENT_LOG_LEVEL_UPDATE,
            payload: { logLevel: changes.logLevel.newValue },
         });
      }
   },

   /**
    * Broadcasts GM value updates to all open tabs except the originating tab.
    *
    * @param {object} payload Details of the changed GM value.
    */
   async broadcastValueChange(payload) {
      logger.debug(CONTEXT, `Broadcasting value change for script ${payload.scriptId}`);
      await this._broadcastToAllTabs(
         {
            type: MSG.EVENT_VALUE_CHANGED,
            payload,
         },
         { excludeTabId: payload.originatingTabId },
      );
   },

   /**
    * Dispatches a runtime message to all open tabs.
    *
    * @param {object} message Message payload to send.
    * @param {object} [options] Options for broadcasting.
    * @param {number} [options.excludeTabId] Tab ID to exclude from broadcast.
    * @private
    */
   async _broadcastToAllTabs(message, { excludeTabId } = {}) {
      try {
         const tabs = await browser.tabs.query({});
         const messagePromises = tabs
            // Filter out unscriptable browser system URLs before attempting message transmission
            .filter((tab) => tab?.id && tab.id !== excludeTabId && !isRestrictedUrl(tab.url))
            .map((tab) =>
               browser.tabs.sendMessage(tab.id, message).catch(() => {
                  // Ignore errors for tabs that closed mid-broadcast
               }),
            );
         await Promise.all(messagePromises);
      } catch (err) {
         logger.debug(CONTEXT, 'Broadcast to tabs failed:', err);
      }
   },
};

export default MessageRouter;
