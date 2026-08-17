import assert from 'node:assert';
import { test, describe } from 'node:test';
import { MetadataParser, META_HEADER_SEARCH_LIMIT } from '../js/libs/meta-parser.js';

describe('MetadataParser Tests', () => {
   test('should parse standard userscript metadata directives', () => {
      const code = `
// ==UserScript==
// @name         Test Script
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  A test script
// @match        https://example.com/*
// @match        https://test.org/*
// @grant        GM_setValue
// @grant        GM_getValue
// @noframes
// ==/UserScript==
console.log('hello');
      `;

      const { meta, type, metaBlockStr } = MetadataParser.parse(code);

      assert.strictEqual(type, 'userscript');
      assert.strictEqual(meta.name, 'Test Script');
      assert.strictEqual(meta.version, '1.0.0');
      assert.deepStrictEqual(meta.match, ['https://example.com/*', 'https://test.org/*']);
      assert.deepStrictEqual(meta.grant, ['GM_setValue', 'GM_getValue']);
      assert.strictEqual(meta.noframes, true);
      assert.ok(metaBlockStr.includes('// ==UserScript=='));
   });

   test('should parse localized descriptions and names', () => {
      const code = `
// ==UserScript==
// @name         Default Name
// @name:de      Deutscher Name
// @description  Default description
// @description:de  Deutsche Beschreibung
// @description:zh-CN  Simplified Chinese description
// ==/UserScript==
      `;

      const { meta } = MetadataParser.parse(code);
      assert.strictEqual(meta.name, 'Default Name');
      assert.strictEqual(meta['name:de'], 'Deutscher Name');
      assert.strictEqual(meta['description:de'], 'Deutsche Beschreibung');
      assert.strictEqual(meta['description:zh-CN'], 'Simplified Chinese description');
   });

   test('should parse @resource and @var directives', () => {
      const code = `
// ==UserScript==
// @name       Resource Script
// @resource   logo https://example.com/logo.png
// @resource   css https://example.com/style.css
// @var        "theme" "Color Theme" "dark"
// ==/UserScript==
      `;

      const { meta } = MetadataParser.parse(code);
      assert.deepStrictEqual(meta.resource, {
         logo: 'https://example.com/logo.png',
         css: 'https://example.com/style.css',
      });
      assert.deepStrictEqual(meta.var, [
         { name: 'theme', description: 'Color Theme', default: 'dark' }
      ]);
   });

   test('should correctly generate metadata block string', () => {
      const meta = {
         name: 'Generated Script',
         version: '2.1.0',
         match: ['https://example.com/*'],
         noframes: true,
         resource: { logo: 'https://example.com/logo.png' }
      };

      const block = MetadataParser.generateMetaBlock(meta);
      assert.ok(block.includes('// ==UserScript=='));
      assert.ok(block.includes('// @name Generated Script'));
      assert.ok(block.includes('// @version 2.1.0'));
      assert.ok(block.includes('// @match https://example.com/*'));
      assert.ok(block.includes('// @noframes'));
      assert.ok(block.includes('// @resource logo https://example.com/logo.png'));
      assert.ok(block.includes('// ==/UserScript=='));
   });

   test('should parse a header after a short preamble but ignore one buried in HTML', () => {
      const preamble = `#!/usr/bin/env node\n/* license */\n`;
      const header = `// ==UserScript==\n// @name Near Start\n// ==/UserScript==\n`;
      const { meta } = MetadataParser.parse(preamble + header);
      assert.strictEqual(meta.name, 'Near Start');

      const buried = `${'x'.repeat(META_HEADER_SEARCH_LIMIT + 1)}${header}`;
      const buriedResult = MetadataParser.parse(buried);
      assert.strictEqual(buriedResult.meta.name, undefined);
   });
});
