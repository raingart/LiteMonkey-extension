import assert from 'node:assert';
import { test, describe } from 'node:test';
import { extractMatchPatternsFromStyle, isRegexLiteralRule } from '../js/libs/userstyle-rules.js';
import Utils from '../js/background/utils.js';
import fs from 'node:fs';
import path from 'node:path';

describe('UserStyle @-moz-document match inference', () => {
   test('extracts domain and url-prefix rules from @-moz-document', () => {
      const code = fs.readFileSync(
         path.join(path.resolve('.'), 'tests/test-scripts/05-userstyle-test.user.css'),
         'utf8'
      );
      const patterns = extractMatchPatternsFromStyle(code);
      assert.ok(patterns.includes('*://example.com/*'));
      assert.ok(patterns.includes('*://*.example.com/*'));
      assert.ok(patterns.includes('*://httpbin.org/*'));
   });

   test('isRunnableOnUrl is true for a UserStyle with no @match header', () => {
      const userCode = fs.readFileSync(
         path.join(path.resolve('.'), 'tests/test-scripts/05-userstyle-test.user.css'),
         'utf8'
      );
      const script = {
         type: 'userstyle',
         userCode,
         meta: { name: 'LiteMonkey Test - UserStyle' },
      };
      assert.strictEqual(Utils.isRunnableOnUrl(script, 'https://example.com/foo'), true);
      assert.strictEqual(Utils.isRunnableOnUrl(script, 'https://other.test/foo'), false);
   });

   test('iframe-only @match still applies to that frame, not the parent tab', () => {
      const style = {
         type: 'userstyle',
         meta: { match: ['*://widget.example/*'] },
         userCode: 'body { color: red; }',
      };
      assert.equal(Utils.isRunnableOnUrl(style, 'https://parent.example/page'), false);
      assert.equal(Utils.isRunnableOnUrl(style, 'https://widget.example/embed'), true);
      assert.equal(
         Utils.isStyleApplicableToFrame(style, 'https://widget.example/embed', 'https://parent.example/page'),
         true
      );
      assert.equal(
         Utils.isStyleApplicableToFrame(style, 'https://other.test/embed', 'https://parent.example/page'),
         false
      );
   });

   test('top-page @match still applies to iframes for @-moz-document filtering', () => {
      const style = {
         type: 'userstyle',
         meta: { match: ['*://parent.example/*'] },
         userCode: '@-moz-document domain("widget.example") { body { color: blue; } }',
      };
      assert.equal(
         Utils.isStyleApplicableToFrame(style, 'https://widget.example/embed', 'https://parent.example/page'),
         true
      );
   });
});

describe('Permission classification for regex @include', () => {
   test('isRegexLiteralRule detects /pattern/ flags', () => {
      assert.equal(isRegexLiteralRule('/https:\\/\\/example\\.com\\/.*/'), true);
      assert.equal(isRegexLiteralRule('*://example.com/*'), false);
      assert.equal(isRegexLiteralRule('//cdn.example.com/app.js'), false);
   });

   test('classifyMatchRulesForPermissions requests all_urls for regex includes', () => {
      const { hostPatterns, needsAllUrls } = Utils.classifyMatchRulesForPermissions([
         '/https:\\/\\/.*\\.google\\.com\\/search/',
      ]);
      assert.equal(needsAllUrls, true);
      assert.deepStrictEqual(hostPatterns, []);
   });

   test('classifyMatchRulesForPermissions keeps valid match patterns', () => {
      const { hostPatterns, needsAllUrls } = Utils.classifyMatchRulesForPermissions([
         '*://example.com/*',
      ]);
      assert.equal(needsAllUrls, false);
      assert.ok(hostPatterns.includes('*://example.com/*'));
   });
});
