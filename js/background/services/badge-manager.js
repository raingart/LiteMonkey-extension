import browser from '../../libs/browser-support.js';
import ScriptRegistry from './script-registry.js';
import { logger } from '../../libs/logger.js';
import { isRestrictedUrl, DEFAULT_SETTINGS } from '../../constants.js';

const CONTEXT = 'BadgeManager';

/**
 * In-memory cache for extension settings.
 * Caching settings avoids asynchronous `browser.storage.sync` reads on every tab activation or URL update.
 * @type {Object|null}
 */
let settingsCache = null;
let settingsPromise = null;

const loadAndCacheSettings = async () => {
   if (settingsCache) return settingsCache;
   if (!settingsPromise) {
      settingsPromise = browser.storage.sync.get({ extension_settings: DEFAULT_SETTINGS })
         .then(({ extension_settings }) => {
            settingsCache = { ...DEFAULT_SETTINGS, ...extension_settings };
            settingsPromise = null;
            return settingsCache;
         });
   }
   return settingsPromise;
};

/**
 * Clears the extension action badge text for a specific browser tab.
 * @param {number} tabId - Target tab ID.
 * @returns {Promise<void>}
 */
const clearBadge = (tabId) => {
   return browser.action.setBadgeText({ tabId, text: '' });
};

/**
 * Sets the extension action badge count and background color for a specific browser tab.
 * @param {number} tabId - Target tab ID.
 * @param {number} count - Active script count number.
 * @returns {Promise<void>}
 */
const setBadge = async (tabId, count) => {
   await loadAndCacheSettings();
   await browser.action.setBadgeText({ tabId, text: String(count) });
   await browser.action.setBadgeBackgroundColor({ tabId, color: settingsCache.badgeColor });
};

/**
 * Sets the extension action badge to OFF with a neutral gray background when paused.
 * @param {number} tabId - Target tab ID.
 * @returns {Promise<void>}
 */
const setPausedBadge = async (tabId) => {
   await browser.action.setBadgeText({ tabId, text: 'OFF' });
   await browser.action.setBadgeBackgroundColor({ tabId, color: '#757575' });
};

/**
 * Computes active script count for a tab's URL and updates the browser action badge.
 * @param {number} tabId - Unique ID of tab to update.
 * @returns {Promise<void>}
 */
const updateBadgeForTab = async (tabId) => {
   await loadAndCacheSettings();

   if (!settingsCache.showBadgeCount) {
      return clearBadge(tabId);
   }

   try {
      const tab = await browser.tabs.get(tabId);

      // Clear badge for internal/privileged browser URLs where userscripts cannot execute
      if (!tab?.url || isRestrictedUrl(tab.url)) {
         return clearBadge(tabId);
      }

      const { scripts = [], isPaused = false } = await ScriptRegistry.getActiveScriptsForUrl(tab.url);

      if (isPaused) {
         return setPausedBadge(tabId);
      }

      const scriptCount = scripts.filter((script) => script.type !== 'userstyle').length;

      if (scriptCount > 0) {
         await setBadge(tabId, scriptCount);
      } else {
         await clearBadge(tabId);
      }
   } catch (error) {
      logger.debug(CONTEXT, `Could not update badge for tab ${tabId}: ${error.message}`);
      // Silently catch rejections if tab was closed before async tab lookups finished
      await clearBadge(tabId).catch(() => { /* Tab is gone, do nothing. */ });
   }
};

/**
 * Recalculates and updates the badge for all currently open browser tabs.
 * Useful when global pause state changes.
 * @returns {Promise<void>}
 */
const updateBadgeForAllTabs = async () => {
   try {
      const tabs = await browser.tabs.query({});
      await Promise.all(tabs.map((tab) => updateBadgeForTab(tab.id)));
   } catch (error) {
      logger.debug(CONTEXT, `Failed to update badges for all tabs: ${error.message}`);
   }
};

/**
 * Manages browser action icon badges displaying active userscript counts per tab.
 */
const BadgeManager = {
   /**
    * Initializes tab event listeners and storage change observers for badge management.
    */
   initialize() {
      // Pre-load settings into RAM cache without blocking event listener registration
      loadAndCacheSettings();

      browser.tabs.onActivated.addListener(({ tabId }) => updateBadgeForTab(tabId));

      // Clear stale badge immediately when tab starts loading, then recalculate when complete
      browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
         if (changeInfo.status === 'loading') {
            clearBadge(tabId).catch(() => {});
         } else if (changeInfo.status === 'complete' || changeInfo.url) {
            // Trigger badge updates on SPA navigations (changeInfo.url present without status complete)
            updateBadgeForTab(tabId);
         }
      });

      // Update in-memory settings cache when user updates extension options
      browser.storage.onChanged.addListener((changes, areaName) => {
         if (areaName === 'sync' && changes.extension_settings) {
            logger.debug(CONTEXT, 'Settings changed, reloading cache.');
            settingsCache = null;
            loadAndCacheSettings();
         }
      });

      logger.debug(CONTEXT, 'Initialized.');
   },

   updateBadgeForTab,
   updateBadgeForAllTabs,
};

// WARNING: Exported as a default object (`BadgeManager`). Retain default import syntax in consumers.
export default BadgeManager;
