import browser from '../../libs/browser-support.js';
import { agents } from '../../database.js';
import Utils from '../utils.js';
import CacheManager from './cache-manager.js';
import { logger } from '../../libs/logger.js';
import { isRestrictedUrl } from '../../constants.js';

const CONTEXT = 'StyleInjector';

/** @type {Map<number, Set<number>>} Tracks injected style IDs per tab to avoid redundant CSS stacking */
const _injectedTabStyles = new Map();  // Track injected style IDs per tab

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
      browser.tabs.onRemoved.addListener((tabId) => _injectedTabStyles.delete(tabId)); // Clean up tab style cache on tab removal
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

      // Inject styles at 'loading' stage to apply CSS synchronously and avoid Flash of Unstyled Content (FOUC)
      if (status !== 'loading' || isRestrictedUrl(url)) return;

      // Clear style injection cache for tab on new top-level document
      if (changeInfo.url) {
         _injectedTabStyles.delete(tabId);
      }

      try {
         const { isPaused = false } = await browser.storage.session.get('isPaused');
         if (isPaused) return;

         const allStyles = await CacheManager.get();
         const matchingStyles = allStyles.filter(
            (style) =>
               style.enabled &&
               style.type === 'userstyle' &&
               Utils.isRunnableOnUrl(style, url)
         );

         // Fetch full CSS code from database only for userstyles matching the active URL
         if (matchingStyles.length > 0) {
            const injectedSet = _injectedTabStyles.get(tabId) || new Set();

            // Filter out styles that have already been injected into the active tab context
            const unappliedStyles = matchingStyles.filter((s) => !injectedSet.has(s.id));

            if (unappliedStyles.length > 0) {
               const fullStyles = await Promise.all(
                  unappliedStyles.map((s) => agents.getFullScript(s.id))
               );
               await this.injectStyles(tabId, fullStyles.filter(Boolean), url);

               unappliedStyles.forEach((s) => injectedSet.add(s.id));
               _injectedTabStyles.set(tabId, injectedSet);
            }
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
    * Merges and injects multiple style objects into a tab.
    * @private
    * @param {number} tabId - The ID of the target tab.
    * @param {Array<Object>} styles - An array of matching style objects.
    * @returns {Promise<void>}
    */
   async injectStyles(tabId, styles, url) {
      const combinedCss = styles
         .map(({ userCode }) => this.extractInjectableCss(userCode, url))
         .filter(Boolean)
         .join('\n\n/* --- Userstyle Separator --- */\n\n');

      if (combinedCss) {
         await browser.scripting.insertCSS({
            target: { tabId },
            css: combinedCss,
            origin: 'USER', // Inject as USER origin to ensure userstyles override site AUTHOR styles
         });
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
