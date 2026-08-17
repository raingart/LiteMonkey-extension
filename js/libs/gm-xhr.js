/**
 * @module GmXhr
 * @description Shared GM_xmlhttpRequest fetch implementation for the Chrome offscreen
 * document and the Firefox service-worker fallback (no offscreen API).
 */

export const DEFAULT_XHR_TIMEOUT_MS = 120000;

/**
 * Executes a GM_xmlhttpRequest-compatible fetch and returns a serializable response payload.
 *
 * @param {object} details Userscript request details (url, method, headers, data, binaryType, …).
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<object>} Payload forwarded to onload callbacks.
 */
export async function executeGmXmlHttpRequest(details, { signal } = {}) {
   const method = (details.method || 'GET').toUpperCase();
   const credentialsMode = details.anonymous
      ? 'omit'
      : (details.withCredentials ? 'include' : 'same-origin');

   const fetchOptions = {
      method,
      headers: details.headers || {},
      signal,
      credentials: credentialsMode,
   };

   let requestBody = null;
   if (details.binaryType === 'Base64' && details.binaryData) {
      const res = await fetch(`data:application/octet-stream;base64,${details.binaryData}`);
      requestBody = await res.arrayBuffer();
   } else if (details.data) {
      requestBody = details.data;
   }

   if (requestBody) {
      if (method === 'GET' || method === 'HEAD') {
         console.warn('[LiteMonkey XHR] Ignoring data payload for GET/HEAD request.');
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

   if (responseType === 'blob' || responseType === 'arraybuffer') {
      responseDataBody = await response.arrayBuffer();
      binaryResponseType = responseType;
      const blob = new Blob([responseDataBody]);
      binaryResponseData = await new Promise((resolve, reject) => {
         const reader = new FileReader();
         reader.onload = () => resolve(reader.result);
         reader.onerror = () => reject(new Error('Failed to encode binary XHR response.'));
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

   return {
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
}

/**
 * Maps a fetch failure onto a GM_xmlhttpRequest callback event.
 *
 * @param {Error} err
 * @param {boolean} isTimeout
 * @returns {{ eventType: string, response: object }}
 */
export function classifyXhrError(err, isTimeout) {
   const isAbort = err?.name === 'AbortError';
   const eventType = isTimeout ? 'ontimeout' : (isAbort ? 'onabort' : 'onerror');
   return {
      eventType,
      response: {
         status: 0,
         statusText: isTimeout ? 'Request timed out' : (err?.message ?? 'Fetch request failed'),
         error: err?.message ?? String(err),
      },
   };
}
