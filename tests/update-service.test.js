import assert from 'node:assert';
import { test, describe } from 'node:test';
import { compareSemanticVersions } from '../js/background/services/update-service.js';

describe('UpdateService compareSemanticVersions Tests', () => {
   test('should correctly compare basic version strings', () => {
      assert.strictEqual(compareSemanticVersions('1.0.0', '1.0.1'), 1); // 1.0.1 is newer
      assert.strictEqual(compareSemanticVersions('1.2.0', '1.1.9'), -1); // 1.2.0 is newer
      assert.strictEqual(compareSemanticVersions('2.0.0', '2.0.0'), 0); // equal
   });

   test('should handle v-prefixes gracefully', () => {
      assert.strictEqual(compareSemanticVersions('v1.2.3', '1.2.3'), 0);
      assert.strictEqual(compareSemanticVersions('v1.2.3', 'v1.2.4'), 1);
      assert.strictEqual(compareSemanticVersions('V2.1', 'v2.0.9'), -1);
   });

   test('should handle pre-release version tags', () => {
      // Release version is newer than pre-release version
      assert.strictEqual(compareSemanticVersions('1.0.0-beta', '1.0.0'), 1);
      assert.strictEqual(compareSemanticVersions('1.0.0', '1.0.0-beta'), -1);

      // Comparing pre-releases numerically
      assert.strictEqual(compareSemanticVersions('1.0.0-alpha', '1.0.0-beta'), 1);
      assert.strictEqual(compareSemanticVersions('1.0.0-beta.2', '1.0.0-beta.10'), 1);
   });

   test('should handle variable length version segments', () => {
      assert.strictEqual(compareSemanticVersions('1.0.0', '1.0.0.1'), 1);
      assert.strictEqual(compareSemanticVersions('1.0.0.1', '1.0.0'), -1);
      assert.strictEqual(compareSemanticVersions('1.0.0.0', '1.0.0'), 0);
   });

   test('should handle arrays or undefined input safely', () => {
      assert.strictEqual(compareSemanticVersions(['1.0.0', '1.0.1'], '1.0.2'), 1);
      assert.strictEqual(compareSemanticVersions(null, '1.0.0'), 1);
      assert.strictEqual(compareSemanticVersions('1.0.0', undefined), -1);
   });
});
