import assert from 'node:assert';
import { test, describe } from 'node:test';
import { MatchPattern } from '../js/libs/match-pattern.js';

describe('MatchPattern Class Tests', () => {
   test('should parse wildcard patterns correctly', () => {
      const pattern = new MatchPattern('*://*.domain.com/*');
      assert.strictEqual(pattern.isValid, true);
      assert.strictEqual(pattern.test('https://sub.domain.com/path'), true);
      assert.strictEqual(pattern.test('http://domain.com/path'), true);
      assert.strictEqual(pattern.test('https://other.com/path'), false);
   });

   test('should handle <all_urls> pattern', () => {
      const pattern = new MatchPattern('<all_urls>');
      assert.strictEqual(pattern.isValid, true);
      assert.strictEqual(pattern.test('https://example.com/test'), true);
      assert.strictEqual(pattern.test('http://google.com/search'), true);
   });

   test('should handle Greasemonkey http*:// syntax', () => {
      const pattern = new MatchPattern('http*://example.com/*');
      assert.strictEqual(pattern.isValid, true);
      assert.strictEqual(pattern.test('https://example.com/test'), true);
      assert.strictEqual(pattern.test('http://example.com/test'), true);
   });

   test('should strip port numbers in host permissions', () => {
      const pattern = new MatchPattern('http://localhost:8080/*');
      assert.strictEqual(pattern.isValid, true);
      const hostPerms = Array.from(pattern.toHostPermissions());
      assert.deepStrictEqual(hostPerms, ['http://localhost/*']);
   });

   test('should invalidate improper host wildcards', () => {
      const pattern = new MatchPattern('http://foo.*.bar.com/*');
      assert.strictEqual(pattern.isValid, false);
   });

   test('should generate correct host permissions for <all_urls>', () => {
      const pattern = new MatchPattern('<all_urls>');
      const hostPerms = Array.from(pattern.toHostPermissions());
      assert.deepStrictEqual(hostPerms, ['*://*/*']);
   });
});
