import assert from 'node:assert';
import { test, describe } from 'node:test';
import Utils from '../js/background/utils.js';
import { excludeRuleAppliesToHostname, formatSiteExcludeRule } from '../js/libs/origin-guard.js';

describe('Utils getEffectiveRules and isRunnableOnUrl Tests', () => {
   test('should preserve original meta matches when customUrls only contains excludes (-rule)', () => {
      const script = {
         meta: {
            match: ['*://example.com/*'],
            exclude: ['*://example.com/login'],
         },
         customUrls: '-https://example.com/logout',
      };

      const rules = Utils.getEffectiveRules(script);

      assert.deepStrictEqual(rules.matches, ['*://example.com/*']);
      assert.deepStrictEqual(rules.excludes, ['*://example.com/login', 'https://example.com/logout']);
   });

   test('should override meta matches when customUrls contains positive matches', () => {
      const script = {
         meta: {
            match: ['*://example.com/*'],
         },
         customUrls: 'https://test.org/*\n-https://test.org/admin',
      };

      const rules = Utils.getEffectiveRules(script);

      assert.deepStrictEqual(rules.matches, ['https://test.org/*']);
      assert.deepStrictEqual(rules.excludes, ['https://test.org/admin']);
   });

   test('should correctly evaluate isRunnableOnUrl with custom exclusions', () => {
      const script = {
         meta: {
            match: ['*://github.com/*'],
         },
         customUrls: '-https://github.com/settings/*',
      };

      assert.strictEqual(Utils.isRunnableOnUrl(script, 'https://github.com/torvalds/linux'), true);
      assert.strictEqual(Utils.isRunnableOnUrl(script, 'https://github.com/settings/profile'), false);
   });

   test('should evaluate wildcard and regex rules in isRunnableOnUrl', () => {
      const script = {
         meta: {
            include: ['/https:\\/\\/.*\\.google\\.com\\/search/'],
         },
      };

      assert.strictEqual(Utils.isRunnableOnUrl(script, 'https://www.google.com/search?q=test'), true);
      assert.strictEqual(Utils.isRunnableOnUrl(script, 'https://www.google.com/maps'), false);
   });

   test('should correctly identify scripts explicitly excluded on target URL', () => {
      const script = {
         meta: { match: ['*://youtube.com/*'] },
         customUrls: '-*://youtube.com/*',
      };

      assert.strictEqual(Utils.isRunnableOnUrl(script, 'https://youtube.com/watch?v=123'), false);
      assert.strictEqual(Utils.isRunnableOnUrl({ meta: script.meta }, 'https://youtube.com/watch?v=123'), true);
   });

   test('old popup site-exclude -*://example.com/* also blocks www', () => {
      const script = {
         meta: { match: ['*://*/*'] },
         customUrls: '-*://example.com/*',
      };

      assert.equal(Utils.isRunnableOnUrl(script, 'https://example.com/foo'), false);
      assert.equal(Utils.isRunnableOnUrl(script, 'https://www.example.com/foo'), false);
      assert.equal(Utils.isRunnableOnUrl(script, 'https://app.example.com/foo'), false);
      assert.equal(Utils.isRunnableOnUrl(script, 'https://notexample.com/foo'), true);
   });

   test('path-specific custom exclude is not upgraded to a site-wide wildcard', () => {
      const script = {
         meta: { match: ['*://github.com/*'] },
         customUrls: '-https://github.com/settings/*',
      };

      const rules = Utils.getEffectiveRules(script);
      assert.deepStrictEqual(rules.excludes, ['https://github.com/settings/*']);
      assert.equal(Utils.isRunnableOnUrl(script, 'https://github.com/torvalds/linux'), true);
      assert.equal(Utils.isRunnableOnUrl(script, 'https://github.com/settings/profile'), false);
   });

   test('popup site-exclude blocks apex, www, and subdomains, not sibling hosts', () => {
      const script = {
         meta: { match: ['*://*/*'] },
         customUrls: formatSiteExcludeRule('www.example.com'),
      };

      assert.equal(script.customUrls, '-*://*.example.com/*');
      assert.equal(Utils.isRunnableOnUrl(script, 'https://example.com/foo'), false);
      assert.equal(Utils.isRunnableOnUrl(script, 'https://www.example.com/foo'), false);
      assert.equal(Utils.isRunnableOnUrl(script, 'https://app.example.com/foo'), false);
      assert.equal(Utils.isRunnableOnUrl(script, 'https://notexample.com/foo'), true);
      assert.equal(excludeRuleAppliesToHostname(script.customUrls, 'www.example.com'), true);
      assert.equal(excludeRuleAppliesToHostname(script.customUrls, 'notexample.com'), false);
   });

   test('path-only custom exclude does not disable the rest of the site', () => {
      const script = {
         meta: { match: ['*://github.com/*'] },
         customUrls: '-https://github.com/settings/*',
      };

      assert.equal(Utils.isRunnableOnUrl(script, 'https://github.com/torvalds/linux'), true);
      assert.equal(Utils.isRunnableOnUrl(script, 'https://github.com/settings/profile'), false);
   });

   test('meta @exclude still applies together with a popup site exclude', () => {
      const script = {
         meta: {
            match: ['*://*.google.com/*'],
            exclude: ['*://www.google.com/maps*'],
         },
         customUrls: formatSiteExcludeRule('youtube.com'),
      };

      assert.equal(Utils.isRunnableOnUrl(script, 'https://www.google.com/search'), true);
      assert.equal(Utils.isRunnableOnUrl(script, 'https://www.google.com/maps'), false);
      assert.equal(Utils.isRunnableOnUrl(script, 'https://mail.google.com/'), true);
   });
});
