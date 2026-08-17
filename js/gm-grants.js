/**
 * @module GmGrants
 * @description Maps userscript @grant names to GM API surface keys and background message types.
 * Used by the injector (page-world allow-list) and MessageRouter (server-side enforcement).
 */

/** APIs always exposed when the script is not `@grant none`. */
export const ALWAYS_GRANTED_APIS = Object.freeze([
   'GM_info',
   'info',
   'unsafeWindow',
   'GM_log',
]);

/**
 * GM API function names (legacy GM_* and GM4 aliases) → @grant values that unlock them.
 * Either grant form is sufficient (Tampermonkey / Violentmonkey compatible).
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const API_TO_GRANTS = Object.freeze({
   GM_getValue: ['GM_getValue', 'GM.getValue'],
   getValue: ['GM_getValue', 'GM.getValue'],
   GM_setValue: ['GM_setValue', 'GM.setValue'],
   setValue: ['GM_setValue', 'GM.setValue'],
   GM_deleteValue: ['GM_deleteValue', 'GM.deleteValue'],
   deleteValue: ['GM_deleteValue', 'GM.deleteValue'],
   GM_listValues: ['GM_listValues', 'GM.listValues'],
   listValues: ['GM_listValues', 'GM.listValues'],
   GM_addValueChangeListener: ['GM_addValueChangeListener', 'GM.addValueChangeListener', 'GM_getValue', 'GM.getValue', 'GM_setValue', 'GM.setValue'],
   GM_removeValueChangeListener: ['GM_removeValueChangeListener', 'GM.removeValueChangeListener', 'GM_addValueChangeListener', 'GM.addValueChangeListener', 'GM_getValue', 'GM.getValue', 'GM_setValue', 'GM.setValue'],
   GM_getResourceText: ['GM_getResourceText', 'GM.getResourceText'],
   getResourceText: ['GM_getResourceText', 'GM.getResourceText'],
   GM_getResourceURL: ['GM_getResourceURL', 'GM.getResourceURL', 'GM_getResourceUrl', 'GM.getResourceUrl'],
   getResourceURL: ['GM_getResourceURL', 'GM.getResourceURL', 'GM_getResourceUrl', 'GM.getResourceUrl'],
   GM_xmlhttpRequest: ['GM_xmlhttpRequest', 'GM.xmlHttpRequest'],
   xmlHttpRequest: ['GM_xmlhttpRequest', 'GM.xmlHttpRequest'],
   GM_registerMenuCommand: ['GM_registerMenuCommand', 'GM.registerMenuCommand'],
   registerMenuCommand: ['GM_registerMenuCommand', 'GM.registerMenuCommand'],
   GM_unregisterMenuCommand: ['GM_unregisterMenuCommand', 'GM.unregisterMenuCommand', 'GM_registerMenuCommand', 'GM.registerMenuCommand'],
   GM_notification: ['GM_notification', 'GM.notification'],
   notification: ['GM_notification', 'GM.notification'],
   GM_openInTab: ['GM_openInTab', 'GM.openInTab'],
   openInTab: ['GM_openInTab', 'GM.openInTab'],
   GM_addStyle: ['GM_addStyle', 'GM.addStyle'],
   addStyle: ['GM_addStyle', 'GM.addStyle'],
   GM_addElement: ['GM_addElement', 'GM.addElement'],
   addElement: ['GM_addElement', 'GM.addElement'],
   GM_setClipboard: ['GM_setClipboard', 'GM.setClipboard'],
   setClipboard: ['GM_setClipboard', 'GM.setClipboard'],
   GM_download: ['GM_download', 'GM.download'],
   download: ['GM_download', 'GM.download'],
   GM_getTab: ['GM_getTab', 'GM.getTab'],
   getTab: ['GM_getTab', 'GM.getTab'],
   GM_getTabs: ['GM_getTabs', 'GM.getTabs'],
   getTabs: ['GM_getTabs', 'GM.getTabs'],
   GM_closeTab: ['GM_closeTab', 'GM.closeTab'],
   closeTab: ['GM_closeTab', 'GM.closeTab'],
   GM_onTabClose: ['GM_onTabClose', 'GM.onTabClose', 'GM_closeTab', 'GM.closeTab', 'GM_getTab', 'GM.getTab'],
   GM_cookie: ['GM_cookie', 'GM.cookie'],
   cookie: ['GM_cookie', 'GM.cookie'],
});

/**
 * Background GM message types that must not be grant-gated (internal / extension-origin).
 * @type {ReadonlySet<string>}
 */
export const UNGATED_GM_MESSAGE_TYPES = Object.freeze(new Set([
   'gm-api-response',
   'gm-xmlhttprequest-callback',
]));

/**
 * Background IPC message type → @grant values that may invoke it.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const MSG_TO_GRANTS = Object.freeze({
   'gm-get-value': ['GM_getValue', 'GM.getValue'],
   'gm-set-value': ['GM_setValue', 'GM.setValue'],
   'gm-delete-value': ['GM_deleteValue', 'GM.deleteValue'],
   'gm-list-values': ['GM_listValues', 'GM.listValues'],
   'gm-get-full-storage': ['GM_getValue', 'GM.getValue', 'GM_listValues', 'GM.listValues'],
   'gm-register-menu-command': ['GM_registerMenuCommand', 'GM.registerMenuCommand'],
   'gm-unregister-menu-command': ['GM_unregisterMenuCommand', 'GM.unregisterMenuCommand', 'GM_registerMenuCommand', 'GM.registerMenuCommand'],
   'gm-get-resource-text': ['GM_getResourceText', 'GM.getResourceText'],
   'gm-get-resource-url': ['GM_getResourceURL', 'GM.getResourceURL', 'GM_getResourceUrl', 'GM.getResourceUrl'],
   'gm-notification': ['GM_notification', 'GM.notification'],
   'gm-open-in-tab': ['GM_openInTab', 'GM.openInTab'],
   'gm-xmlhttprequest': ['GM_xmlhttpRequest', 'GM.xmlHttpRequest'],
   'gm-xmlhttprequest-abort': ['GM_xmlhttpRequest', 'GM.xmlHttpRequest'],
   'gm-set-clipboard': ['GM_setClipboard', 'GM.setClipboard'],
   'gm-download': ['GM_download', 'GM.download'],
   'gm-cookie-list': ['GM_cookie', 'GM.cookie'],
   'gm-cookie-set': ['GM_cookie', 'GM.cookie'],
   'gm-cookie-delete': ['GM_cookie', 'GM.cookie'],
   'gm-get-tab': ['GM_getTab', 'GM.getTab'],
   'gm-get-tabs': ['GM_getTabs', 'GM.getTabs'],
   'gm-close-tab': ['GM_closeTab', 'GM.closeTab'],
   'gm-on-tab-close-subscribe': ['GM_onTabClose', 'GM.onTabClose', 'GM_closeTab', 'GM.closeTab', 'GM_getTab', 'GM.getTab'],
});

/**
 * Resolves the GM API names a script may receive in page context.
 *
 * @param {string|string[]} grantList Raw `@grant` metadata.
 * @returns {Set<string>} Allowed function names on the injected GM object.
 */
export function getGrantedApiNames(grantList) {
   const grants = new Set([].concat(grantList || []).filter(Boolean));
   if (!grants.size || grants.has('none')) return new Set();

   const allowed = new Set(ALWAYS_GRANTED_APIS);
   for (const [apiName, required] of Object.entries(API_TO_GRANTS)) {
      if (required.some((grant) => grants.has(grant))) {
         allowed.add(apiName);
      }
   }
   return allowed;
}

/**
 * Whether a tab-origin GM IPC message is permitted for the script's @grant list.
 * Unknown `gm-*` types are denied. Non-GM messages are allowed (gated elsewhere).
 *
 * @param {string} messageType Kebab-case MSG value.
 * @param {string|string[]} grantList Raw `@grant` metadata.
 * @returns {boolean}
 */
export function messageAllowedByGrants(messageType, grantList) {
   if (!messageType || !messageType.startsWith('gm-')) return true;
   if (UNGATED_GM_MESSAGE_TYPES.has(messageType)) return true;

   const required = MSG_TO_GRANTS[messageType];
   if (!required) return false;

   const grants = [].concat(grantList || []);
   return required.some((grant) => grants.includes(grant));
}
