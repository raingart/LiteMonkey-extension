/**
 * @module MessageTypes
 * @description A single, universally safe source of truth for message type constants.
 * This file has no browser API dependencies and can be imported in any context.
 */

/**
 * Converts an array of UPPER_SNAKE_CASE message keys into an object mapping each key
 * to its corresponding kebab-case message string value (e.g., 'GET_ALL_SCRIPTS' -> 'get-all-scripts').
 *
 * Using kebab-case string values provides clean, standard Chrome extension messaging identifiers while
 * preventing string literal typos across background, popup, options, and content script contexts.
 *
 * @param {readonly string[]} keys - List of UPPER_SNAKE_CASE message keys.
 * @returns {Record<string, string>} Map of UPPER_SNAKE_CASE keys to kebab-case string values.
 */
const createMessageTypes = (keys) =>
   Object.fromEntries(
      keys.map((key) => [key, key.toLowerCase().replace(/_/g, '-')])
   );

/**
 * @const {Readonly<Record<string, string>>} MSG
 * Central dictionary for all message types in the extension.
 * Object is frozen to guarantee runtime immutability across isolated extension contexts.
 */
export const MSG = Object.freeze({
   // Channel: UI (Installer) -> Background
   ...createMessageTypes([
      'INSTALL_SCRIPT_FROM_URL',
      'CHECK_SCRIPT_EXISTS',
   ]),

   // Channel: UI (Popup/Options/Editor) -> Background
   ...createMessageTypes([
      'GET_ALL_SCRIPTS',              // Request all scripts for the options page
      'GET_ALL_SCRIPTS_WITH_CODE',
      'GET_SCRIPT_WITH_CODE',
      'GET_APPLICABLE_SCRIPTS',       // Returns matching scripts for active URL (popup)
      'GET_TAB_SCRIPTS',              // Request scripts executing in current tab (popup)
      'SAVE_SCRIPT',                  // Save or create a userscript
      'DELETE_SCRIPT',
      'OPEN_SCRIPT_IN_EDITOR',
      'UPDATE_SCRIPT_PROPS',          // Update specific properties (e.g., enable/disable state)
      'REORDER_SCRIPTS',              // Update execution priority order
      'IMPORT_SCRIPTS',               // Bulk import scripts from file
      'CHECK_PERMISSIONS_FOR_SCRIPT', // Verify host permissions during script import
      'CHECK_SCRIPTS_UPDATES',        // Trigger update check for installed scripts
      'GET_PAUSE_STATE',              // Query global execution pause state
      'SET_PAUSE_STATE',              // Toggle global execution pause state
      'SETTINGS_UPDATED',             // Broadcast global settings changes
      'SET_SCRIPT_STORAGE',           // Update persistent script storage from editor
   ]),

   // Channel: Greasemonkey API (Page Context -> Background)
   ...createMessageTypes([
      'GM_GET_VALUE',
      'GM_SET_VALUE',
      'GM_DELETE_VALUE',
      'GM_LIST_VALUES',
      'GM_GET_FULL_STORAGE',
      'GM_REGISTER_MENU_COMMAND',
      'GM_UNREGISTER_MENU_COMMAND',
      'GM_GET_RESOURCE_TEXT',
      'GM_GET_RESOURCE_URL',
      'GM_NOTIFICATION',
      'GM_OPEN_IN_TAB',
      'GM_XMLHTTPREQUEST',
      'GM_XMLHTTPREQUEST_CALLBACK',
      'GM_XMLHTTPREQUEST_ABORT',
      'GM_SET_CLIPBOARD',
      'GM_DOWNLOAD',
      'GM_COOKIE_LIST',
      'GM_COOKIE_SET',
      'GM_COOKIE_DELETE',
      'GM_GET_TAB',
      'GM_GET_TABS',
      'GM_CLOSE_TAB',
      'GM_ON_TAB_CLOSE_SUBSCRIBE',
      'EXECUTE_MENU_COMMAND',         // Execute registered menu command (initiated from popup)
   ]),

   // Channel: Logging (Page/UI -> Background)
   ...createMessageTypes([
      'LOG_MESSAGE',                  // Userscript forwards runtime log entry to background
      'GET_LOGS_FOR_TAB',             // UI requests execution logs for active tab
      'CLEAR_LOGS_FOR_SCRIPT_IN_TAB', // UI requests clearing logs for specific script/tab
      'GET_LOG_LEVEL',                // Content bridge fetches active log verbosity level on init
   ]),

   // Channel: Background -> Page Context (Events)
   ...createMessageTypes([
      'EVENT_EXECUTE_MENU_COMMAND',
      'EVENT_NOTIFICATION_CLICKED',
      'EVENT_NOTIFICATION_CLOSED',
      'EVENT_VALUE_CHANGED',          // Broadcasts GM_storage changes across tabs
      'EVENT_LOG_LEVEL_UPDATE',       // Background notifies bridge of log level change
      'EVENT_TAB_CLOSED',
   ]),

   // Channel: Internal System Messages
   ...createMessageTypes([
      'GM_API_RESPONSE',              // Async response wrapper for GM_* API calls
      'EXECUTE_SCRIPT_IN_TAB',        // Bootstrap -> Background: Execute script in tab/frame to bypass strict page CSP
      'PING',                         // Health-check / keep-alive heartbeat
   ]),

   // Channel: Cloud Sync (Google Drive)
   ...createMessageTypes([
      'GDRIVE_GET_STATUS',
      'GDRIVE_UPLOAD',
      'GDRIVE_DOWNLOAD',
      'GDRIVE_DELETE_CLOUD',
   ]),
});
