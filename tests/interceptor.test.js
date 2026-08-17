import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { USER_SCRIPT_REGEX, EXCLUDED_DOMAINS } from '../js/background/services/userscript-interceptor.js';

describe('DeclarativeNetRequest Interceptor Regex Tests', () => {
   const pattern = new RegExp(USER_SCRIPT_REGEX);

   it('should match valid remote HTTP/HTTPS .user.js URLs', () => {
      assert.ok(pattern.test('https://update.greasyfork.org/scripts/574417/script.user.js'));
      assert.ok(pattern.test('http://example.com/downloads/my-script.user.js'));
      assert.ok(pattern.test('https://update.greasyfork.org/scripts/574417/script.user.js?version=123'));
      assert.ok(pattern.test('https://update.greasyfork.org/scripts/574417/script.user.js#hash'));
   });

   it('should match GitHub blob .user.js URLs (excluded via excludedRequestDomains, not the regex)', () => {
      assert.ok(pattern.test('https://github.com/user/repo/blob/main/script.user.js'));
      assert.ok(EXCLUDED_DOMAINS.includes('github.com'));
      assert.equal(EXCLUDED_DOMAINS.includes('raw.githubusercontent.com'), false);
   });

   it('should REJECT internal extension installer URLs with query parameters to prevent ERR_TOO_MANY_REDIRECTS', () => {
      const extensionUrl = 'chrome-extension://doahpmljhdpkcmldgienmjopceakbjjh/html/installer.html?url=https://update.greasyfork.org/scripts/574417/script.user.js';
      assert.equal(pattern.test(extensionUrl), false, 'Must not match chrome-extension:// URLs');

      const firefoxExtensionUrl = 'moz-extension://3c80a2b7-e2a2-4a0e-9133-7bbef192b123/html/installer.html?url=https://update.greasyfork.org/scripts/574417/script.user.js';
      assert.equal(pattern.test(firefoxExtensionUrl), false, 'Must not match moz-extension:// URLs');
   });

   it('should REJECT arbitrary web pages with ?url= parameter pointing to a .user.js file', () => {
      const pageWithUrlParam = 'https://example.com/view?url=https://other.org/script.user.js';
      assert.equal(pattern.test(pageWithUrlParam), false, 'Must not match web page URLs with .user.js in query parameters');
   });
});
