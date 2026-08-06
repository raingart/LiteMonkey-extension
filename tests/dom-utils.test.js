import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHTML, sanitizeSafeUrl } from '../js/ui/utils/dom-utils.js';

describe('DOM Security & Sanitization Utilities (dom-utils.js)', () => {
   describe('escapeHTML()', () => {
      it('should escape dangerous HTML characters correctly', () => {
         const input = '<script>alert("xss & \'test\'")</script>';
         const expected = '&lt;script&gt;alert(&quot;xss &amp; &#39;test&#39;&quot;)&lt;/script&gt;';
         assert.equal(escapeHTML(input), expected);
      });

      it('should return empty string for null or undefined', () => {
         assert.equal(escapeHTML(null), '');
         assert.equal(escapeHTML(undefined), '');
      });

      it('should join array values with comma and space', () => {
         assert.equal(escapeHTML(['Alice', 'Bob']), 'Alice, Bob');
      });
   });

   describe('sanitizeSafeUrl()', () => {
      it('should allow valid http and https URLs', () => {
         assert.equal(sanitizeSafeUrl('https://example.com/support'), 'https://example.com/support');
         assert.equal(sanitizeSafeUrl('http://example.org'), 'http://example.org');
      });

      it('should reject javascript: URLs and return safe fallback hash', () => {
         assert.equal(sanitizeSafeUrl('javascript:alert(1)'), '#');
         assert.equal(sanitizeSafeUrl('JAVASCRIPT:void(0)'), '#');
      });

      it('should reject data: URLs and return safe fallback hash', () => {
         assert.equal(sanitizeSafeUrl('data:text/html,<script>alert(1)</script>'), '#');
      });

      it('should return safe hash for null, undefined, or empty strings', () => {
         assert.equal(sanitizeSafeUrl(null), '#');
         assert.equal(sanitizeSafeUrl(''), '#');
         assert.equal(sanitizeSafeUrl('   '), '#');
      });
   });
});
