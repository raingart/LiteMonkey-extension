import browser from '../../libs/browser-support.js';
import { logger } from '../../libs/logger.js';

const CONTEXT = 'LogManager';
const LOG_LIMIT_PER_SCRIPT = 100; // Maximum log entries retained per script per tab
const _tabLogLocks = new Map();
const _logRateTracker = new Map(); // Rate tracker map: tabId -> { count, resetTime }
const MAX_LOGS_PER_SECOND = 50; // Hard safety cap per tab
/** Debounce write timers to batch storage session updates */
const _tabWriteDebounceTimers = new Map();

/**
 * In-memory map tracking recent error timestamps per tab/script pair.
 * Map Key: `${tabId}_${scriptId}` -> Value: Array of timestamp numbers.
 * @type {Map<string, Array<number>>}
 */
const _errorSpamTracker = new Map();

// Module-scoped in-memory cache declaration to fix ReferenceError
const _inMemoryTabLogs = new Map();

/**
 * Handles storage, retrieval, and diagnostics of userscript execution logs.
 * Logs are stored in `browser.storage.session` scoped to the current browser session.
 */
const LogManager = {
   /**
    * Registers event listeners to clear tab logs and error tracking data when tabs close.
    */
   initialize() {
      browser.tabs.onRemoved.addListener((tabId) => {
         this.clearLogsForTab(tabId);
         _tabLogLocks.delete(tabId); // Purge lock queue on tab close
         _logRateTracker.delete(tabId); // Clean up rate limits on tab close
         _inMemoryTabLogs.delete(tabId);
         for (const key of _errorSpamTracker.keys()) { // Purge error tracker entries for the closed tab to prevent memory leaks
            if (key.startsWith(`${tabId}_`)) {
               _errorSpamTracker.delete(key);
            }
         }
      });

      // Purge accumulated logs on top-level frame navigation
      browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
         if (changeInfo.status === 'loading' && changeInfo.url) {
            this.clearLogsForTab(tabId);
         }
      });

      logger.debug(CONTEXT, 'Initialized');
   },

   /**
    * Builds a session storage key for a specific tab ID.
    * @private
    * @param {number} tabId - Target tab ID.
    * @returns {string} Storage key string.
    */
   _getStorageKey: (tabId) => `tab_logs_${tabId}`,

   /**
    * Retrieves all log entries for a tab from session storage.
    * @private
    * @param {number} tabId - Target tab ID.
    * @returns {Promise<Object>} Map of script IDs to log entry arrays.
    */
   async _getLogsForTab(tabId) {
      if (!tabId) return {};
      // Return synchronous in-memory logs to eliminate debounced read race condition
      if (_inMemoryTabLogs.has(tabId)) {
         return _inMemoryTabLogs.get(tabId);
      }
      const key = this._getStorageKey(tabId);
      const data = await browser.storage.session.get(key);
      const logs = data[key] || {};
      _inMemoryTabLogs.set(tabId, logs);
      return logs;
   },

   /**
    * Executes an asynchronous logging operation sequentially per tab ID
    */
   _withTabLock(tabId, action) {
      const prevPromise = _tabLogLocks.get(tabId) || Promise.resolve();
      const newPromise = prevPromise.then(async () => {
         try {
            return await action();
         } catch (err) {
            logger.error(CONTEXT, `Tab log write error for tab ${tabId}:`, err);
         }
      });
      _tabLogLocks.set(tabId, newPromise);
      return newPromise;
   },

   /**
    * Adds a log entry for a script within a tab, enforcing buffer size limits and error loop detection.
    * @param {number} tabId - Target tab ID.
    * @param {number} scriptId - Database ID of script.
    * @param {Object} logEntry - Structured log message object.
    * @returns {Promise<void>}
    */
   async addLog(tabId, scriptId, logEntry) {
      if (!tabId || !scriptId) return;

      // High-frequency log spam rate limiter to protect SW RAM from Promise chain OOM
      const now = Date.now();
      let rate = _logRateTracker.get(tabId);
      if (!rate || now - rate.resetTime > 1000) {
         rate = { count: 0, resetTime: now };
         _logRateTracker.set(tabId, rate);
      }

      rate.count++;
      if (rate.count > MAX_LOGS_PER_SECOND) {
         if (rate.count === MAX_LOGS_PER_SECOND + 1) {
            // Replace 51st log with a rate limit warning entry
            logEntry = {
               level: 'warn',
               message: `[LogManager] Rate limit exceeded (>50 logs/sec). Suppressing log spam for tab ${tabId}.`,
               timestamp: new Date().toISOString(),
               stack: '',
            };
         } else {
            return; // Drop excess log spam silently
         }
      }

      // Truncate log payloads to prevent sessionStorage 1MB quota exhaustion
      const safeLogEntry = {
         ...logEntry,
         message: String(logEntry.message || '').substring(0, 500),
         stack: String(logEntry.stack || '').substring(0, 500),
      };

      // Enforce serialized execution queue to eliminate Read-Modify-Write races
      return this._withTabLock(tabId, async () => {
         const tabLogs = await this._getLogsForTab(tabId);
         const scriptLogs = tabLogs[scriptId] || [];

         scriptLogs.push(safeLogEntry);

         // FIFO ring-buffer eviction: cap retained log count to prevent session storage quota exhaustion
         if (scriptLogs.length > LOG_LIMIT_PER_SCRIPT) {
            scriptLogs.shift();
         }

         tabLogs[scriptId] = scriptLogs;
         _inMemoryTabLogs.set(tabId, tabLogs);

         // Debounce storage write (400ms) to eliminate I/O thrashing and quota exhaustion
         if (_tabWriteDebounceTimers.has(tabId)) {
            clearTimeout(_tabWriteDebounceTimers.get(tabId));
         }

         _tabWriteDebounceTimers.set(
            tabId,
            setTimeout(() => {
               _tabWriteDebounceTimers.delete(tabId);
               browser.storage.session.set({ [this._getStorageKey(tabId)]: tabLogs }).catch(() => { });
            }, 400)
         );

         // Error loop diagnostic: detect infinite console error loops in userscripts
         if (safeLogEntry.level === 'error') {
            const trackerKey = `${tabId}_${scriptId}`;
            const now = Date.now();
            const errorTimes = _errorSpamTracker.get(trackerKey) || [];

            // Retain error timestamps within a sliding 5-second (5000ms) window
            const recentErrors = [...errorTimes.filter((t) => now - t < 5000), now];
            _errorSpamTracker.set(trackerKey, recentErrors);

            // Flag script as unstable in session storage if 10+ errors occur within 5 seconds
            if (recentErrors.length >= 10) {
               logger.warn(CONTEXT, `Performance warning: Script ${scriptId} on tab ${tabId} is flooding errors!`);

               const sessionKey = `unstable_${tabId}_${scriptId}`;
               await browser.storage.session.set({ [sessionKey]: true });
            }
         }
      });
   },

   /**
    * Returns all logs for a tab.
    * @param {number} tabId - Target tab ID.
    * @returns {Promise<Object>} Object dictionary containing script logs.
    */
   async getLogs(tabId) {
      return this._getLogsForTab(tabId);
   },

   /**
    * Deletes logs for a specific script in a tab.
    * @param {number} tabId - Target tab ID.
    * @param {number} scriptId - Database ID of script.
    * @returns {Promise<void>}
    */
   async clearLogsForScript(tabId, scriptId) {
      if (!tabId || !scriptId) return;

      return this._withTabLock(tabId, async () => {
         // Cancel pending write debounce timer to prevent resurrecting deleted logs
         if (_tabWriteDebounceTimers.has(tabId)) {
            clearTimeout(_tabWriteDebounceTimers.get(tabId));
            _tabWriteDebounceTimers.delete(tabId);
         }

         const tabLogs = await this._getLogsForTab(tabId);
         if (!tabLogs[scriptId]) return;

         delete tabLogs[scriptId];
         _inMemoryTabLogs.set(tabId, tabLogs);
         await browser.storage.session.set({ [this._getStorageKey(tabId)]: tabLogs });
         logger.debug(CONTEXT, `Cleared logs for script ${scriptId} on tab ${tabId}`);
      });
   },

   /**
    * Deletes all session logs for a tab.
    * Called automatically when the tab closes or navigates to a new URL.
    * @param {number} tabId - Target tab ID.
    * @returns {Promise<void>}
    */
   async clearLogsForTab(tabId) {
      if (!tabId) return;
      // Cancel active write debounce timer to prevent resurrecting stale logs
      if (_tabWriteDebounceTimers.has(tabId)) {
         clearTimeout(_tabWriteDebounceTimers.get(tabId));
         _tabWriteDebounceTimers.delete(tabId);
      }
      _inMemoryTabLogs.delete(tabId);
      await browser.storage.session.remove(this._getStorageKey(tabId));
      logger.debug(CONTEXT, `Cleared logs for tab ${tabId}`);
   },
};

// WARNING: Exported as a default object (`LogManager`). Retain default import syntax in consumers.
export default LogManager;
