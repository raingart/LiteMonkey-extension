import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { evaluateUrlRules, parseRuleToRegex } from '../js/libs/match-rule.js';

describe('evaluateUrlRules (editor tester / injection engine)', () => {
   test('regex @include matches the same URLs as parseRuleToRegex', () => {
      const matches = ['/https:\\/\\/.*\\.google\\.com\\/search/'];
      assert.equal(parseRuleToRegex(matches[0]).test('https://www.google.com/search?q=test'), true);

      const hit = evaluateUrlRules('https://www.google.com/search?q=test', matches, []);
      assert.equal(hit.isMatched, true);
      assert.equal(hit.passed, true);

      const miss = evaluateUrlRules('https://www.google.com/maps', matches, []);
      assert.equal(miss.isMatched, false);
      assert.equal(miss.passed, false);
   });

   test('regex @exclude is honored', () => {
      const result = evaluateUrlRules(
         'https://example.com/admin',
         ['*://example.com/*'],
         ['/example\\.com\\/admin/']
      );
      assert.equal(result.isMatched, true);
      assert.equal(result.isExcluded, true);
      assert.equal(result.passed, false);
   });

   test('MatchPattern-style wildcards still work', () => {
      const result = evaluateUrlRules('https://example.com/foo', ['https://example.com/*'], []);
      assert.equal(result.passed, true);
   });
});
