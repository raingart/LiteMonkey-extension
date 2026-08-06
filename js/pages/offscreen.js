/**
 * @file Offscreen Document Request & DOM Operations Bridge
 * @description Runs inside a hidden Chrome MV3 offscreen document. Executes network fetch requests
 * and DOM-dependent operations (e.g. Clipboard write fallback) on behalf of the background Service Worker.
 */

import browser from '../libs/browser-support.js';
import { MSG } from '../message-types.js';

const CONTEXT = 'Lite Monkey Offscreen';
const DEFAULT_SAFETY_TIMEOUT_MS = 120000; // 2-minute fallback watchdog timeout

/** @type {Map<string, { controller: AbortController, tabId: number, timeoutId: ReturnType<typeof setTimeout> }>} Registry of active HTTP requests */
const activeRequests = new Map(); // Enhanced structure storing tabId and watchdog timer

// <-- Catch uncaught offscreen exceptions and notify background to prevent hanging callbacks
window.addEventListener('unhandledrejection', (event) => {
   console.error(`[${CONTEXT}] Unhandled Promise Rejection in Offscreen:`, event.reason);
   failAllActiveRequests(event.reason?.message || 'Offscreen unhandled rejection');
});

window.addEventListener('error', (event) => {
   console.error(`[${CONTEXT}] Unhandled Global Error in Offscreen:`, event.error);
   failAllActiveRequests(event.error?.message || 'Offscreen global error');
});

/**
 * Aborts all active requests and dispatches onerror callbacks to background upon offscreen crash
 * @param {string} errorMessage
 */
function failAllActiveRequests(errorMessage) {
   for (const [requestId, req] of activeRequests.entries()) {
      req.controller.abort();
      if (req.timeoutId) clearTimeout(req.timeoutId);
      browser.runtime.sendMessage({
         target: 'background',
         type: MSG.GM_XMLHTTPREQUEST_CALLBACK,
         payload: {
            tabId: req.tabId,
            frameId: req.frameId ?? 0,
            eventType: 'onerror',
            response: {
               status: 0,
               statusText: 'Offscreen Runtime Failure',
               error: errorMessage,
            },
         },
      }).catch(() => { });
   }
   activeRequests.clear();
}

/**
 * Extension runtime message listener handling offscreen document operations.
 */
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
   const { target, type, payload } = message;

   if (target !== 'offscreen') return;

   switch (type) {
      case MSG.GM_XMLHTTPREQUEST:
         handleRequest(payload);
         sendResponse({ success: true });
         return;

      case MSG.GM_XMLHTTPREQUEST_ABORT: {
         const { requestId } = payload;
         if (activeRequests.has(requestId)) {
            const req = activeRequests.get(requestId);
            req?.controller?.abort();
            if (req?.timeoutId) clearTimeout(req.timeoutId);
            activeRequests.delete(requestId);
         }
         sendResponse({ success: true });
         return;
      }

      case MSG.GM_SET_CLIPBOARD:
         handleSetClipboard(payload)
            .then(sendResponse)
            .catch(error => sendResponse({
               success: false,
               error: error?.message ?? String(error)
            }));
         return true; // Keep message channel open for async response
   }
});

/**
 * Performs an HTTP fetch request and constructs a GM_xmlhttpRequest compatible response payload.
 *
 * @param {Object} param0 - Request parameters.
 * @param {string} param0.requestId - Unique request transaction identifier.
 * @param {Object} param0.details - Request configuration (url, method, headers, binaryType, binaryData, timeout, etc.).
 * @param {number} param0.tabId - Target tab identifier for returning callbacks.
 * @returns {Promise<void>}
 */
async function handleRequest({ requestId, scriptId, details, tabId, frameId }) {
   const controller = new AbortController();
   let isTimeout = false;

   // Enforce a safety timeout if script details omit explicit timeout
   const timeoutMs = details?.timeout > 0 ? details.timeout : DEFAULT_SAFETY_TIMEOUT_MS;
   const timeoutId = setTimeout(() => {
      isTimeout = true;
      controller.abort();
   }, timeoutMs);

   activeRequests.set(requestId, { controller, tabId, frameId: frameId ?? 0, timeoutId });

   /**
    * Posts callback events back to the background Service Worker.
    *
    * @param {string} eventType - Callback event name (e.g., 'onload', 'onerror', 'ontimeout', 'onabort').
    * @param {Object} responseData - Formatted response object.
    */
   const sendCallback = (eventType, responseData) => {
      browser.runtime.sendMessage({
         target: 'background',
         type: MSG.GM_XMLHTTPREQUEST_CALLBACK,
         payload: { tabId, frameId, scriptId, requestId, eventType, response: responseData }
      }).catch((err) => {
         console.warn(`[${CONTEXT}] Failed to send callback "${eventType}" to background:`, err);
      });
   };

   try {
      const method = (details.method || 'GET').toUpperCase();
      // Respect withCredentials per GM/TM spec (defaults to same-origin to prevent CORS wildcard crashes)
      const credentialsMode = details.anonymous
         ? 'omit'
         : (details.withCredentials ? 'include' : 'same-origin');

      const fetchOptions = {
         method,
         headers: details.headers || {},
         signal: controller.signal,
         credentials: credentialsMode,
      };

      let requestBody = null;

      // Reconstruct binary body (Uint8Array / ArrayBuffer)
      if (details.binaryType === 'Base64' && details.binaryData) {
         const res = await fetch(`data:application/octet-stream;base64,${details.binaryData}`);
         requestBody = await res.arrayBuffer();
      } else if (details.data) {
         requestBody = details.data;
      }

      if (requestBody) {
         // Prevent fatal TypeError by stripping body from GET/HEAD requests
         if (method === 'GET' || method === 'HEAD') {
            console.warn(`[${CONTEXT}] Ignoring data payload for ${method} request to prevent fetch TypeError.`);
         } else {
            fetchOptions.body = requestBody;
         }
      }

      const response = await fetch(details.url, fetchOptions);

      let responseDataBody = null;
      let responseText = null;
      let binaryResponseData = null;
      let binaryResponseType = null;

      const responseType = details.responseType || 'text';

      // Binary response payloads are serialized into byte arrays for safe transport across Chrome runtime IPC channels
      if (responseType === 'blob' || responseType === 'arraybuffer') {
         responseDataBody = await response.arrayBuffer();
         binaryResponseType = responseType;

         // Convert ArrayBuffer to Base64 string via FileReader
         const blob = new Blob([responseDataBody]);
         binaryResponseData = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result); // Returns "data:application/octet-stream;base64,..."
            reader.readAsDataURL(blob);
         });
      } else {
         responseText = await response.text();
         if (responseType === 'json') {
            try {
               responseDataBody = JSON.parse(responseText);
            } catch {
               responseDataBody = null;
            }
         } else {
            responseDataBody = responseText;
         }
      }

      const responseHeaders = {};
      response.headers.forEach((val, key) => {
         responseHeaders[key] = val;
      });

      const responseHeadersStr = Array.from(response.headers.entries())
         .map(([key, value]) => `${key}: ${value}`)
         .join('\r\n');

      const respPayload = {
         status: response.status,
         statusText: response.statusText,
         responseHeaders: responseHeadersStr,
         headers: responseHeaders,
         response: binaryResponseType ? null : responseDataBody,
         binaryResponseData,
         binaryResponseType,
         responseText,
         finalUrl: response.url,
         readyState: 4,
      };

      sendCallback('onload', respPayload);

   } catch (err) {
      const isAbort = err?.name === 'AbortError';
      const eventType = isTimeout ? 'ontimeout' : (isAbort ? 'onabort' : 'onerror');

      sendCallback(eventType, {
         status: 0,
         statusText: isTimeout ? 'Request timed out' : (err?.message ?? 'Fetch request failed'),
         error: err?.message ?? String(err)
      });
   } finally {
      clearTimeout(timeoutId);
      activeRequests.delete(requestId);
   }
}

/**
 * Writes text to the system clipboard.
 * Uses navigator.clipboard.writeText when available, falling back to DOM execCommand('copy').
 *
 * @param {Object} param0
 * @param {string} param0.text - Plain text string to write to clipboard.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function handleSetClipboard({ text }) {
   if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
         await navigator.clipboard.writeText(text);
         return { success: true };
      } catch (err) {
         console.warn(`[${CONTEXT}] Native clipboard.writeText failed, falling back to execCommand:`, err);
      }
   }

   // Fallback using DOM textarea element insertion (Offscreen documents have full DOM access)
   const textarea = Object.assign(document.createElement('textarea'), {
      value: text,
      style: 'position:absolute;left:-9999px;'
   });
   document.body.append(textarea);

   try {
      textarea.select();
      if (!document.execCommand('copy')) {
         throw new Error('execCommand("copy") returned false');
      }
      return { success: true };
   } catch (err) {
      console.error(`[${CONTEXT}] Clipboard write failed:`, err);
      return { success: false, error: err?.message ?? String(err) };
   } finally {
      textarea.remove();
   }
}
