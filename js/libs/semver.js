/**
 * @module Semver
 * @description Semantic version comparison used by auto-update and the installer UI.
 */

const toScalarString = (val) => {
   if (Array.isArray(val)) return String(val[val.length - 1] ?? '').trim();
   if (val == null) return '';
   return String(val).trim();
};

/**
 * Compares two semantic version strings (e.g. "1.2.3-beta.2" vs "1.3.0").
 *
 * @param {string|string[]} versionA Current / installed version.
 * @param {string|string[]} versionB Candidate / remote version.
 * @returns {number} Positive if versionB is newer, negative if versionA is newer, 0 if equal.
 */
export function compareSemanticVersions(versionA, versionB) {
   const strA = toScalarString(versionA);
   const strB = toScalarString(versionB);

   const safeA = (strA || '0').replace(/^v/i, '');
   const safeB = (strB || '0').replace(/^v/i, '');

   const [mainA, preA = ''] = safeA.split('-');
   const [mainB, preB = ''] = safeB.split('-');

   const partsA = mainA.split('.').map(Number).filter(Number.isFinite);
   const partsB = mainB.split('.').map(Number).filter(Number.isFinite);
   const maxLength = Math.max(partsA.length, partsB.length);

   for (let i = 0; i < maxLength; i++) {
      const partA = partsA[i] ?? 0;
      const partB = partsB[i] ?? 0;
      if (partB > partA) return 1;
      if (partA > partB) return -1;
   }

   // A release (no pre-release tag) is newer than a pre-release of the same numbers
   if (preA && !preB) return 1;
   if (!preA && preB) return -1;
   if (preA && preB) return preB.localeCompare(preA, undefined, { numeric: true });

   return 0;
}
