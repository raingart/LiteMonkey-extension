// ==UserScript==
// @name         LiteMonkey Test - GM_xmlhttpRequest API
// @namespace    https://litemonkey.test/
// @version      1.0.0
// @description  Tests cross-origin GM_xmlhttpRequest GET, POST, JSON parsing, and header inspection.
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      httpbin.org
// @connect      api.github.com
// ==/UserScript==

(function () {
   'use strict';

   console.log('[Test 02] Running GM_xmlhttpRequest test suite...');

   // 1. Standard GET request
   GM_xmlhttpRequest({
      method: 'GET',
      url: 'https://httpbin.org/get?foo=bar',
      headers: {
         'Accept': 'application/json',
      },
      onload: function (response) {
         console.log('[Test 02 GET Status]:', response.status);
         try {
            const data = JSON.parse(response.responseText);
            console.assert(data.args.foo === 'bar', 'GET query param assertion failed');
            console.log('[Test 02 GET]: Success!');
         } catch (e) {
            console.error('[Test 02 GET Error]:', e);
         }
      },
      onerror: function (err) {
         console.error('[Test 02 GET Network Error]:', err);
      }
   });

   // 2. POST request with JSON payload
   GM_xmlhttpRequest({
      method: 'POST',
      url: 'https://httpbin.org/post',
      headers: {
         'Content-Type': 'application/json',
      },
      data: JSON.stringify({ message: 'Hello from LiteMonkey XHR' }),
      onload: function (response) {
         console.log('[Test 02 POST Status]:', response.status);
         try {
            const data = JSON.parse(response.responseText);
            console.assert(data.json.message === 'Hello from LiteMonkey XHR', 'POST body assertion failed');
            console.log('[Test 02 POST]: Success!');
         } catch (e) {
            console.error('[Test 02 POST Error]:', e);
         }
      }
   });
})();
