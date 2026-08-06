// ==UserScript==
// @name         LiteMonkey Test - Menu Commands & Events
// @namespace    https://litemonkey.test/
// @version      1.0.0
// @description  Tests GM_registerMenuCommand, GM_notification, and GM_setClipboard.
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_notification
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
   'use strict';

   console.log('[Test 04] Registering menu commands...');

   // 1. GM_registerMenuCommand
   const cmdId1 = GM_registerMenuCommand('🐒 Trigger Notification', function () {
      GM_notification({
         title: 'LiteMonkey Test',
         text: 'Menu command triggered successfully!',
         timeout: 3000
      });
   });

   const cmdId2 = GM_registerMenuCommand('📋 Copy Test String to Clipboard', function () {
      GM_setClipboard('LiteMonkey Clipboard Test Data');
      console.log('[Test 04]: Copied to clipboard.');
   });

   console.log('[Test 04 Menu Commands Registered]:', cmdId1, cmdId2);
})();
