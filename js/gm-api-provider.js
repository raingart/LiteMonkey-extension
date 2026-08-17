/**
 * @file Main-World GM API Provider (Lite Monkey)
 * @description Provides the execution context and GM_* / GM.* APIs injected into main-world web pages.
 */

import { getGrantedApiNames } from './gm-grants.js';

// WARNING: apiProvider is stringified via apiProvider.toString() and evaluated directly in the target web page context.
// Do NOT add references to external scope variables or imports inside apiProvider.
const apiProvider = function (context) {
   'use strict';

   // Capture native DOM methods immediately to prevent prototype hooking/token theft by the host page
   const nativeDispatch = EventTarget.prototype.dispatchEvent;
   const NativeCustomEvent = typeof CustomEvent !== 'undefined' ? CustomEvent : Event;
   const nativeObjectKeys = Object.keys;

   const {
      // --- Core Identifiers ---
      extensionId,    // Unique extension ID for message validation.
      scriptId,       // Script database ID.
      tabId,          // Current tab ID to identify remote vs local storage events.

      // --- Security ---
      pageToken,      // Per-page secret token preventing event spoofing.

      // --- Script Metadata & Source ---
      meta,           // Parsed ==UserScript== metadata object.
      metaBlockStr,   // Raw ==UserScript== header string.
      userCode,       // Raw userscript source code.

      // --- Extension & Environment Info ---
      manifest,       // Extension manifest object.
      defaultIconUrl, // Fallback icon URL for notifications.
      isDebug,        // Debug logging flag.
      MSG,            // Inter-process message constants object.

      // --- Initial State ---
      storageCache,   // Initial snapshot for synchronous GM_getValue calls.

      resourceCache = {}, // Extract resource cache
      allowedApis,        // Allow-list of GM_* / GM4 names from @grant (empty = expose nothing extra)
   } = context;

   // --- State Management ---
   let bridgeState = pageToken ? 'READY' : 'BROKEN';
   const PENDING_OPERATIONS = new Map();

   // --- Constants ---
   const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

   // --- Local Caches & Listeners ---
   const storage = { ...storageCache };
   const commands = new Map();
   const notificationCallbacks = new Map();
   const valueChangeListeners = new Map();
   const tabCloseListeners = new Map();
   const activeXmlHttpRequests = new Map();
   let listenerIdCounter = 0;

   // Map for coalescing rapid GM_setValue calls in high-frequency loops
   const pendingValueWrites = new Map();

   // Make isDebug state mutable in page sandbox
   let isDebugActive = Boolean(isDebug);

   const originalConsole = { ...console };
   const log = {
      debug: (...args) => isDebug && originalConsole.debug(`[API Provider] [${meta.name}]`, ...args),
      error: (...args) => originalConsole.error(`[API Provider] [${meta.name}]`, ...args),
   };

   /**
    * Disables the bridge and rejects all pending promises in the event of a critical token error.
    * @param {string} reason
    */
   function breakBridge(reason) {
      if (bridgeState === 'BROKEN') return;
      log.error(`Bridge is breaking. Reason: ${reason}`);
      bridgeState = 'BROKEN';

      const error = new Error(reason);
      PENDING_OPERATIONS.forEach(op => {
         clearTimeout(op.timeoutId);
         op.reject(error);
      });
      PENDING_OPERATIONS.clear();

      // Prevent memory leak of DOM/Closure references in XHR callbacks when bridge is destroyed
      activeXmlHttpRequests.clear();
   }

   /**
    * Posts an outbound message to the isolated bootstrap content script via CustomEvents.
    * @param {Object} message - Message body including transaction identifiers.
    */
   function postToBridge(message) {
      if (bridgeState !== 'READY') {
         log.error('Attempted to send message over a broken bridge:', message.type);
         return;
      }
      const finalMessage = { ...message, extensionId, pageToken };
      const eventName = `litemonkey-up-${pageToken}`;

      // Use captured native dispatch to bypass page-level overrides
      const event = new NativeCustomEvent(eventName, { detail: finalMessage });
      nativeDispatch.call(window, event);
   }

   /**
    * Sends an asynchronous request through the bridge and returns a tracking promise.
    * @param {string} type - Message type constant from MSG.
    * @param {Object} payload - Data payload.
    * @param {number} [timeout=5000] - Timeout limit in milliseconds.
    * @returns {Promise<any>}
    */
   function requestFromBackground(type, payload, timeout = DEFAULT_REQUEST_TIMEOUT_MS) {
      return new Promise((resolve, reject) => {
         if (bridgeState === 'BROKEN') {
            return reject(new Error('Bridge is broken. Cannot send request.'));
         }
         const transactionId = crypto.randomUUID();
         const timeoutId = setTimeout(() => {
            if (PENDING_OPERATIONS.has(transactionId)) {
               reject(new Error(`API request for "${type}" timed out.`));
               PENDING_OPERATIONS.delete(transactionId);
            }
         }, timeout);
         PENDING_OPERATIONS.set(transactionId, { resolve, reject, timeoutId });
         postToBridge({ type, payload, transactionId });
      });
   }

   /**
    * Handles response lookup and promise resolution for completed background transactions.
    * @param {Object} param0 - Transaction ID and response payload.
    */
   function handleApiResponse({ transactionId, response }) {
      if (!PENDING_OPERATIONS.has(transactionId)) return;
      log.debug('◀️ RX [Response]', { transactionId: transactionId.slice(0, 4), response });
      const operation = PENDING_OPERATIONS.get(transactionId);
      clearTimeout(operation.timeoutId);
      operation.resolve(response);
      PENDING_OPERATIONS.delete(transactionId);
   }

   // Centralized dispatcher to ensure local mutations trigger listeners synchronously
   function triggerValueChange(key, oldValue, newValue, remote) {
      valueChangeListeners.forEach(listener => {
         if (listener.key === key) {
            try { listener.callback(key, oldValue, newValue, remote); }
            catch (err) { originalConsole.error('Error in value change listener:', err); }
         }
      });
   }

   /**
    * Event handlers for push notifications and events originating from the background worker.
    */
   const eventHandlers = {
      //  Handle live log level updates dispatched from extension settings
      [MSG.EVENT_LOG_LEVEL_UPDATE]: ({ logLevel }) => {
         isDebugActive = (logLevel ?? 0) >= 3;
      },
      [MSG.EVENT_VALUE_CHANGED]: ({ scriptId: targetScriptId, key, oldValue, newValue, originatingTabId }) => {
         // Verify that memory change events belong exclusively to this userscript instance
         if (targetScriptId !== scriptId) return;

         const remote = originatingTabId !== tabId;

         if (newValue === undefined) delete storage[key];
         else storage[key] = newValue;

         valueChangeListeners.forEach(listener => {
            if (listener.key === key) {
               try { listener.callback(key, oldValue, newValue, remote); }
               catch (err) { originalConsole.error('Error in value change listener:', err); }
            }
         });
      },
      [MSG.EVENT_EXECUTE_MENU_COMMAND]: ({ scriptId: targetScriptId, commandId }) => {
         if (targetScriptId && targetScriptId !== scriptId) return; // Strictly isolate command execution to target script
         log.debug('◀️ RX [EXECUTE_MENU_COMMAND]', { commandId });
         commands.get(commandId)?.();
      },
      [MSG.EVENT_NOTIFICATION_CLICKED]: ({ notificationId }) => {
         notificationCallbacks.get(notificationId)?.onclick?.();
      },
      [MSG.EVENT_NOTIFICATION_CLOSED]: ({ notificationId }) => {
         notificationCallbacks.get(notificationId)?.ondone?.();
         notificationCallbacks.delete(notificationId);
      },
      [MSG.EVENT_TAB_CLOSED]: ({ tabId: closedTabId }) => {
         log.debug('◀️ RX [EVENT_TAB_CLOSED]', { tabId: closedTabId });
         tabCloseListeners.forEach(callback => {
            try { callback(closedTabId); }
            catch (err) { originalConsole.error('Error in tab close listener:', err); }
         });
      },
   };

   // Listen for downlink events dispatched from the bootstrap isolated context
   window.addEventListener(`litemonkey-down-${pageToken}`, (e) => {
      const data = e.detail;
      if (!data || data.extensionId !== extensionId) return;

      const { type, payload } = data;

      if (type === MSG.GM_API_RESPONSE) {
         handleApiResponse(data);
      } else if (type === MSG.GM_XMLHTTPREQUEST_CALLBACK) {
         const { requestId, eventType, response } = payload;
         const callbacks = activeXmlHttpRequests.get(requestId);

         if (callbacks) {
            // Reconstruct binary payloads (ArrayBuffer/Blob) before ANY callback (onload, onreadystatechange, onloadend) executes
            if (response.binaryResponseType && response.binaryResponseData && !response._binaryDecoded) {
               try {
                  const base64 = response.binaryResponseData.split(',')[1];
                  const byteString = atob(base64);
                  const ab = new ArrayBuffer(byteString.length);
                  const ia = new Uint8Array(ab);
                  for (let i = 0; i < byteString.length; i++) {
                     ia[i] = byteString.charCodeAt(i);
                  }

                  if (response.binaryResponseType === 'blob') {
                     response.response = new Blob([ab], {
                        type: response.headers?.['content-type'] || 'application/octet-stream'
                     });
                  } else {
                     response.response = ab; // ArrayBuffer
                  }
                  response._binaryDecoded = true; // Guard against multiple decoding passes
               } catch (err) {
                  originalConsole.error('Failed to decode binary response:', err);
               }
            }

            // Emulate 100% progress completion event for progress bars and download meters
            const onprogress = callbacks.onprogress;
            if (typeof onprogress === 'function' && eventType === 'onload') {
               try {
                  const headerLength = parseInt(response.headers?.['content-length'] || '0', 10);
                  const bodyLength = response.responseText
                     ? new TextEncoder().encode(response.responseText).length
                     : (response.response?.byteLength || response.response?.size || 0); // Check byteLength for ArrayBuffer and size for Blob
                  const totalBytes = headerLength > 0 ? headerLength : bodyLength;

                  onprogress({
                     ...response,
                     lengthComputable: totalBytes > 0,
                     loaded: totalBytes,
                     total: totalBytes,
                     position: totalBytes,
                  });
               } catch (err) {
                  originalConsole.error('Error in GM_xmlhttpRequest onprogress:', err);
               }
            }

            // Emulate readyState 4 onreadystatechange for legacy script compatibility
            const onreadystatechange = callbacks.onreadystatechange;
            if (typeof onreadystatechange === 'function' && eventType === 'onload') {
               try {
                  onreadystatechange({ ...response, readyState: 4 });
               } catch (err) {
                  originalConsole.error('Error in GM_xmlhttpRequest onreadystatechange:', err);
               }
            }

            // Deduplicated single invocation of original callback
            const callback = callbacks[eventType];
            if (typeof callback === 'function') {
               try {
                  callback(response);
               } catch (err) {
                  originalConsole.error('Error in GM_xmlhttpRequest callback:', err);
               }
            }

            // Remove request registry entry on terminal lifecycle events
            if (['onload', 'onerror', 'onabort', 'ontimeout'].includes(eventType)) {
               if (eventType !== 'onload') {
                  const onreadystatechange = callbacks.onreadystatechange;
                  if (typeof onreadystatechange === 'function') {
                     try {
                        onreadystatechange({ ...response, readyState: 4 });
                     } catch (err) {
                        originalConsole.error('Error in GM_xmlhttpRequest onreadystatechange:', err);
                     }
                  }
               }

               // Ensure onloadend fires on request completion for Greasemonkey/Tampermonkey spec compliance
               const onloadend = callbacks.onloadend;
               if (typeof onloadend === 'function') {
                  try {
                     onloadend(response);
                  } catch (err) {
                     originalConsole.error('Error in GM_xmlhttpRequest onloadend:', err);
                  }
               }

               activeXmlHttpRequests.delete(requestId);
            }
         }
      } else {
         eventHandlers[type]?.(payload);
      }
   });

   if (!pageToken) {
      breakBridge('Fatal: No page token provided.');
   }

   /**
    * Ensures a value is returned as an array.
    * @param {any} value
    * @returns {Array}
    */
   function ensureArray(value) {
      return [].concat(value || []);
   }

   // Helper to deep-clone objects to prevent reference pollution in memory cache
   const deepClone = (val) => {
      if (val === undefined || val === null || typeof val !== 'object') return val;
      try { return structuredClone(val); }
      catch { try { return JSON.parse(JSON.stringify(val)); } catch { return val; } }
   };

   // --- GM API Implementations ---
   const gmAPI = {
      GM_getValue: (key, defaultValue) => key in storage ? deepClone(storage[key]) : defaultValue,
      GM_listValues: () => nativeObjectKeys(storage),
      GM_setValue: (key, value) => {
         const oldValue = deepClone(storage[key]);
         const newValue = deepClone(value);
         storage[key] = newValue;

         triggerValueChange(key, oldValue, newValue, false);

         return new Promise((resolve, reject) => {
            const pending = pendingValueWrites.get(key);

            if (pending) {
               // Append promise handlers to active batch without pushing back the batch flush timer
               pending.resolvers.push(resolve);
               pending.rejecters.push(reject);
               pending.value = newValue;
            } else {
               // Start a fixed 40ms batch window using initial pre-batch oldValue for safe rollback
               const batchState = {
                  resolvers: [resolve],
                  rejecters: [reject],
                  value: newValue,
                  initialOldValue: oldValue,
                  timeoutId: null,
               };

               batchState.timeoutId = setTimeout(() => {
                  const { resolvers, rejecters, value: valToSend, initialOldValue } = batchState;
                  pendingValueWrites.delete(key);

                  requestFromBackground(MSG.GM_SET_VALUE, { scriptId, key, value: valToSend })
                     .then((res) => {
                        if (!res?.success) {
                           throw new Error(res?.error || 'GM_setValue failed');
                        }
                        resolvers.forEach((r) => r(res));
                     })
                     .catch((err) => {
                        // Rollback RAM cache to pre-batch value if background persistence fails
                        if (storage[key] === valToSend) {
                           if (initialOldValue === undefined) delete storage[key];
                           else storage[key] = initialOldValue;
                           triggerValueChange(key, valToSend, initialOldValue, false);
                        }
                        rejecters.forEach((r) => r(err));
                     });
               }, 40);

               pendingValueWrites.set(key, batchState);
            }
         });
      },
      GM_deleteValue: (key) => {
         const oldValue = storage[key];
         delete storage[key];

         triggerValueChange(key, oldValue, undefined, false);

         return requestFromBackground(MSG.GM_DELETE_VALUE, { scriptId, key })
            .catch((err) => {
               // Only rollback if the key hasn't been re-created by a newer synchronous call
               if (!(key in storage)) {
                  if (oldValue !== undefined) storage[key] = oldValue;
                  triggerValueChange(key, undefined, oldValue, false); // Rollback event
               }
               throw err;
            });
      },

      GM_addValueChangeListener: (key, callback) => {
         if (typeof callback !== 'function') throw new Error('Listener must be a function');
         const listenerId = ++listenerIdCounter;
         valueChangeListeners.set(listenerId, { key, callback });
         return listenerId;
      },
      GM_removeValueChangeListener: listenerId => valueChangeListeners.delete(listenerId),
      GM_getResourceText: (name) => {
         if (resourceCache[name]?.text != null) return resourceCache[name].text;
         // Async fallback query to background if resource wasn't in memory cache
         requestFromBackground(MSG.GM_GET_RESOURCE_TEXT, { scriptId, name })
            .then(res => {
               // Persist fetched resource into local cache so future synchronous calls return the value
               if (res?.value != null) {
                  resourceCache[name] = resourceCache[name] || {};
                  resourceCache[name].text = res.value;
               }
            })
            .catch(() => null);
         return resourceCache[name]?.text ?? null;
      },
      GM_getResourceURL: (name) => {
         if (resourceCache[name]?.url != null) return resourceCache[name].url;
         requestFromBackground(MSG.GM_GET_RESOURCE_URL, { scriptId, name })
            .then(res => {
               // Persist fetched resource URL into local cache
               if (res?.value != null) {
                  resourceCache[name] = resourceCache[name] || {};
                  resourceCache[name].url = res.value;
               }
            })
            .catch(() => null);
         return resourceCache[name]?.url ?? null;
      },

      GM_xmlhttpRequest: (details) => {
         if (!details || typeof details !== 'object') {
            originalConsole.error('GM_xmlhttpRequest requires an object argument.');
            return { abort: () => { } };
         }

         // Resolve relative URLs against the page's origin before sending to background
         try {
            details.url = new URL(details.url, window.location.href).href;
         } catch (e) {
            originalConsole.error('GM_xmlhttpRequest: Invalid URL', details.url);
            if (typeof details.onerror === 'function') {
               details.onerror({ error: 'not_supported', statusText: 'Invalid URL' });
            }
            return { abort: () => { } };
         }

         const requestId = crypto.randomUUID();

         // Register onloadend and onloadstart callbacks required by fetch polyfills
         activeXmlHttpRequests.set(requestId, {
            onload: details.onload,
            onerror: details.onerror,
            ontimeout: details.ontimeout,
            onprogress: details.onprogress,
            onreadystatechange: details.onreadystatechange,
            onabort: details.onabort,
            onloadend: details.onloadend,
            onloadstart: details.onloadstart,
            responseType: details.responseType
         });

         // Wrap request dispatch in async IIFE to safely encode massive binary payloads to Base64
         const sendRequest = async () => {
            const cleanDetails = {};
            let binaryData = null;
            let binaryType = null;

            let requestData = details.data;

            const safeKeys = nativeObjectKeys(details);
            for (const key of safeKeys) {
               const value = details[key];
               if (typeof value !== 'function' && key !== 'data') {
                  cleanDetails[key] = value;
               }
            }

            // Serialize FormData into a multipart Blob with boundary to survive IPC transport
            if (requestData instanceof FormData) {
               try {
                  const res = new Response(requestData);
                  requestData = await res.blob();
                  const headers = { ...(cleanDetails.headers || {}) };
                  headers['Content-Type'] = res.headers.get('Content-Type');
                  cleanDetails.headers = headers;
               } catch (e) {
                  originalConsole.error('Failed to serialize FormData:', e);
               }
            } else if (requestData instanceof URLSearchParams) {
               requestData = requestData.toString();
               const headers = { ...(cleanDetails.headers || {}) };
               if (!headers['Content-Type'] && !headers['content-type']) {
                  headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=utf-8';
               }
               cleanDetails.headers = headers;
            }

            if (requestData) {
               if (requestData instanceof ArrayBuffer || ArrayBuffer.isView(requestData) || requestData instanceof Blob) {
                  const blob = requestData instanceof Blob ? requestData : new Blob([requestData]);
                  binaryData = await new Promise(resolve => {
                     const reader = new FileReader();
                     reader.onload = () => resolve(reader.result.split(',')[1]);
                     reader.readAsDataURL(blob);
                  });
                  binaryType = 'Base64';
               } else {
                  cleanDetails.data = requestData;
               }
            }

            if (binaryType) {
               cleanDetails.binaryData = binaryData;
               cleanDetails.binaryType = binaryType;
            }

            try {
               postToBridge({
                  type: MSG.GM_XMLHTTPREQUEST,
                  payload: { requestId, details: cleanDetails, scriptId },
               });
            } catch (err) {
               originalConsole.error('Failed to dispatch GM_xmlhttpRequest to bridge:', err);
               activeXmlHttpRequests.delete(requestId);
               if (typeof details.onerror === 'function') {
                  try {
                     details.onerror({
                        status: 0,
                        statusText: 'Bridge IPC Failure',
                        error: err.message,
                        readyState: 4
                     });
                  } catch (cbErr) {
                     originalConsole.error('Error in GM_xmlhttpRequest fallback onerror:', cbErr);
                  }
               }
            }
         };

         sendRequest();

         return {
            abort: () => {
               if (!activeXmlHttpRequests.has(requestId)) return;
               // Do not invoke onabort locally. Background delivers onabort + readyState 4.
               postToBridge({ type: MSG.GM_XMLHTTPREQUEST_ABORT, payload: { requestId, scriptId } });
            }
         };
      },
      GM_registerMenuCommand: (caption, callback) => {
         const commandId = typeof caption === 'string' ? caption : String(caption);
         if (commands.size >= 50) {
            originalConsole.warn(`[${manifest?.name}] Too many menu commands registered for "${meta.name}". Ignoring.`);
            return commandId;
         }
         commands.set(commandId, callback);
         postToBridge({
            type: MSG.GM_REGISTER_MENU_COMMAND,
            payload: { scriptId, commandId, caption: commandId },
         });
         return commandId; // Return command ID to satisfy GM4/Tampermonkey spec and support GM_unregisterMenuCommand
      },
      GM_unregisterMenuCommand: commandId => {
         const cmdId = typeof commandId === 'string' ? commandId : String(commandId); // Cast to string
         if (commands.delete(cmdId)) {
            postToBridge({ type: MSG.GM_UNREGISTER_MENU_COMMAND, payload: { scriptId, commandId: cmdId } });
         }
      },
      GM_notification: function (detailsOrText, ondone) {
         // Support legacy GM_notification(text, title, image, onclick) signature
         const details = typeof detailsOrText === 'string'
            ? { text: detailsOrText, title: arguments[1], image: arguments[2], onclick: arguments[3] }
            : { ...detailsOrText };

         if (typeof ondone === 'function') details.ondone = ondone;

         const sendNotification = async () => {
            const notificationId = crypto.randomUUID();
            let iconUrl = details.image || details.icon || defaultIconUrl;

            // Resolve relative icon URLs against the page origin before sending to background
            if (iconUrl && typeof iconUrl === 'string' && !iconUrl.startsWith('data:') && !iconUrl.startsWith('blob:')) {
               try {
                  iconUrl = new URL(iconUrl, window.location.href).href;
               } catch (e) {
                  iconUrl = defaultIconUrl;
               }
            }

            // Convert blob: URIs to Base64 in page context
            if (typeof iconUrl === 'string' && iconUrl.startsWith('blob:')) {
               try {
                  const blob = await fetch(iconUrl).then(r => r.blob());
                  iconUrl = await new Promise(resolve => {
                     const reader = new FileReader();
                     reader.onload = () => resolve(reader.result);
                     reader.readAsDataURL(blob);
                  });
               } catch {
                  iconUrl = defaultIconUrl;
               }
            }

            const { onclick, text, title, highlight } = details;
            const hasOnClick = typeof onclick === 'function';
            const hasOnDone = typeof details.ondone === 'function';

            if (hasOnClick || hasOnDone) {
               notificationCallbacks.set(notificationId, { onclick, ondone: details.ondone });
            }

            postToBridge({
               type: MSG.GM_NOTIFICATION,
               payload: {
                  scriptId,
                  notificationId,
                  hasOnClick,
                  hasOnDone,
                  details: {
                     type: 'basic',
                     iconUrl,
                     title: title || meta.name || 'Notification',
                     message: text || '',
                     ...(highlight && { priority: 2 }),
                  },
               },
            });
         };

         sendNotification();
      },
      GM_openInTab: (url, options = {}) => {
         // Resolve relative URLs for new tabs
         try {
            url = new URL(url, window.location.href).href;
         } catch (e) { }

         const isOptionsBool = typeof options === 'boolean';
         const payload = {
            scriptId,
            url,
            // Invert boolean parameter to comply with GM spec (loadInBackground = true -> active = false)
            active: isOptionsBool ? !options : (options.active ?? true),
            insert: isOptionsBool ? false : (options.insert ?? false),
         };
         postToBridge({ type: MSG.GM_OPEN_IN_TAB, payload });
      },
      GM_addStyle: css => {
         const style = document.createElement('style');
         style.textContent = css;

         // Safely handle extremely early document-start execution where head/documentElement are null
         const target = document.head || document.documentElement || document.body;
         if (target) {
            target.appendChild(style);
         } else {
            // Defer insertion until DOM is minimally ready
            document.addEventListener('DOMContentLoaded', () => {
               (document.head || document.documentElement).appendChild(style);
            }, { once: true });
         }
         return style;
      },
      GM_addElement: (parentOrTag, tagOrAttrs, attrs) => {
         // Flexibly support both GM_addElement(tag, attrs) and GM_addElement(parentEl, tag, attrs) signatures
         let parent, tag, attributes;
         if (typeof parentOrTag === 'string') {
            tag = parentOrTag;
            attributes = tagOrAttrs || {};
            parent = document.head || document.documentElement || document.body;
         } else {
            parent = parentOrTag;
            tag = tagOrAttrs;
            attributes = attrs || {};
         }

         const el = document.createElement(tag);

         if (attributes && typeof attributes === 'object') {
            for (const [key, val] of Object.entries(attributes)) {
               if (key === 'textContent') {
                  el.textContent = val;
               } else {
                  try {
                     el.setAttribute(key, val);
                  } catch (attrErr) {
                     el[key] = val;
                  }
               }
            }
         }

         // Safely handle early document-start execution when DOM is not yet attached
         if (parent) {
            parent.appendChild(el);
         } else {
            document.addEventListener('DOMContentLoaded', () => {
               (document.head || document.documentElement || document.body)?.appendChild(el);
            }, { once: true });
         }

         return el;
      },
      GM_setClipboard: (textOrDetails, type) => {
         // Safely normalize string or object details parameter (e.g. GM_setClipboard({ data: "text" }))
         let text = textOrDetails;
         if (textOrDetails && typeof textOrDetails === 'object') {
            text = textOrDetails.data || textOrDetails.text || String(textOrDetails);
         }
         return requestFromBackground(MSG.GM_SET_CLIPBOARD, { scriptId, text: String(text ?? '') });
      },
      GM_download: (details) => {
         const payload = typeof details === 'string'
            ? { url: details, scriptId }
            : { ...details, scriptId };

         // Resolve relative URLs
         try {
            payload.url = new URL(payload.url, window.location.href).href;
         } catch (e) { }

         // Convert page-partitioned blob URLs to Base64 Data URLs so the background script can download them
         // This completely bypasses the 50MB Chrome IPC limit and prevents OOM crashes in the background worker.
         if (payload.url && (payload.url.startsWith('blob:') || payload.url.startsWith('data:'))) {
            try {
               const a = document.createElement('a');
               a.href = payload.url;
               a.download = payload.name || 'download';
               a.style.display = 'none';
               document.body.appendChild(a);
               a.click();
               document.body.removeChild(a);

               if (typeof details.onload === 'function') {
                  setTimeout(() => details.onload(), 0);
               }
            } catch (err) {
               if (typeof details.onerror === 'function') {
                  setTimeout(() => details.onerror({ error: 'not_permitted', details: err.message }), 0);
               }
            }
            return { abort: () => { } };
         }

         return requestFromBackground(MSG.GM_DOWNLOAD, payload);
      },
      GM_getTab: () => requestFromBackground(MSG.GM_GET_TAB, { scriptId }),
      GM_getTabs: () => requestFromBackground(MSG.GM_GET_TABS, { scriptId }),
      GM_closeTab: (tabId) => requestFromBackground(MSG.GM_CLOSE_TAB, { scriptId, tabId }),
      GM_onTabClose: (callback) => {
         if (typeof callback !== 'function') {
            throw new Error('GM_onTabClose: callback must be a function.');
         }
         const listenerId = crypto.randomUUID();
         tabCloseListeners.set(listenerId, callback);
         postToBridge({ type: MSG.GM_ON_TAB_CLOSE_SUBSCRIBE, payload: { scriptId } });
         return listenerId;
      },
      GM_cookie: async (details) => {
         if (!details?.method) {
            throw new Error('GM_cookie: The first argument must be an object with a "method" property.');
         }

         const { method, ...payload } = details;
         const messageTypeMap = {
            list: MSG.GM_COOKIE_LIST,
            set: MSG.GM_COOKIE_SET,
            delete: MSG.GM_COOKIE_DELETE,
         };

         const messageType = messageTypeMap[method];
         if (!messageType) {
            throw new Error(`GM_cookie: Invalid method "${method}". Supported methods are "list", "set", "delete".`);
         }

         const response = await requestFromBackground(messageType, { ...payload, scriptId });
         if (response?.success) {
            return response.value;
         }
         const errorMessage = response?.error || `GM_cookie method "${method}" failed without a specific error message.`;
         throw new Error(errorMessage);
      },
      GM_info: {
         script: {
            name: meta.name || '',
            description: meta.description || '',
            version: meta.version || '',
            author: meta.author || '',
            namespace: meta.namespace || '',
            includes: ensureArray(meta.include),
            matches: ensureArray(meta.match),
            excludeMatches: ensureArray(meta.exclude),
            require: ensureArray(meta.require),
            resource: meta.resource || {},
            resources: Object.entries(meta.resource || {}).map(([name, url]) => ({ name, url })),
            grant: ensureArray(meta.grant),
            connect: ensureArray(meta.connect),
            runAt: meta['run-at'] || 'document-end',
            noframes: !!meta.noframes,
         },
         scriptMetaStr: metaBlockStr,
         scriptHandler: manifest?.name || 'Unknown Monkey',
         version: manifest?.version || '0.0.0',
         scriptSource: userCode,
         injectInto: meta['inject-into'] || meta['inject_into'] || 'auto',
         isIncognito: Boolean(chrome?.extension?.inIncognitoContext),
      },
      GM_log: (...args) => {
         const message = args.map(arg => {
            // Correctly stringify objects for logging instead of returning parsed objects that cast to "[object Object]"
            if (typeof arg === 'string') return arg;
            try { return JSON.stringify(arg); }
            catch { return String(arg); }
         }).join(' ');

         postToBridge({
            type: MSG.LOG_MESSAGE,
            payload: {
               scriptId,
               log: {
                  level: 'log',
                  message,
                  timestamp: new Date().toISOString(),
                  stack: new Error().stack?.split('\n').slice(2).join('\n') || ''
               }
            }
         });
      },
      unsafeWindow: window,
   };

   // Hybrid mapping to support GM4 promise-based standards (GM.getValue, GM.setValue, etc.)
   const gm4Mapping = {
      info: gmAPI.GM_info,
      getValue: async (key, defaultValue) => gmAPI.GM_getValue(key, defaultValue),
      setValue: async (key, value) => gmAPI.GM_setValue(key, value),
      deleteValue: async (key) => gmAPI.GM_deleteValue(key),
      listValues: async () => gmAPI.GM_listValues(),

      xmlHttpRequest: (details) => gmAPI.GM_xmlhttpRequest(details),
      notification: (details, ondone) => gmAPI.GM_notification(details, ondone),
      openInTab: (url, options) => gmAPI.GM_openInTab(url, options),
      setClipboard: (text, type) => gmAPI.GM_setClipboard(text, type),
      registerMenuCommand: (caption, callback) => gmAPI.GM_registerMenuCommand(caption, callback),
   };

   Object.assign(gmAPI, gm4Mapping);

   // Fail closed: only expose APIs listed in the background-computed @grant allow-list
   const allow = new Set(Array.isArray(allowedApis) ? allowedApis : []);
   for (const key of nativeObjectKeys(gmAPI)) {
      if (!allow.has(key)) delete gmAPI[key];
   }

   return gmAPI;
};

/**
 * Generates the GM API provider code string and lists the granted APIs.
 *
 * @param {Object} options
 * @param {Object} [options.meta] - Parsed userscript metadata.
 * @returns {{ apiProviderCode: string, grants: string[] }}
 */
export function generateGmApiCode({ meta }) {
   const grantList = [].concat(meta?.grant || []).filter(Boolean);
   const grants = new Set(grantList.length ? grantList : ['none']);

   if (grants.has('none')) return { apiProviderCode: '() => ({})', grants: [], allowedApis: [] };

   grants.add('GM_info').add('unsafeWindow');

   return {
      apiProviderCode: apiProvider.toString(),
      grants: [...grants],
      allowedApis: [...getGrantedApiNames(grantList)],
   };
}
