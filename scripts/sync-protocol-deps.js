#!/usr/bin/env node
/**
 * sync-protocol-deps.js
 *
 * Fetches the upstream Railway Wallet desktop/package.json and the upstream
 * mobile/nodejs-src/nodejs-project/package.json, then syncs any changed
 * @railgun-community/* and @railgun-privacy/* versions into this fork's
 * mobile package files.
 *
 * Rules:
 *   - Same major version → auto-update (safe bug/security fix)
 *   - Major version change → skip + write a warning to the job summary
 *     so the user knows manual review is needed
 *   - Patched packages (see PINNED_PACKAGES) → never touched
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Packages we deliberately never touch (patch-package targets) ─────────────
const PINNED_PACKAGES = new Set([
  'nodejs-mobile-react-native',
  'react-native-encrypted-storage',
  'react-native-fs',
  'react-native-svg',
  '@react-navigation/bottom-tabs',
]);

// ── Packages to sync: upstream desktop deps → mobile/package.json ────────────
const MOBILE_DEPS_TO_SYNC = [
  '@railgun-community/wallet',
  '@railgun-community/shared-models',
  '@railgun-community/cookbook',
  'ethers',
];

// ── Packages to sync: upstream nodejs-src deps → mobile/nodejs-src ───────────
const NODEJS_DEPS_TO_SYNC = [
  '@railgun-community/wallet',
  '@railgun-community/shared-models',
  '@railgun-community/curve25519-scalarmult-rsjs',
  '@railgun-community/poseidon-hash-rsjs',
];

// Waku broadcaster: desktop uses -web, mobile nodejs-src uses -node.
// They should stay on the same version number.
const WAKU_DESKTOP_PKG  = '@railgun-community/waku-broadcaster-client-web';
const WAKU_NODEJS_PKG   = '@railgun-community/waku-broadcaster-client-node';

// Engine resolution pin — desktop pins this in resolutions{}, we mirror it.
const ENGINE_PKG = '@railgun-community/engine';

// ── Helpers ───────────────────────────────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'railway-sync-script/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

/** Strip leading ^ ~ >= from a semver string */
function clean(v) {
  return v ? v.replace(/^[\^~>=]+/, '').trim() : v;
}

function major(v) {
  return parseInt(clean(v).split('.')[0], 10);
}

function appendSummary(text) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) fs.appendFileSync(f, text + '\n');
}

function setOutput(key, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) fs.appendFileSync(f, `${key}=${value}\n`);
}

// ── Core sync logic ───────────────────────────────────────────────────────────
/**
 * Compare one package version between upstream and local.
 * Mutates localPkg.dependencies[pkg] if a safe update is available.
 * Returns a description string if updated, null otherwise.
 */
function syncPackage(pkg, upstreamVersion, localPkg, label) {
  if (PINNED_PACKAGES.has(pkg)) return null;

  const section = localPkg.dependencies?.[pkg] ? 'dependencies'
    : localPkg.devDependencies?.[pkg] ? 'devDependencies'
    : null;

  if (!section || !upstreamVersion) return null;

  const localVersion  = localPkg[section][pkg];
  const upstreamClean = clean(upstreamVersion);
  const localClean    = clean(localVersion);

  if (upstreamClean === localClean) return null; // already up to date

  if (major(upstreamVersion) !== major(localVersion)) {
    const msg = `⚠️  **Major version change skipped** — \`${pkg}\` (${label}): \`${localClean}\` → \`${upstreamClean}\` — manual review needed`;
    console.warn('  [SKIP major]', pkg, localClean, '→', upstreamClean);
    appendSummary(msg);
    return null;
  }

  console.log(`  [${label}] ${pkg}: ${localClean} → ${upstreamClean}`);
  localPkg[section][pkg] = upstreamClean;
  return `\`${pkg}\` ${localClean} → ${upstreamClean} (${label})`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const ROOT = path.resolve(__dirname, '..');

  const UPSTREAM_DESKTOP_URL = 'https://raw.githubusercontent.com/Railway-Wallet/Railway-Wallet/main/desktop/package.json';
  const UPSTREAM_NODEJS_URL  = 'https://raw.githubusercontent.com/Railway-Wallet/Railway-Wallet/main/mobile/nodejs-src/nodejs-project/package.json';

  console.log('Fetching upstream desktop/package.json …');
  const desktopPkg = await fetchJson(UPSTREAM_DESKTOP_URL);

  console.log('Fetching upstream mobile/nodejs-src/nodejs-project/package.json …');
  const upstreamNodejsPkg = await fetchJson(UPSTREAM_NODEJS_URL);

  const mobilePkgPath  = path.join(ROOT, 'mobile/package.json');
  const nodejsPkgPath  = path.join(ROOT, 'mobile/nodejs-src/nodejs-project/package.json');

  const mobilePkg  = JSON.parse(fs.readFileSync(mobilePkgPath,  'utf8'));
  const nodejsPkg  = JSON.parse(fs.readFileSync(nodejsPkgPath,  'utf8'));

  const updates = [];

  // 1. Sync desktop deps → mobile/package.json
  for (const pkg of MOBILE_DEPS_TO_SYNC) {
    const upstreamVer = desktopPkg.dependencies?.[pkg] ?? desktopPkg.devDependencies?.[pkg];
    const result = syncPackage(pkg, upstreamVer, mobilePkg, 'mobile');
    if (result) updates.push(result);
  }

  // 2. Sync engine resolution pin (desktop resolutions → mobile resolutions)
  const desktopEnginePin = desktopPkg.resolutions?.[ENGINE_PKG];
  const mobileEnginePin  = mobilePkg.resolutions?.[ENGINE_PKG];
  if (desktopEnginePin && desktopEnginePin !== mobileEnginePin) {
    const localMajor  = mobileEnginePin ? major(mobileEnginePin) : major(desktopEnginePin);
    if (major(desktopEnginePin) === localMajor) {
      console.log(`  [mobile resolutions] ${ENGINE_PKG}: ${mobileEnginePin ?? 'unset'} → ${desktopEnginePin}`);
      mobilePkg.resolutions         = mobilePkg.resolutions ?? {};
      mobilePkg.resolutions[ENGINE_PKG] = desktopEnginePin;
      updates.push(`\`${ENGINE_PKG}\` → ${desktopEnginePin} (resolution pin)`);
    } else {
      const msg = `⚠️  **Major version change skipped** — \`${ENGINE_PKG}\` resolution: \`${mobileEnginePin}\` → \`${desktopEnginePin}\``;
      console.warn('  [SKIP major resolution]', ENGINE_PKG);
      appendSummary(msg);
    }
  }

  // 3. Sync upstream nodejs-src deps → local nodejs-src/package.json
  for (const pkg of NODEJS_DEPS_TO_SYNC) {
    const upstreamVer = upstreamNodejsPkg.dependencies?.[pkg];
    const result = syncPackage(pkg, upstreamVer, nodejsPkg, 'nodejs-src');
    if (result) updates.push(result);
  }

  // 4. Sync Waku broadcaster version (desktop -web → mobile nodejs-src -node)
  const desktopWakuVer = desktopPkg.dependencies?.[WAKU_DESKTOP_PKG];
  const mobileWakuVer  = nodejsPkg.dependencies?.[WAKU_NODEJS_PKG];
  if (desktopWakuVer && mobileWakuVer && clean(desktopWakuVer) !== clean(mobileWakuVer)) {
    if (major(desktopWakuVer) === major(mobileWakuVer)) {
      console.log(`  [nodejs-src] ${WAKU_NODEJS_PKG}: ${clean(mobileWakuVer)} → ${clean(desktopWakuVer)}`);
      nodejsPkg.dependencies[WAKU_NODEJS_PKG] = clean(desktopWakuVer);
      updates.push(`\`${WAKU_NODEJS_PKG}\` ${clean(mobileWakuVer)} → ${clean(desktopWakuVer)} (nodejs-src)`);
    } else {
      const msg = `⚠️  **Major version change skipped** — \`${WAKU_NODEJS_PKG}\`: ${clean(mobileWakuVer)} → ${clean(desktopWakuVer)}`;
      console.warn('  [SKIP major]', WAKU_NODEJS_PKG);
      appendSummary(msg);
    }
  }

  // ── Write changes ────────────────────────────────────────────────────────
  const changed = updates.length > 0;

  if (changed) {
    fs.writeFileSync(mobilePkgPath,  JSON.stringify(mobilePkg,  null, 2) + '\n');
    fs.writeFileSync(nodejsPkgPath,  JSON.stringify(nodejsPkg,  null, 2) + '\n');

    console.log('\nUpdated packages:');
    updates.forEach(u => console.log(' ', u));

    appendSummary('## Protocol deps synced ✅\n' + updates.map(u => `- ${u}`).join('\n'));
  } else {
    console.log('\nAll protocol deps already up to date — no changes needed.');
    appendSummary('## Protocol deps already up to date ✅');
  }

  setOutput('changed', String(changed));
  setOutput('summary', updates.join(', ') || 'no changes');
}

main().catch(e => {
  console.error('sync-protocol-deps failed:', e.message);
  process.exit(1);
});
