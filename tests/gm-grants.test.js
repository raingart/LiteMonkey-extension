import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getGrantedApiNames, messageAllowedByGrants } from '../js/gm-grants.js';
import { generateGmApiCode } from '../js/gm-api-provider.js';

describe('GM @grant allow-list', () => {
   it('exposes no APIs for @grant none or empty grants', () => {
      assert.equal(getGrantedApiNames(['none']).size, 0);
      assert.equal(getGrantedApiNames([]).size, 0);
      assert.equal(getGrantedApiNames(undefined).size, 0);
   });

   it('does not expose XHR/cookie/download when only storage is granted', () => {
      const allowed = getGrantedApiNames(['GM_setValue', 'GM_getValue']);
      assert.ok(allowed.has('GM_setValue'));
      assert.ok(allowed.has('GM_getValue'));
      assert.ok(allowed.has('setValue'));
      assert.ok(allowed.has('GM_info'));
      assert.ok(allowed.has('unsafeWindow'));
      assert.equal(allowed.has('GM_xmlhttpRequest'), false);
      assert.equal(allowed.has('xmlHttpRequest'), false);
      assert.equal(allowed.has('GM_cookie'), false);
      assert.equal(allowed.has('GM_download'), false);
      assert.equal(allowed.has('GM_openInTab'), false);
   });

   it('unlocks both GM_* and GM4 aliases from either grant form', () => {
      const fromLegacy = getGrantedApiNames(['GM_xmlhttpRequest']);
      const fromGm4 = getGrantedApiNames(['GM.xmlHttpRequest']);
      assert.ok(fromLegacy.has('GM_xmlhttpRequest') && fromLegacy.has('xmlHttpRequest'));
      assert.ok(fromGm4.has('GM_xmlhttpRequest') && fromGm4.has('xmlHttpRequest'));

      const storageGm4 = getGrantedApiNames(['GM.setValue']);
      assert.ok(storageGm4.has('GM_setValue'));
      assert.ok(storageGm4.has('setValue'));
   });

   it('keeps GM_info and unsafeWindow when any real grant is present', () => {
      const allowed = getGrantedApiNames(['GM_addStyle']);
      assert.ok(allowed.has('GM_info'));
      assert.ok(allowed.has('unsafeWindow'));
      assert.ok(allowed.has('GM_addStyle'));
      assert.equal(allowed.has('GM_xmlhttpRequest'), false);
   });

   it('passes a matching allow-list into the stringified API provider', () => {
      const { allowedApis, grants } = generateGmApiCode({ meta: { grant: ['GM_setValue'] } });
      assert.ok(grants.includes('GM_setValue'));
      assert.ok(allowedApis.includes('GM_setValue'));
      assert.ok(allowedApis.includes('setValue'));
      assert.equal(allowedApis.includes('GM_xmlhttpRequest'), false);
      assert.equal(allowedApis.includes('GM_cookie'), false);
   });

   it('rejects background GM messages that the script did not grant', () => {
      const grants = ['GM_setValue'];
      assert.equal(messageAllowedByGrants('gm-set-value', grants), true);
      assert.equal(messageAllowedByGrants('gm-xmlhttprequest', grants), false);
      assert.equal(messageAllowedByGrants('gm-cookie-list', grants), false);
      assert.equal(messageAllowedByGrants('gm-open-in-tab', grants), false);
      assert.equal(messageAllowedByGrants('gm-download', grants), false);
   });

   it('denies unknown gm-* message types from page context', () => {
      assert.equal(messageAllowedByGrants('gm-eval-code', ['GM_xmlhttpRequest']), false);
   });

   it('allows non-GM messages and internal GM callback types', () => {
      assert.equal(messageAllowedByGrants('get-tab-scripts', []), true);
      assert.equal(messageAllowedByGrants('gm-xmlhttprequest-callback', []), true);
      assert.equal(messageAllowedByGrants('gm-api-response', []), true);
   });
});
