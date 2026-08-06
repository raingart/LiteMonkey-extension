/**
 * js/libs/logger.js
 *
 * A centralized logging utility for the extension.
 * Supports multiple log levels and dynamic level configuration via browser storage.
 */
import browser from './browser-support.js';

/**
 * Numeric priority log levels.
 * @type {Readonly<Record<string, number>>}
 */
export const LOG_LEVELS = Object.freeze({
   ERROR: 0,
   WARN: 1,
   INFO: 2,
   DEBUG: 3,
});

const DEFAULT_LOG_LEVEL = LOG_LEVELS.WARN;

/**
 * Reverse lookup map mapping numeric level values to level names (e.g., 2 -> 'INFO').
 * @type {Readonly<Record<number, string>>}
 */
const LOG_LEVEL_NAMES = Object.freeze(
   Object.fromEntries(
      Object.entries(LOG_LEVELS).map(([name, value]) => [value, name])
   )
);

/**
 * Console configuration mapping priority levels to console method names and styling rules.
 */
const LOG_CONFIG = Object.freeze({
   [LOG_LEVELS.DEBUG]: { method: 'debug', badgeBg: '#4A5568', textColor: '#FFFFFF' },
   [LOG_LEVELS.INFO]:  { method: 'info',  badgeBg: '#27A6E5', textColor: '#FFFFFF' },
   [LOG_LEVELS.WARN]:  { method: 'warn',  badgeBg: '#ED8936', textColor: '#FFFFFF' },
   [LOG_LEVELS.ERROR]: { method: 'error', badgeBg: '#E53E3E', textColor: '#FFFFFF' },
});

let currentLogLevel = DEFAULT_LOG_LEVEL;

/**
 * Internal log dispatch function that formats log prefixing and handles level filtering.
 *
 * @param {number} level - Priority level of the message.
 * @param {string} context - Execution context or module name emitting the log (e.g., 'ServiceWorker').
 * @param {...any} args - Content payload to log.
 */
function log(level, context, ...args) {
   if (currentLogLevel < level) return;

   const config = LOG_CONFIG[level] ?? LOG_CONFIG[LOG_LEVELS.INFO];
   const levelName = LOG_LEVEL_NAMES[level] ?? 'UNKNOWN';
   const consoleMethod = console[config.method] ?? console.log;

   // Omit CSS %c formatting for errors so extension management UI (chrome://extensions)
   // renders clean error logs without dumping raw CSS strings.
   if (level === LOG_LEVELS.ERROR) {
      const prefix = `[LiteMonkey][ERROR][${context}]`;
      if (typeof args[0] === 'string') {
         consoleMethod.call(console, `${prefix} ${args[0]}`, ...args.slice(1));
      } else {
         consoleMethod.call(console, prefix, ...args);
      }
      return;
   }

   // Distinctive multi-colored badge tags for internal extension logging
   const badgeFormat = `%c[LiteMonkey]%c[${levelName}]%c[${context}]`;
   const styleBrand = 'background: #1A202C; color: #63B3ED; padding: 2px 5px; border-radius: 3px 0 0 3px; font-weight: bold; font-size: 10px;';
   const styleLevel = `background: ${config.badgeBg}; color: ${config.textColor}; padding: 2px 5px; font-weight: bold; font-size: 10px;`;
   const styleContext = 'background: #2D3748; color: #E2E8F0; padding: 2px 5px; border-radius: 0 3px 3px 0; font-size: 10px;';

   // Merge badgeFormat with string message to render badges properly in background console
   if (typeof args[0] === 'string') {
      consoleMethod.call(console, `${badgeFormat} ${args[0]}`, styleBrand, styleLevel, styleContext, ...args.slice(1));
   } else {
      consoleMethod.call(console, badgeFormat, styleBrand, styleLevel, styleContext, ...args);
   }
}

/**
 * Updates active log level and prints confirmation to console.
 * Validates inputs against known priority levels before applying.
 *
 * @param {number} newLevel - Desired numeric log level.
 */
function setLogLevel(newLevel) {
   const isNumericLevel = typeof newLevel === 'number' && newLevel in LOG_LEVEL_NAMES;
   currentLogLevel = isNumericLevel ? newLevel : DEFAULT_LOG_LEVEL;
   const levelName = LOG_LEVEL_NAMES[currentLogLevel];

   console.info(`%c[Logger] Log level set to: ${levelName}`, 'color: green; font-weight: bold;');
}

/**
 * Central logger utility object.
 */
export const logger = {
   /**
    * Initializes log verbosity level from storage and registers a listener for real-time updates.
    * Synchronizes log levels across background service worker, popup, options, and content scripts.
    *
    * @returns {Promise<void>}
    */
   async initialize() {
      try {
         const storage = await browser?.storage?.local?.get({ logLevel: DEFAULT_LOG_LEVEL });
         setLogLevel(storage?.logLevel);
      } catch (err) {
         console.error('[Logger] Failed to load log level from storage, using default.', err);
         setLogLevel(DEFAULT_LOG_LEVEL);
      }

      try {
         browser?.storage?.onChanged?.addListener((changes, areaName) => {
            if (areaName === 'local' && changes.logLevel) {
               setLogLevel(changes.logLevel.newValue);
            }
         });
      } catch (err) {
         console.warn('[Logger] Could not register storage change listener:', err);
      }
   },

   /**
    * Logs debug-level messages (level 3).
    * @param {string} context - Execution context or module name.
    * @param {...any} args - Log payload.
    */
   debug: (context, ...args) => log(LOG_LEVELS.DEBUG, context, ...args),

   /**
    * Logs informational messages (level 2).
    * @param {string} context - Execution context or module name.
    * @param {...any} args - Log payload.
    */
   info: (context, ...args) => log(LOG_LEVELS.INFO, context, ...args),

   /**
    * Logs warning messages (level 1).
    * @param {string} context - Execution context or module name.
    * @param {...any} args - Log payload.
    */
   warn: (context, ...args) => log(LOG_LEVELS.WARN, context, ...args),

   /**
    * Logs error messages (level 0).
    * @param {string} context - Execution context or module name.
    * @param {...any} args - Log payload.
    */
   error: (context, ...args) => log(LOG_LEVELS.ERROR, context, ...args),
};
