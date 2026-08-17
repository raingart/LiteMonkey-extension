import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
   isAllowedScriptContentType,
   contentTypeMatchesAllowed,
} from '../js/constants.js';

describe('script Content-Type allowlist', () => {
   test('accepts javascript and text/plain, including charset', () => {
      assert.equal(isAllowedScriptContentType('application/javascript'), true);
      assert.equal(isAllowedScriptContentType('application/javascript; charset=utf-8'), true);
      assert.equal(isAllowedScriptContentType('text/javascript;charset=UTF-8'), true);
      assert.equal(isAllowedScriptContentType('application/x-javascript'), true);
      assert.equal(isAllowedScriptContentType('text/ecmascript'), true);
      assert.equal(isAllowedScriptContentType('text/plain'), true);
      assert.equal(isAllowedScriptContentType('TEXT/PLAIN; charset=utf-8'), true);
   });

   test('rejects HTML, CSS, XML, empty, and generic text/', () => {
      assert.equal(isAllowedScriptContentType('text/html'), false);
      assert.equal(isAllowedScriptContentType('text/html; charset=utf-8'), false);
      assert.equal(isAllowedScriptContentType('text/css'), false);
      assert.equal(isAllowedScriptContentType('text/xml'), false);
      assert.equal(isAllowedScriptContentType('application/json'), false);
      assert.equal(isAllowedScriptContentType(''), false);
      assert.equal(isAllowedScriptContentType(undefined), false);
   });

   test('contentTypeMatchesAllowed keeps image/ prefixes for icons', () => {
      const iconTypes = ['image/', 'image/x-icon', 'application/octet-stream'];
      assert.equal(contentTypeMatchesAllowed('image/png', iconTypes), true);
      assert.equal(contentTypeMatchesAllowed('image/svg+xml', iconTypes), true);
      assert.equal(contentTypeMatchesAllowed('text/html', iconTypes), false);
      assert.equal(contentTypeMatchesAllowed('application/javascript', ['text/javascript', 'application/javascript']), true);
      assert.equal(contentTypeMatchesAllowed('text/html; charset=utf-8', ['text/javascript', 'application/javascript', 'text/plain']), false);
   });
});
