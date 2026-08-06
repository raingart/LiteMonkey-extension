import browser from '../libs/browser-support.js';
import { MSG } from '../message-types.js';

/**
 * Generates sandboxed wrapper JavaScript code for console logging and uncaught error handling.
 * Stringified and executed directly within the userscript's main-world page context.
 *
 * @param {Object} options
 * @param {number|string} options.scriptId - Unique script identifier.
 * @param {string} options.pageToken - Per-page secret token preventing event spoofing.
 * @param {boolean} options.areLogsMutedGlobally - Extension-wide console mute flag.
 * @param {boolean} options.isScriptMuted - Per-script console mute flag.
 * @param {string} options.scriptName - Display name of the script used for log framing.
 * @returns {string} Executable IIFE JavaScript code snippet.
 */
export function generateLogWrapperCode({ scriptId, pageToken, areLogsMutedGlobally, isScriptMuted, scriptName }) {
   const safeName = String(scriptName || 'Script').replace(/[^a-zA-Z0-9_-]/g, '_');
   const options = {
      scriptId,
      scriptName: String(scriptName || 'Script'),
      safeName,
      pageToken: String(pageToken || ''),
      areLogsMutedGlobally: Boolean(areLogsMutedGlobally),
      isScriptMuted: Boolean(isScriptMuted),
      LOG_MESSAGE_TYPE: MSG.LOG_MESSAGE,
      EXTENSION_ID: browser.runtime.id,
   };

   return `(($) => {
      'use strict';
      if (!window.__litemonkey_native_console__) {
         const native = {};
         for (const k in console) {
            if (typeof console[k] === 'function') {
               native[k] = console[k].bind(console);
            }
         }
         Object.defineProperty(window, '__litemonkey_native_console__', {
            value: native,
            configurable: false,
            enumerable: false,
            writable: false,
         });
      }
      const nativeConsole = window.__litemonkey_native_console__;
      const serialize = (v) => {
         try { return JSON.parse(JSON.stringify(v)); }
         catch { return String(v); }
      };
      const postLog = (logEntry) => {
         try {
            window.postMessage({
               extensionId: $.EXTENSION_ID,
               pageToken: $.pageToken,
               type: $.LOG_MESSAGE_TYPE,
               payload: { scriptId: $.scriptId, log: logEntry },
            }, '*');
         } catch (e) {
            nativeConsole.error('[LiteMonkey Logger] Failed to post log:', e);
         }
      };
      const scriptConsole = Object.create(nativeConsole);
      const shouldMute = $.isScriptMuted || $.areLogsMutedGlobally;
      const levels = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'group', 'groupCollapsed', 'groupEnd', 'time', 'timeEnd', 'table'];

      levels.forEach((lvl) => {
         const orig = nativeConsole[lvl] || nativeConsole.log;
         scriptConsole[lvl] = (...args) => {
            const stack = new Error().stack?.split('\\n').slice(2).join('\\n') ?? '';
            postLog({ level: lvl, message: args.map(serialize).join(' '), timestamp: new Date().toISOString(), stack });
            if (!shouldMute) {
               const tag = '%c[LiteMonkey]%c[' + $.scriptName + ']';
               const s1 = 'background: #27a6e5; color: #ffffff; padding: 2px 5px; border-radius: 3px 0 0 3px; font-weight: bold; font-size: 10px;';
               const s2 = 'background: #1d8dc5; color: #ffffff; padding: 2px 5px; border-radius: 0 3px 3px 0; font-weight: bold; font-size: 10px;';
               if (typeof args[0] === 'string') {
                  orig(tag + ' ' + args[0], s1, s2, ...args.slice(1));
               } else {
                  orig(tag, s1, s2, ...args);
               }
            }
         };
      });

      const handleErr = (errorSource) => {
         if (!errorSource) return;
         const isError = errorSource instanceof Error;
         const message = isError ? errorSource.message : String(errorSource);
         const stack = isError ? (errorSource.stack || '') : '';

         // Filter out global errors originating from other scripts or the host page
         if (stack && !stack.includes($.safeName) && !stack.includes($.scriptName)) {
            return;
         }

         postLog({ level: 'error', message, stack, timestamp: new Date().toISOString() });
         if (!shouldMute) {
            nativeConsole.error('[' + $.scriptName + ' Uncaught Error]', errorSource);
         }
      };

      window.addEventListener('error', (evt) => handleErr(evt.error));
      window.addEventListener('unhandledrejection', (evt) => handleErr(evt.reason));

      return scriptConsole;
   })(${JSON.stringify(options)})`;
}
