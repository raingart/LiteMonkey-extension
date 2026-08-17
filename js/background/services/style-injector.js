import browser from '../../libs/browser-support.js';
import { agents } from '../../database.js';
import Utils from '../utils.js';
import CacheManager from './cache-manager.js';
import { logger } from '../../libs/logger.js';
import { isRestrictedUrl } from '../../constants.js';

const CONTEXT = 'StyleInjector';

/** @type {Map<number, Map<number, string>>} Injected top-frame CSS per tab: styleId → css text (for removeCSS) */
const _injectedTopCss = new Map();
/** @type {Set<number>} Tabs that already received a subframe CSS pass for the current navigation */
const _subframesInjected = new Set();
/** @type {Set<number>} Tabs with a pending delayed subframe retry */
const _subframeRetryScheduled = new Set();

/**
 * Injects userstyle (`.css`) scripts into web pages.
 * Listens for tab updates, finds applicable styles from the cache,
 * and injects them efficiently per tab.
 */
const StyleInjector = {
   /**
    * Subscribes to tab update and removal events.
    */
   initialize() {
      browser.tabs.onUpdated.addListener((...args) => this.onTabUpdated(...args));
      browser.tabs.onRemoved.addListener((tabId) => {
         _injectedTopCss.delete(tabId);
         _subframesInjected.delete(tabId);
         _subframeRetryScheduled.delete(tabId);
      });
      logger.debug(CONTEXT, 'Initialized');
   },

   /**
    * Handles tab updates and coordinates style injection.
    * @param {number} tabId - The ID of the updated tab.
    * @param {Object} changeInfo - An object containing details about the update.
    * @param {Object} tab - The full WebExtension Tab object.
    * @returns {Promise<void>}
    */
   async onTabUpdated(tabId, changeInfo, tab) {
      const url = changeInfo.url || tab.url;
      const status = changeInfo.status;

      if (!url || isRestrictedUrl(url)) return;

      // Full document navigation: drop per-tab injection bookkeeping.
      if (changeInfo.status === 'loading' && changeInfo.url) {
         _injectedTopCss.delete(tabId);
         _subframesInjected.delete(tabId);
         _subframeRetryScheduled.delete(tabId);
      }

      if (status !== 'loading' && status !== 'complete' && !changeInfo.url) return;

      try {
         const { isPaused = false } = await browser.storage.session.get('isPaused');
         if (isPaused) return;

         await this.syncTopFrame(tabId, url);

         // complete and SPA url changes: inject into iframes. SPA clears the one-shot
         // flag so newly matching iframe styles apply after History API navigations.
         if (changeInfo.url && status !== 'loading') {
            _subframesInjected.delete(tabId);
         }

         if (status === 'loading') return;

         await this.injectSubframesIfNeeded(tabId, url);

         if (status === 'complete' && !_subframeRetryScheduled.has(tabId)) {
            _subframeRetryScheduled.add(tabId);
            setTimeout(() => {
               _subframeRetryScheduled.delete(tabId);
               _subframesInjected.delete(tabId);
               this.injectSubframesIfNeeded(tabId, url).catch((error) => this.handleInjectionError(tabId, error));
            }, 800);
         }
      } catch (error) {
         this.handleInjectionError(tabId, error);
      }
   },

   /**
    * Evaluates @-moz-document conditions against the current URL.
    * @private
    */
   _evaluateMozDocument(conditionsStr, currentUrl) {
      const rules = [...conditionsStr.matchAll(/(domain|url-prefix|url|regexp)\s*\(\s*(['"]?)(.*?)\2\s*\)/g)];
      if (!rules.length) return true;

      try {
         const urlObj = new URL(currentUrl);
         for (const rule of rules) {
            const type = rule[1];
            const value = rule[3];
            if (type === 'domain') {
               if (urlObj.hostname === value || urlObj.hostname.endsWith('.' + value)) return true;
            } else if (type === 'url-prefix') {
               if (currentUrl.startsWith(value)) return true;
            } else if (type === 'url') {
               if (currentUrl === value) return true;
            } else if (type === 'regexp') {
               if (new RegExp(value).test(currentUrl)) return true;
            }
         }
      } catch (e) {
         return false;
      }
      return false;
   },

   /**
    * Extract CSS contents using a balanced brace counter algorithm.
    * @private
    * @param {string} [userCode='']
    * @param {string} currentUrl
    * @returns {string}
    */
   extractInjectableCss(userCode = '', currentUrl) {
      const safeCode = String(userCode || '');
      if (!safeCode.includes('@-moz-document')) return safeCode;

      const blocks = [];
      // Use word boundary to match directive, then manually parse condition to support '{' inside strings/regexps
      const regex = /@-moz-document\b/gi;
      let match;
      let lastIndex = 0;
      let globalCss = '';

      while ((match = regex.exec(safeCode)) !== null) {
         // Capture any global CSS outside of @-moz-document blocks
         globalCss += safeCode.substring(lastIndex, match.index);

         let i = match.index + match[0].length;
         let conditionsStr = '';
         let inString = false;
         let stringChar = '';

         // Safely extract condition string until the opening brace
         while (i < safeCode.length) {
            const char = safeCode[i];
            if (inString) {
               if (char === '\\') {
                  conditionsStr += char;
                  i++;
                  if (i < safeCode.length) conditionsStr += safeCode[i];
                  i++;
                  continue;
               } else if (char === stringChar) {
                  inString = false;
               }
            } else {
               if (char === '"' || char === "'") {
                  inString = true;
                  stringChar = char;
               } else if (char === '{') {
                  break; // Found the actual block opening brace
               }
            }
            conditionsStr += char;
            i++;
         }

         const startIdx = i + 1;
         let braceCount = 1;
         i = startIdx;
         inString = false;
         let inComment = false;

         while (i < safeCode.length && braceCount > 0) {
            const char = safeCode[i];
            const nextChar = safeCode[i + 1];

            if (inComment) {
               if (char === '*' && nextChar === '/') { inComment = false; i++; }
            } else if (inString) {
               if (char === '\\') i++;
               else if (char === stringChar) inString = false;
            } else {
               if (char === '/' && nextChar === '*') { inComment = true; i++; }
               else if (char === '"' || char === "'") { inString = true; stringChar = char; }
               else if (char === '{') braceCount++;
               else if (char === '}') braceCount--;
            }
            i++;
         }

         if (braceCount === 0) {
            const blockCss = safeCode.substring(startIdx, i - 1).trim();
            // Only inject the CSS block if its specific domain/url rules match the current tab
            if (this._evaluateMozDocument(conditionsStr.trim(), currentUrl)) {
               blocks.push(blockCss);
            }
            lastIndex = i;
            regex.lastIndex = i; // Advance regex past the parsed block
         } else {
            break; // Malformed CSS, prevent infinite loop
         }
      }

      globalCss += safeCode.substring(lastIndex);
      return [globalCss.trim(), ...blocks].filter(Boolean).join('\n\n');
   },

   /**
    * Inserts or removes top-frame CSS so enabled matching styles match the current URL.
    * @param {number} tabId
    * @param {string} url
    */
   async syncTopFrame(tabId, url) {
      const injectedMap = _injectedTopCss.get(tabId) || new Map();
      const allStyles = await CacheManager.get();
      const matching = allStyles.filter(
         (style) => style.enabled && style.type === 'userstyle' && Utils.isRunnableOnUrl(style, url)
      );
      const matchingIds = new Set(matching.map((s) => s.id));

      for (const [styleId, css] of [...injectedMap]) {
         if (matchingIds.has(styleId)) continue;
         await this.removeCss(tabId, [0], css);
         injectedMap.delete(styleId);
      }

      for (const style of matching) {
         if (injectedMap.has(style.id)) continue;
         const full = style.userCode ? style : await agents.getFullScript(style.id);
         if (!full?.userCode) continue;
         const css = this.extractInjectableCss(full.userCode, url);
         if (!css) continue;
         await this.insertCss(tabId, [0], css);
         injectedMap.set(style.id, css);
      }

      _injectedTopCss.set(tabId, injectedMap);
   },

   /**
    * Re-syncs userstyles on all open tabs after cache mutations (enable/disable/save).
    */
   async resyncOpenTabs() {
      const tabs = await browser.tabs.query({});
      await Promise.all(tabs.map(async (tab) => {
         if (!tab?.id || !tab.url || isRestrictedUrl(tab.url)) return;
         try {
            await this.syncTopFrame(tab.id, tab.url);
            _subframesInjected.delete(tab.id);
            await this.injectSubframesIfNeeded(tab.id, tab.url);
         } catch (error) {
            this.handleInjectionError(tab.id, error);
         }
      }));
   },

   async insertCss(tabId, frameIds, css) {
      if (!css) return;
      await browser.scripting.insertCSS({
         target: { tabId, frameIds },
         css,
         origin: 'USER',
      });
   },

   async removeCss(tabId, frameIds, css) {
      if (!css) return;
      try {
         await browser.scripting.removeCSS({
            target: { tabId, frameIds },
            css,
            origin: 'USER',
         });
      } catch {
         // Frame or tab may already be gone
      }
   },

   async injectSubframesIfNeeded(tabId, url) {
      if (_subframesInjected.has(tabId)) return;
      _subframesInjected.add(tabId);

      const allStyles = await CacheManager.get();
      const enabledStyles = allStyles.filter((style) => style.enabled && style.type === 'userstyle');
      if (enabledStyles.length === 0) return;

      const fullEnabled = await Promise.all(
         enabledStyles.map((s) => (s.userCode ? s : agents.getFullScript(s.id)))
      );
      await this.injectStylesIntoSubframes(tabId, fullEnabled.filter(Boolean), url);
   },

   /**
    * Merges and injects multiple style objects into a tab.
    * @private
    * @param {number} tabId - The ID of the target tab.
    * @param {Array<Object>} styles - An array of matching style objects.
    * @returns {Promise<void>}
    */
   async injectStyles(tabId, styles, url) {
      for (const style of styles) {
         const css = this.extractInjectableCss(style.userCode, url);
         if (!css) continue;
         await this.insertCss(tabId, [0], css);
      }
   },

   /**
    * Injects CSS into iframes, evaluating @-moz-document against each frame URL.
    * @private
    */
   async injectStylesIntoSubframes(tabId, styles, topUrl) {
      let frameResults;
      try {
         frameResults = await browser.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: () => window.location.href,
         });
      } catch (err) {
         logger.debug(CONTEXT, `Could not enumerate frames for tab ${tabId}:`, err);
         return;
      }

      for (const result of frameResults || []) {
         const frameId = result?.frameId;
         const frameUrl = result?.result;
         if (typeof frameId !== 'number' || frameId === 0 || typeof frameUrl !== 'string') continue;
         if (isRestrictedUrl(frameUrl)) continue;

         const applicable = styles.filter((style) => Utils.isStyleApplicableToFrame(style, frameUrl, topUrl));
         const combinedCss = applicable
            .map(({ userCode }) => this.extractInjectableCss(userCode, frameUrl))
            .filter(Boolean)
            .join('\n\n/* --- Userstyle Separator --- */\n\n');

         if (!combinedCss) continue;

         try {
            await browser.scripting.insertCSS({
               target: { tabId, frameIds: [frameId] },
               css: combinedCss,
               origin: 'USER',
            });
         } catch (err) {
            logger.debug(CONTEXT, `Subframe style inject failed for tab ${tabId} frame ${frameId}:`, err);
         }
      }
   },

   /**
    * Logs non-trivial errors from style injection.
    * @private
    * @param {number} tabId - The ID of the tab where the error occurred.
    * @param {Error} error - The caught error object.
    */
   handleInjectionError(tabId, error) {
      if (!error.message?.includes('No tab with id')) {
         logger.error(CONTEXT, `Failed to inject style into tab ${tabId}:`, error);
      }
   },


};

// WARNING: Exported as default object (`StyleInjector`). Maintain default import syntax in consumers.
export default StyleInjector;
