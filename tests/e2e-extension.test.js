import assert from 'node:assert';
import { test, describe } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

describe('Lite Monkey Extension Packaging & Integrity Tests', () => {
   const projectRoot = path.resolve('.');

   test('manifest.json must exist and be valid JSON', () => {
      const manifestPath = path.join(projectRoot, 'manifest.json');
      assert.ok(fs.existsSync(manifestPath), 'manifest.json must exist');
      const content = fs.readFileSync(manifestPath, 'utf8');
      const parsed = JSON.parse(content);
      assert.strictEqual(parsed.manifest_version, 3);
      assert.ok(parsed.version);
      assert.ok(parsed.background?.service_worker);
   });

   test('manifest.chrome.json must exist and be valid JSON', () => {
      const manifestPath = path.join(projectRoot, 'manifest.chrome.json');
      assert.ok(fs.existsSync(manifestPath), 'manifest.chrome.json must exist');
      const content = fs.readFileSync(manifestPath, 'utf8');
      const parsed = JSON.parse(content);
      assert.strictEqual(parsed.manifest_version, 3);
   });

   test('manifest.firefox.json must exist and be valid JSON', () => {
      const manifestPath = path.join(projectRoot, 'manifest.firefox.json');
      assert.ok(fs.existsSync(manifestPath), 'manifest.firefox.json must exist');
      const content = fs.readFileSync(manifestPath, 'utf8');
      const parsed = JSON.parse(content);
      assert.strictEqual(parsed.manifest_version, 3);
      assert.ok(parsed.browser_specific_settings?.gecko?.id);
      assert.strictEqual(parsed.background?.type, 'module');
      assert.ok(parsed.background?.service_worker);
      assert.deepEqual(parsed.background?.scripts, [parsed.background.service_worker]);
   });

   test('installer host_permissions cover GreasyFork site and update CDNs', () => {
      const requiredHosts = [
         '*://greasyfork.org/*',
         '*://update.greasyfork.org/*',
         '*://sleazyfork.org/*',
         '*://update.sleazyfork.org/*',
      ];
      for (const file of ['manifest.json', 'manifest.chrome.json', 'manifest.firefox.json']) {
         const parsed = JSON.parse(fs.readFileSync(path.join(projectRoot, file), 'utf8'));
         for (const host of requiredHosts) {
            assert.ok(
               parsed.host_permissions?.includes(host),
               `${file} missing host_permission ${host}`
            );
         }
      }
   });

   test('Core HTML pages and essential JS entrypoints must exist', () => {
      const essentialFiles = [
         'html/popup.html',
         'html/options.html',
         'html/installer.html',
         'js/background/main.js',
         'js/bootstrap.js',
         'js/gm-api-provider.js',
         'js/database.js',
         'css/style.css'
      ];

      for (const file of essentialFiles) {
         const filePath = path.join(projectRoot, file);
         assert.ok(fs.existsSync(filePath), `Essential file missing: ${file}`);
      }
   });

   test('options and popup HTML button tags are balanced', () => {
      for (const file of ['html/options.html', 'html/popup.html', 'html/installer.html']) {
         const html = fs.readFileSync(path.join(projectRoot, file), 'utf8');
         const opens = (html.match(/<button\b/gi) || []).length;
         const closes = (html.match(/<\/button>/gi) || []).length;
         assert.equal(opens, closes, `${file}: ${opens} opening vs ${closes} closing <button> tags`);
      }
   });

   test('paused popup list does not disable pointer events on script items', () => {
      const css = fs.readFileSync(path.join(projectRoot, 'css/style.css'), 'utf8');
      const pausedRule = css.match(/#script-list\.is-paused\s+\.script-item\s*\{[^}]+\}/);
      assert.ok(pausedRule, 'paused script-item rule missing');
      assert.equal(/pointer-events\s*:\s*none/i.test(pausedRule[0]), false);
   });

   test('All internal ES module imports in background entrypoint should exist', () => {
      const mainJsPath = path.join(projectRoot, 'js/background/main.js');
      const content = fs.readFileSync(mainJsPath, 'utf8');
      const importMatches = [...content.matchAll(/import\s+.*?\s+from\s+['"](.*?)['"]/g)];

      for (const match of importMatches) {
         const relPath = match[1];
         const resolvedPath = path.resolve(path.dirname(mainJsPath), relPath);
         assert.ok(
            fs.existsSync(resolvedPath),
            `Broken import in main.js: ${relPath} -> ${resolvedPath}`
         );
      }
   });

   test('Content scripts and provider modules must be valid JavaScript syntax', async () => {
      const vm = await import('node:vm');
      const bootstrapCode = fs.readFileSync(path.join(projectRoot, 'js/bootstrap.js'), 'utf8');

      // Test bootstrap.js IIFE non-module script syntax
      assert.doesNotThrow(() => {
         new vm.Script(bootstrapCode, { filename: 'js/bootstrap.js' });
      }, 'SyntaxError in js/bootstrap.js');

      // Test page entrypoint ES module syntax via dynamic import
      const pageFiles = ['../js/pages/popup.js', '../js/gm-api-provider.js'];
      global.document = global.document || { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
      global.window = global.window || { addEventListener: () => {} };
      for (const pageFile of pageFiles) {
         await assert.doesNotReject(async () => {
            await import(pageFile);
         }, `SyntaxError in ${pageFile}`);
      }
   });

   test('_locales/en/messages.json must have valid Chrome i18n placeholder declarations', () => {
      const messagesPath = path.join(projectRoot, '_locales/en/messages.json');
      assert.ok(fs.existsSync(messagesPath), '_locales/en/messages.json must exist');
      const messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));

      for (const [key, item] of Object.entries(messages)) {
         const msg = item.message || '';
         const matches = [...msg.matchAll(/\$([A-Z0-9_]+)\$/gi)];
         for (const match of matches) {
            const varName = match[1].toLowerCase();
            assert.ok(
               item.placeholders && item.placeholders[varName],
               `i18n key "${key}" uses variable $${match[1]}$ but lacks "placeholders.${varName}" in messages.json`
            );
         }
      }
   });
});
