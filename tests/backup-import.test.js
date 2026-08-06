import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MetadataParser } from '../js/libs/meta-parser.js';

describe('JSON Backup & Import Parsing Comprehensive Tests', () => {
   it('should correctly parse individual userscripts from JSON backup payload', () => {
      const backupJson = JSON.stringify({
         version: 1,
         timestamp: new Date().toISOString(),
         settings: { editorMode: 'codemirror', logLevel: 2 },
         scripts: [
            {
               id: 1,
               userCode: `// ==UserScript==\n// @name Test Backup Script\n// @version 1.0.0\n// @match *://*.example.com/*\n// ==/UserScript==\nconsole.log('hello');`,
               type: 'userscript',
               enabled: true,
               config: { customUrls: ['*://*.test.org/*'] },
               storage: { counter: 42 },
            },
         ],
      });

      const data = JSON.parse(backupJson);
      assert.ok(Array.isArray(data.scripts), 'Scripts array must exist in backup');
      assert.equal(data.scripts.length, 1);
      assert.equal(data.settings.editorMode, 'codemirror');

      const scriptData = data.scripts[0];
      const parsed = MetadataParser.parse(scriptData.userCode);
      assert.equal(parsed.meta.name, 'Test Backup Script');
      assert.equal(parsed.meta.version, '1.0.0');
      assert.equal(parsed.type, 'userscript');
      assert.equal(scriptData.storage.counter, 42);
      assert.deepEqual(scriptData.config.customUrls, ['*://*.test.org/*']);
   });

   it('should correctly parse UserStyles (.user.css) from JSON backup payload', () => {
      const backupJson = JSON.stringify({
         version: 1,
         scripts: [
            {
               id: 2,
               userCode: `/* ==UserStyle==\n@name Test UserStyle\n@version 2.0.0\n==/UserStyle== */\nbody { background: black; }`,
               type: 'userstyle',
               enabled: true,
            },
         ],
      });

      const data = JSON.parse(backupJson);
      const parsed = MetadataParser.parse(data.scripts[0].userCode);
      assert.equal(parsed.meta.name, 'Test UserStyle');
      assert.equal(parsed.meta.version, '2.0.0');
      assert.equal(parsed.type, 'userstyle');
   });

   it('should correctly parse multiple mixed scripts in a batch backup', () => {
      const backupJson = JSON.stringify({
         version: 1,
         scripts: [
            {
               id: 10,
               userCode: `// ==UserScript==\n// @name Script Alpha\n// @version 1.1.0\n// ==/UserScript==`,
            },
            {
               id: 11,
               userCode: `/* ==UserStyle==\n@name Theme Beta\n@version 0.5.0\n==/UserStyle== */`,
            },
            {
               id: 12,
               userCode: `// ==UserScript==\n// @name Script Gamma\n// @version 3.0.0\n// ==/UserScript==`,
            },
         ],
      });

      const data = JSON.parse(backupJson);
      assert.equal(data.scripts.length, 3);

      const parsedAlpha = MetadataParser.parse(data.scripts[0].userCode);
      const parsedBeta = MetadataParser.parse(data.scripts[1].userCode);
      const parsedGamma = MetadataParser.parse(data.scripts[2].userCode);

      assert.equal(parsedAlpha.meta.name, 'Script Alpha');
      assert.equal(parsedBeta.meta.name, 'Theme Beta');
      assert.equal(parsedBeta.type, 'userstyle');
      assert.equal(parsedGamma.meta.name, 'Script Gamma');
   });

   it('should correctly parse raw standalone .user.js files', () => {
      const rawUserScript = `// ==UserScript==\n// @name Standalone Script\n// @author John Doe\n// @version 1.2.3\n// @match https://*.github.com/*\n// @grant GM_setValue\n// @grant GM_getValue\n// ==/UserScript==\n\nGM_setValue('test', true);`;

      const parsed = MetadataParser.parse(rawUserScript);
      assert.equal(parsed.meta.name, 'Standalone Script');
      assert.equal(parsed.meta.author, 'John Doe');
      assert.equal(parsed.meta.version, '1.2.3');
      assert.deepEqual(parsed.meta.grant, ['GM_setValue', 'GM_getValue']);
      assert.equal(parsed.type, 'userscript');
   });

   it('should reject invalid scripts missing @name header', () => {
      const invalidScript = `// ==UserScript==\n// @version 1.0.0\n// ==/UserScript==\nconsole.log('no name');`;
      const parsed = MetadataParser.parse(invalidScript);
      assert.equal(parsed.meta.name, undefined);
   });
});
