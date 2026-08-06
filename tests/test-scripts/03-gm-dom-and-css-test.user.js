// ==UserScript==
// @name         LiteMonkey Test - DOM, Style & Resources
// @namespace    https://litemonkey.test/
// @version      1.0.0
// @description  Tests GM_addStyle, GM_addElement, @require dependency loading, and @resource.
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_addElement
// @grant        GM_getResourceText
// @grant        GM_getResourceURL
// @require      https://code.jquery.com/jquery-3.7.1.min.js
// @resource     sampleCSS https://cdnjs.cloudflare.com/ajax/libs/normalize/8.0.1/normalize.min.css
// ==/UserScript==

(function () {
   'use strict';

   console.log('[Test 03] Running DOM & Style test suite...');

   // 1. @require jQuery verification
   if (typeof jQuery !== 'undefined') {
      console.log('[Test 03 @require]: jQuery loaded successfully (v' + $.fn.jquery + ')');
   } else {
      console.error('[Test 03 @require]: jQuery failed to load!');
   }

   // 2. GM_addStyle
   const styleEl = GM_addStyle(`
      .litemonkey-test-banner {
         position: fixed;
         bottom: 10px;
         right: 10px;
         background: #27a6e5;
         color: white;
         padding: 8px 14px;
         border-radius: 6px;
         font-family: sans-serif;
         font-size: 13px;
         z-index: 999999;
         box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      }
   `);
   console.assert(styleEl instanceof HTMLStyleElement, 'GM_addStyle failed to return style element');

   // 3. GM_addElement
   const banner = GM_addElement('div', {
      class: 'litemonkey-test-banner',
      textContent: '🐒 LiteMonkey Active'
   });
   console.assert(banner instanceof HTMLElement, 'GM_addElement failed');

   // 4. @resource checks
   const cssText = GM_getResourceText('sampleCSS');
   console.log('[Test 03 @resource text length]:', cssText ? cssText.length : 0);

   const cssUrl = GM_getResourceURL('sampleCSS');
   console.log('[Test 03 @resource url]:', cssUrl ? cssUrl.slice(0, 30) + '...' : 'null');
})();
