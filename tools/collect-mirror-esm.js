// mirror-esm.mjs

/**
 * @description A reliable Node.js script to create a local mirror of CodeMirror and Lezer ESM modules from esm.sh.
 * It recursively downloads all dependencies and rewrites their import paths to work completely offline.
 *
 * @requires node-fetch@2 (`npm install node-fetch@2`)
 */
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import { URL } from "url";

// --- CONFIGURATION ---

const ESM_BASE_URL = "https://esm.sh";
const OUTPUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "/prettier");
const ROOT_MODULES = [
   // --- CodeMirror Modules ---
   "@codemirror/state",
   "@codemirror/view",
   "@codemirror/commands",
   "@codemirror/autocomplete",
   "@codemirror/lang-javascript",
   "@codemirror/lang-css",
   "@codemirror/theme-one-dark",
   "style-mod",
   "@lezer/common",
   "@lezer/highlight",

   // --- Prettier Modules ---
   "prettier/standalone",      // The core Prettier library for browsers
   "prettier/plugins/babel",   // The JavaScript parser
   "prettier/plugins/estree",  // Required by the babel parser
   "prettier/plugins/postcss",     // The CSS parser
 ];

// --- SCRIPT ---

// Caches active download promises to prevent race conditions and redundant fetches.
// Key: absolute local file path. Value: Promise<string> that resolves to the same path.
const activeDownloads = new Map();

/**
 * Normalizes an esm.sh URL into a clean, version-free local file path
 * while preserving the internal file structure of the package.
 * E.g.: `/@codemirror/state@6.5.2/es2022/state.mjs` -> `@codemirror/state/state.mjs`
 * E.g.: `/@codemirror/state` -> `@codemirror/state.js`
 */
function normalizeUrlToFilePath(urlString) {
    const url = new URL(urlString, ESM_BASE_URL);
    let pathname = decodeURIComponent(url.pathname);

    // 1. Remove esm.sh CDN version prefix, e.g., /v135/
    pathname = pathname.replace(/^\/v\d+\//, "/");

    // 2. Extract the clean package name and separate it from any internal file path.
    // This regex finds the full package identifier, including scope and version.
    const pkgMatch = pathname.match(/^(\/((?:@[^/]+\/)?[^@/]+)(?:@[\d^~.a-zA-Z-]+)?)/);

    let cleanPackageName;
    let internalFilePath = '';

    if (pkgMatch) {
        cleanPackageName = pkgMatch[2]; // The clean name, e.g., @codemirror/state
        const fullPackagePathWithVersion = pkgMatch[1];
        internalFilePath = pathname.substring(fullPackagePathWithVersion.length);
    } else {
        // Fallback for URLs that don't match the standard package structure
        cleanPackageName = pathname.split('/')[1] || pathname;
        if (cleanPackageName.includes('@')) {
            cleanPackageName = cleanPackageName.split('@')[0];
        }
    }

    // 3. Remove esbuild target directory from the internal path, e.g., /es2022/
    internalFilePath = internalFilePath.replace(/^\/es\d{4}\//, '/');

    // 4. Reassemble the final path
    let finalPath = path.join(cleanPackageName, internalFilePath).replace(/\\/g, '/');
    if (finalPath.startsWith('/')) {
        finalPath = finalPath.substring(1);
    }

    // 5. Ensure a file extension exists
    if (!/\.(m?js)$/.test(finalPath) && !finalPath.endsWith('/')) {
        finalPath += ".js";
    }

    return finalPath;
}

/**
 * Calculates the relative import path from one local file to another.
 */
function calculateRelativePath(fromFile, toFile) {
  const fromDir = path.dirname(fromFile);
  const relative = path.relative(fromDir, toFile).replace(/\\/g, "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/**
 * The main orchestrator for downloading and processing a single module.
 * It ensures that each canonical local file is processed exactly once.
 */
function getOrStartDownload(localPath, initialUrl) {
  // If a download for this exact local path is already in progress, return its promise.
  // This is the core of the race condition prevention.
  if (activeDownloads.has(localPath)) {
    return activeDownloads.get(localPath);
  }

  // Immediately create and cache a promise to mark this path as "being processed".
  const controllerPromise = (async () => {
    console.log(`[FETCH]   ${initialUrl}`);
    const response = await fetch(initialUrl);
    if (!response.ok) throw new Error(`Failed to fetch ${initialUrl}: ${response.status}`);

    const finalUrl = response.url; // URL after any server-side redirects
    const code = await response.text();

    const relativeLocalPath = path.relative(process.cwd(), localPath);
    console.log(`[PROCESS] ${finalUrl} -> ${relativeLocalPath}`);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });

    const importRegex = /(import|export)(?:[^\r\n'"]*?from)?\s*['"]([^'"\s]+)['"]/g;

    // To prevent deadlocks, we first launch all dependency downloads
    // and then save the current file before awaiting them.
    const deps = [];
    for (const match of code.matchAll(importRegex)) {
      const specifier = match[2];
      if (specifier.startsWith("/") || specifier.startsWith("https://")) {
        const depUrl = new URL(specifier, finalUrl).href;
        const depLocalPath = path.join(OUTPUT_DIR, normalizeUrlToFilePath(depUrl));
        const promise = getOrStartDownload(depLocalPath, depUrl);
        deps.push({ specifier, promise, localPath: depLocalPath });
      }
    }

    // Rewrite import paths to be relative *before* saving.
    const modifiedCode = code.replace(importRegex, (originalMatch, keyword, specifier) => {
      const dep = deps.find(d => d.specifier === specifier);
      if (dep) {
        const relativePath = calculateRelativePath(localPath, dep.localPath);
        return originalMatch.replace(specifier, relativePath);
      }
      return originalMatch;
    });

    console.log(`[SAVE]    ${relativeLocalPath}`);
    fs.writeFileSync(localPath, modifiedCode);

    // Now, await the completion of all dependency downloads.
    await Promise.all(deps.map(d => d.promise));

    return localPath;
  })();

  activeDownloads.set(localPath, controllerPromise);
  return controllerPromise;
}

async function main() {
  console.log(`Starting ESM mirror process...`);
  console.log(`Output directory: ${OUTPUT_DIR}\n`);

  if (fs.existsSync(OUTPUT_DIR)) {
    console.log("Output directory exists. Cleaning up...");
    fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  try {
    const initialPromises = ROOT_MODULES.map(name => {
      const initialUrl = `${ESM_BASE_URL}/${name}`;
      const localPath = path.join(OUTPUT_DIR, normalizeUrlToFilePath(initialUrl));
      return getOrStartDownload(localPath, initialUrl);
    });

    await Promise.all(initialPromises);

    console.log("\n✅ Mirroring complete!");
    console.log(`All files saved to: ${OUTPUT_DIR}`);
  } catch (err) {
    console.error("\n❌ An error occurred during the mirroring process:");
    console.error(err);
    process.exit(1);
  }
}

main();
