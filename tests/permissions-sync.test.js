import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Grant-to-Permission mapping table extracted for testing logic consistency.
 */
const GRANT_TO_PERMISSION_MAP = {
   GM_notification: ['notifications'],
   'GM.notification': ['notifications'],
   GM_download: ['downloads'],
   'GM.download': ['downloads'],
   GM_setClipboard: ['clipboardWrite'],
   'GM.setClipboard': ['clipboardWrite'],
   GM_getTab: ['tabs'],
   'GM.getTab': ['tabs'],
   GM_getTabs: ['tabs'],
   'GM.getTabs': ['tabs'],
   GM_closeTab: ['tabs'],
   'GM.closeTab': ['tabs'],
   GM_cookie: ['cookies'],
   'GM.cookie': ['cookies'],
};

function aggregateRequiredPermissions(meta) {
   const required = {
      origins: new Set(),
      permissions: new Set(),
   };

   const grants = [].concat(meta?.grant || []);
   grants.forEach((grant) => {
      const perms = GRANT_TO_PERMISSION_MAP[grant];
      if (perms) perms.forEach((p) => required.permissions.add(p));
   });

   return {
      origins: Array.from(required.origins),
      permissions: Array.from(required.permissions),
   };
}

describe('Permissions Aggregation Logic Tests', () => {
   it('should correctly aggregate distinct browser permissions for multiple @grants', () => {
      const meta = {
         grant: ['GM_notification', 'GM_download', 'GM_cookie', 'GM_setClipboard', 'GM_getTab', 'GM_closeTab'],
      };

      const result = aggregateRequiredPermissions(meta);
      assert.deepEqual(result.permissions.sort(), [
         'clipboardWrite',
         'cookies',
         'downloads',
         'notifications',
         'tabs',
      ]);
   });

   it('should deduplicate overlapping permissions across legacy GM_ and modern GM. grant names', () => {
      const meta = {
         grant: ['GM_notification', 'GM.notification', 'GM_download', 'GM.download'],
      };

      const result = aggregateRequiredPermissions(meta);
      assert.deepEqual(result.permissions.sort(), ['downloads', 'notifications']);
   });

   it('should return empty arrays when no grants requiring extension permissions are declared', () => {
      const meta = {
         grant: ['none', 'GM_setValue', 'GM_getValue'],
      };

      const result = aggregateRequiredPermissions(meta);
      assert.equal(result.permissions.length, 0);
   });
});
