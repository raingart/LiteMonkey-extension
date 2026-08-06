/**
 * @file Lite Monkey Bootstra)
 * @description Secure and robust communication bridge running in the isolated world context (Chrome MV3).
 */
(() => {
   'use strict';

   if (!window.location.protocol.startsWith('http')) return;

   // Safe cross-browser extension API namespace lookup
   const browser = (typeof chrome !== 'undefined' && chrome?.runtime)
      ? chrome
      : (typeof globalThis.browser !== 'undefined' ? globalThis.browser : null);

   if (!browser?.runtime?.id) return;

   const EXTENSION_ID = browser.runtime.id;
   const INSTANCE_ID = crypto.randomUUID();
   const IS_TOP_FRAME = (window.self === window.top);

   /**
    * Prefix namespaces for segregating internal bridge messaging from runtime push events.
    */
   const PREFIX = Object.freeze({
      BRIDGE: 'bridge-',
      EVENT: 'event-',
   });

   /**
    * WARNING: Message contract constants. Do not mutate string values without updating
    * corresponding listeners in the background service worker and main-world context provider.
    */
   const MSG = Object.freeze({
      // Uplink: Messages sent TO the background script
      GET_TAB_SCRIPTS: 'get-tab-scripts',
      EXECUTE_SCRIPT_IN_TAB: 'execute-script-in-tab',
      GET_LOG_LEVEL: 'get-log-level',

      // Downlink: Messages received FROM the background script
      GM_API_RESPONSE: 'gm-api-response',
      GM_XMLHTTPREQUEST_CALLBACK: 'gm-xmlhttprequest-callback',

      // Bridge: Internal handshake messages between bootstrap and gm-api-provider
      BRIDGE_HANDSHAKE: `${PREFIX.BRIDGE}handshake`,
      BRIDGE_READY: `${PREFIX.BRIDGE}ready`,
      BRIDGE_ANNOUNCE: `${PREFIX.BRIDGE}announce`,
   });
   /**
    * Known userscript repository hostnames for auto-exposing extension presence.
    * @type {ReadonlySet<string>}
    */
   const SCRIPT_REPOSITORY_HOSTS = Object.freeze(new Set([
      'greasyfork.org',
      'sleazyfork.org',
      'openuserjs.org',
      'userscript.zone',
   ]));

   /**
    * Evaluates whether a domain hostname belongs to a userscript repository.
    * @param {string} hostname
    * @returns {boolean}
    */
   function isScriptRepositoryHost(hostname) {
      if (!hostname || typeof hostname !== 'string') return false;
      const cleanHost = hostname.toLowerCase();
      return [...SCRIPT_REPOSITORY_HOSTS].some(
         (repoHost) => cleanHost === repoHost || cleanHost.endsWith(`.${repoHost}`)
      );
   }

   let isDebugEnabled = false;
   let isOrphaned = false; // State flag tracking runtime invalidation

   const log = {
      debug: (...args) => isDebugEnabled && console.debug('[Bootstrap]', ...args),
      error: (...args) => !isOrphaned && console.error('[Bootstrap]', ...args),
   };

   // Active userscript token map: scriptId -> pageToken
   const activeTokens = new Map();

   // Define messages that are strictly reserved for internal bootstrap logic
   const BOOTSTRAP_ONLY_MESSAGES = new Set([
      MSG.GET_TAB_SCRIPTS,
      MSG.EXECUTE_SCRIPT_IN_TAB,
      MSG.GET_LOG_LEVEL
   ]);

   // Teardown event listeners and invalidate state when extension is updated/reloaded
   function cleanupOrphanedBootstrap() {
      if (isOrphaned) return;
      isOrphaned = true;

      window.removeEventListener('message', handleUplinkMessage);
      try {
         if (browser?.runtime?.onMessage) {
            browser.runtime.onMessage.removeListener(handleDownlinkMessage);
         }
      } catch { }

      activeTokens.clear();
      log.debug('Extension context invalidated. Cleaned up orphaned content script listeners.');
   }

   // Helper function with retry logic & extension invalidation protection
   async function sendRuntimeMessageWithRetry(message, retries = 2) {
      if (isOrphaned || !browser?.runtime?.id) {
         cleanupOrphanedBootstrap();
         return null;
      }

      for (let i = 0; i <= retries; i++) {
         try {
            return await browser.runtime.sendMessage(message);
         } catch (err) {
            const msg = err?.message ?? String(err);

            // Handle context invalidation quietly without throwing uncaught exceptions
            if (msg.includes('Extension context invalidated')) {
               cleanupOrphanedBootstrap();
               return null;
            }

            if (msg.includes('Receiving end does not exist') && i < retries) {
               await new Promise((r) => setTimeout(r, 100 * (i + 1)));
               continue;
            }
            throw err;
         }
      }
   }

   /**
    * Handles secure uplink API calls from page-script contexts via per-script CustomEvents.
    * Validates token ownership before forwarding requests to the background service worker.
    *
    * @param {Object} data - Event payload forwarded from the main world.
    */
   function handleSecureUplink(data) {
      if (isOrphaned || !data || data.extensionId !== EXTENSION_ID) return;

      const { type, pageToken, payload } = data;
      const scriptId = payload?.scriptId;

      // Token verification prevents untrusted page scripts from spoofing API calls for injected scripts
      if (scriptId && activeTokens.get(scriptId) !== pageToken) {
         log.error(`Security Warning: Blocked unauthorized API call "${type}" for script ${scriptId}. Token mismatch.`);
         return;
      }

      log.debug('Secure Uplink RX from page:', type);

      sendRuntimeMessageWithRetry(data)
         .then(response => {
            if (!response && isOrphaned) return; // Silently exit if extension context was destroyed

            if (data.transactionId) {
               // WARNING: Event name pattern 'litemonkey-down-${pageToken}' must match gm-api-provider listener
               const downEventName = `litemonkey-down-${pageToken}`;
               window.dispatchEvent(new CustomEvent(downEventName, {
                  detail: {
                     extensionId: EXTENSION_ID,
                     type: MSG.GM_API_RESPONSE,
                     transactionId: data.transactionId,
                     response: response ?? null,
                  }
               }));
            }
         })
         .catch(error => {
            if (!error?.message?.includes('Receiving end does not exist') && !error?.message?.includes('Extension context invalidated')) {
               log.error('Uplink error:', error);
            }
         });
   }

   /**
    * Handles postMessage communication from the main world context (gm-api-provider).
    * Manages bridge handshake state and legacy non-event API forwards.
    *
    * @param {MessageEvent} event - Window postMessage event object.
    */
   function handleUplinkMessage({ source, data }) {
      if (isOrphaned || source !== window || !data || data.extensionId !== EXTENSION_ID) {
         return;
      }

      const { type } = data;

      if (type?.startsWith(PREFIX.BRIDGE)) {
         if (type === MSG.BRIDGE_HANDSHAKE) {
            log.debug(`Handshake received. Replying with instance ID: ${INSTANCE_ID.slice(0, 4)}`);
            source.postMessage({
               extensionId: EXTENSION_ID,
               type: MSG.BRIDGE_READY,
               instanceId: INSTANCE_ID,
            }, '*');
         }
         return;
      }

      const isApiResponse = type === MSG.GM_API_RESPONSE;
      const isEvent = type?.startsWith(PREFIX.EVENT);

      // Block malicious pages from spoofing untokenized bootstrap commands
      if (!type || isApiResponse || isEvent || BOOTSTRAP_ONLY_MESSAGES.has(type)) {
         return;
      }

      log.debug('Uplink RX from page:', type);

      sendRuntimeMessageWithRetry(data)
         .then(response => {
            if (!response && isOrphaned) return;

            if (data.transactionId) {
               source.postMessage({
                  extensionId: EXTENSION_ID,
                  type: MSG.GM_API_RESPONSE,
                  transactionId: data.transactionId,
                  response: response ?? null,
               }, '*');
            }
         })
         .catch(error => {
            if (!error?.message?.includes('Receiving end does not exist') && !error?.message?.includes('Extension context invalidated')) {
               log.error('Uplink error:', error);
            }
         });
   }

   /**
    * Listens for messages broadcasted from the background service worker.
    * Forwards push events and callbacks down to active main-world userscripts.
    *
    * @param {Object} message - Message payload from background script.
    */
   function handleDownlinkMessage(message) {
      if (isOrphaned) return;

      const type = message?.type;
      if (!type) return;

      const isEvent = type.startsWith(PREFIX.EVENT);
      const isXmlHttpCallback = type === MSG.GM_XMLHTTPREQUEST_CALLBACK;
      const isAllowedDownlink = (isEvent || isXmlHttpCallback);

      if (isAllowedDownlink) {
         log.debug('Downlink RX, broadcasting via secure events to page:', type);

         // Check if payload specifies targetScriptId/scriptId to target exact script token and avoid event storms
         const targetScriptId = message.payload?.scriptId ?? message.payload?.targetScriptId;

         if (targetScriptId && activeTokens.has(targetScriptId)) {
            const token = activeTokens.get(targetScriptId);
            window.dispatchEvent(new CustomEvent(`litemonkey-down-${token}`, {
               detail: { ...message, extensionId: EXTENSION_ID }
            }));
         } else {
            // Fallback broadcast for global push events without target script ID
            for (const token of activeTokens.values()) {
               window.dispatchEvent(new CustomEvent(`litemonkey-down-${token}`, {
                  detail: { ...message, extensionId: EXTENSION_ID }
               }));
            }
         }
      }
   }

   /**
    * Main initialization function for isolated bootstrap context.
    */
   async function main() {
      try {
         // Expose Userscript Manager presence to script repository sites (GreasyFork, OpenUserJS)
         if (isScriptRepositoryHost(window.location.hostname)) {
            try {
               document.documentElement.dataset.hasUserScriptManager = 'true';
               document.documentElement.dataset.userScriptManager = 'Lite Monkey';
            } catch (e) {}
         }

         // Use retry helper for wake-up resilience
         const logLevelResponse = await sendRuntimeMessageWithRetry({ type: MSG.GET_LOG_LEVEL }).catch(() => ({ logLevel: 0 }));
         if (isOrphaned) return;

         isDebugEnabled = (logLevelResponse?.logLevel ?? 0) >= 3;
         log.debug(`Initialized in ${IS_TOP_FRAME ? 'TOP frame' : 'IFRAME'}.`);

         window.addEventListener('message', handleUplinkMessage);

         // Register downlink listener in ALL frames (including iframes) so scripts in subframes receive callbacks/events
         browser.runtime.onMessage.addListener(handleDownlinkMessage);

         const announceReady = () => {
            if (!isOrphaned) {
               window.postMessage({
                  extensionId: EXTENSION_ID,
                  type: MSG.BRIDGE_ANNOUNCE,
                  instanceId: INSTANCE_ID,
               }, '*');
            }
         };

         // Staggered delays ensure presence announcement reaches late-loaded page context scripts
         [0, 50, 150, 500].forEach(delay => setTimeout(announceReady, delay));

         // Use retry helper to guarantee fetch of scripts even if SW was sleeping
         const scriptsResponse = await sendRuntimeMessageWithRetry({
            type: MSG.GET_TAB_SCRIPTS,
            payload: { url: window.location.href }
         });

         if (isOrphaned) return;

         if (scriptsResponse?.scripts && !scriptsResponse.isPaused) {
            log.debug(`Received ${scriptsResponse.scripts.length} applicable scripts.`);

            // Declare executionRequests array in main scope before loop
            const executionRequests = [];

            for (const script of scriptsResponse.scripts) {
               if (script.meta?.noframes && !IS_TOP_FRAME) continue;

               // Global flag prevents multiple injections in case of frame re-attaches
               const marker = `__LITEMONKEY_INJECTED_${script.id}`;
               if (window[marker]) continue;
               window[marker] = true;

               const pageToken = crypto.randomUUID();
               activeTokens.set(script.id, pageToken);

               window.addEventListener(`litemonkey-up-${pageToken}`, (e) => {
                  handleSecureUplink(e.detail);
               });

               log.debug(`Requesting execution for: "${script.meta?.name}"`);

               executionRequests.push(
                  sendRuntimeMessageWithRetry({
                     type: MSG.EXECUTE_SCRIPT_IN_TAB,
                     payload: {
                        scriptId: script.id,
                        target: {
                           tabId: script.tabId,
                           frameId: script.frameId
                        },
                        injectionContext: {
                           pageToken,
                        }
                     },
                  }).catch(() => { })
               );
            }

            // Dispatch injection requests in parallel
            await Promise.all(executionRequests);
         }
      } catch (err) {
         if (!err?.message?.includes('Extension context invalidated')) {
            log.error('Initialization failed:', err?.message ?? err);
         } else {
            cleanupOrphanedBootstrap();
         }
      }
   }

   main();
})();
