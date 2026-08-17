import browser from '../../libs/browser-support.js';
import { logger } from '../../libs/logger.js';

const CONTEXT = 'UserScriptInterceptor';
const INSTALLER_PATH = 'html/installer.html';
// Match http(s) URLs ending in .user.js before query/hash parameters, preventing loops on extension URLs
const USER_SCRIPT_REGEX = '^https?://[^?#]*\\.user\\.js([?#].*)?$';
const INSTALLER_RULE_ID = 1;

/**
 * Domains excluded from dynamic declarativeNetRequest interception.
 */
const EXCLUDED_DOMAINS = [
   'github.com',
   'gitlab.com',
   'pastebin.com',
];

/**
 * Builds a declarativeNetRequest rule redirecting `.user.js` top-level main frame navigations
 * directly to the extension's installation web page.
 *
 * @param {string} installerUrl - Absolute WebExtension URL of the installer page.
 * @returns {browser.declarativeNetRequest.Rule} WebExtension DNR Rule object.
 */
const createInstallerRule = (installerUrl) => ({
   id: INSTALLER_RULE_ID,
   priority: 1,
   action: {
      type: 'redirect',
      redirect: {
         // Substituted '\\0' captures the entire matched URL string (including query string parameters)
         // Example: installer.html?url=http://example.com/script.user.js?v=1
         regexSubstitution: `${installerUrl}?url=\\0`,
      },
   },
   condition: {
      regexFilter: USER_SCRIPT_REGEX,
      excludedRequestDomains: EXCLUDED_DOMAINS,
      // Target main_frame navigations only so background fetches or iframe loads are not intercepted
      resourceTypes: ['main_frame'],
   },
});

/**
 * Intercepts top-level browser navigations to `.user.js` scripts using Declarative Net Request (DNR).
 * Operates directly inside the browser network stack to avoid waking the Manifest V3 Service Worker.
 */
const UserScriptInterceptor = {
   /**
    * Registers or updates the dynamic declarativeNetRequest redirection rule.
    * @returns {Promise<void>}
    */
   async initialize() {
      try {
         const installerUrl = browser.runtime.getURL(INSTALLER_PATH);

         // Check existing rules first to prevent race conditions and unnecessary disk I/O on SW restarts
         const existingRules = await browser.declarativeNetRequest.getDynamicRules();
         const hasActiveRule = existingRules.some(
            (r) => r.id === INSTALLER_RULE_ID &&
                   r.condition?.regexFilter === USER_SCRIPT_REGEX &&
                   r.action?.redirect?.regexSubstitution?.startsWith(installerUrl)
         );

         if (hasActiveRule) {
            logger.debug(CONTEXT, 'Interception rule already active. Skipping DNR update.');
            return;
         }

         const installerRule = createInstallerRule(installerUrl);

         await browser.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [INSTALLER_RULE_ID],
            addRules: [installerRule],
         });

         logger.debug(CONTEXT, 'Interception rule active.');
      } catch (error) {
         logger.error(CONTEXT, 'Failed to register interception rule:', error);
      }
   },
};

// WARNING: Exported as default object (`UserScriptInterceptor`). Maintain default import syntax in consumers.
export { USER_SCRIPT_REGEX, EXCLUDED_DOMAINS };
export default UserScriptInterceptor;
