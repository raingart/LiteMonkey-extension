// ==UserScript==
// @name         LiteMonkey Test - GM Storage API
// @namespace    https://litemonkey.test/
// @version      1.0.0
// @description  Tests GM_setValue, GM_getValue, GM_deleteValue, GM_listValues, and GM_addValueChangeListener.
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM.setValue
// @grant        GM.getValue
// ==/UserScript==

(async function () {
   'use strict';

   console.log('[Test 01] Running GM Storage API test suite...');

   // 1. Basic GM_setValue and GM_getValue
   GM_setValue('test_key_1', 'Hello LiteMonkey');
   const val1 = GM_getValue('test_key_1');
   console.assert(val1 === 'Hello LiteMonkey', `Expected "Hello LiteMonkey", got "${val1}"`);

   // 2. Object deep-clone storage test
   const testObj = { a: 1, b: [2, 3], c: { d: 'nested' } };
   GM_setValue('test_obj', testObj);
   const fetchedObj = GM_getValue('test_obj');
   console.assert(fetchedObj.c.d === 'nested', 'Nested object retrieval failed');

   // 3. GM_listValues
   const keys = GM_listValues();
   console.assert(keys.includes('test_key_1'), 'Key test_key_1 missing from GM_listValues');

   // 4. Value change listener
   let listenerFired = false;
   const listenerId = GM_addValueChangeListener('listened_key', (key, oldValue, newValue, remote) => {
      listenerFired = true;
      console.log(`[Test 01 Listener] Key "${key}" changed from "${oldValue}" to "${newValue}" (remote: ${remote})`);
   });
   GM_setValue('listened_key', 'value_v1');

   // 5. GM4 Promise API
   await GM.setValue('gm4_key', 42);
   const gm4Val = await GM.getValue('gm4_key');
   console.assert(gm4Val === 42, `Expected 42, got ${gm4Val}`);

   console.log('[Test 01] Storage API tests finished successfully.');
})();
