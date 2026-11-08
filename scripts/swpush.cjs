#!/usr/bin/env node
// ============================================================
// scripts/swpush.cjs
// ------------------------------------------------------------
// Injects a build-time cache version into sw.js and writes the
// result to public/sw.js.
//
// Version format:  <unix-ms>
// Example:         1762613422345
//
// Why millisecond timestamp?
//   - Monotonically increasing: newer build = larger number.
//   - Unique per build: two builds in the same second still
//     produce different values because ms resolution is
//     granularity, not seconds.
//   - No git SHA, no random suffix, no date formatting — just
//     Date.now(). Impossible to collide unless two builds
//     happen in the exact same millisecond, which is not
//     physically possible on a single Vercel builder.
//
// RESET TO VERSION 1
// ------------------------------------------------------------
// The build can be forced to emit version "1" instead of the
// millisecond stamp. Useful after manual cache surgery, a
// rollback, or any time you want to nuke the cache with a
// known marker.
//
// Trigger any of these:
//
//   1. Env var:        SW_RESET=1 node scripts/swpush.cjs
//   2. CLI flag:       node scripts/swpush.cjs --reset
//   3. Marker file:    create `.swreset` in the repo root,
//                      commit it, and Vercel's build will reset.
//                      Then delete `.swreset` and commit again.
//
// The reset is ONE-SHOT: it affects only the current run. The
// next build resumes timestamping from Date.now().
//
// The script also refuses to run twice on the same source file.
// That prevents a stale public/sw.js from a previous build
// being silently reused if the placeholders are already gone.
//
// Usage:
//   node scripts/swpush.cjs
//   node scripts/swpush.cjs --reset
//
// Wired into:
//   "build": "node scripts/swpush.cjs"
// ============================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'sw.js');
const OUT = path.join(ROOT, 'public', 'sw.js');
const RESET_MARKER = path.join(ROOT, '.swreset');

// ------------------------------------------------------------
// Reset detection
// ------------------------------------------------------------

function shouldReset(argv) {
  // 1. CLI flag
  if (argv.includes('--reset')) {
    return { yes: true, source: 'cli' };
  }

  // 2. Env var (SW_RESET=1, SW_RESET=true, SW_RESET=yes)
  const env = String(process.env.SW_RESET || '').toLowerCase();
  if (env === '1' || env === 'true' || env === 'yes') {
    return { yes: true, source: 'env' };
  }

  // 3. Marker file
  if (fs.existsSync(RESET_MARKER)) {
    return { yes: true, source: 'marker' };
  }

  return { yes: false, source: null };
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function buildVersion({ reset }) {
  if (reset) {
    // Forced reset. CACHE_NAME becomes `folio-shell-1`.
    // Previous caches (folio-shell-<ms>) are deleted on activate,
    // so a reset effectively replaces every cached shell.
    return 1;
  }

  // Normal path. Millisecond Unix timestamp.
  return Date.now();
}

function buildBuiltAt(version, { reset }) {
  if (reset) return 1;
  // Same value as the version — kept separate so CACHE_BUILT_AT
  // remains a valid Unix-ms value even if the version format
  // ever changes to something non-numeric.
  return version;
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------

function main() {
  const reset = shouldReset(process.argv.slice(2));

  let source;
  try {
    source = fs.readFileSync(SRC, 'utf8');
  } catch (err) {
    console.error('[swpush] Cannot read sw.js:', err.message);
    process.exit(1);
  }

  // Guard: refuse to overwrite if placeholders are already gone.
  // A previous build that mutated the source would leave nothing
  // to replace, and we'd silently produce a SW with a stale
  // version — the exact failure mode this script exists to
  // prevent.
  if (!source.includes('__FOLIO_SW_VERSION__')) {
    console.error(
      '[swpush] sw.js has no __FOLIO_SW_VERSION__ placeholder. ' +
      'Refusing to write public/sw.js. ' +
      'The source may have been modified by a previous build.'
    );
    process.exit(1);
  }
  if (!source.includes('__FOLIO_SW_BUILT_AT__')) {
    console.error(
      '[swpush] sw.js has no __FOLIO_SW_BUILT_AT__ placeholder. ' +
      'Refusing to write public/sw.js.'
    );
    process.exit(1);
  }

  const version = buildVersion(reset);
  const builtAt = buildBuiltAt(version, reset);

  const output = source
    .replace(/__FOLIO_SW_VERSION__/g, String(version))
    .replace(/__FOLIO_SW_BUILT_AT__/g, String(builtAt));

  // Sanity: placeholders must be fully gone from the output.
  if (/__FOLIO_SW_(VERSION|BUILT_AT)__/.test(output)) {
    console.error(
      '[swpush] Placeholder substitution left a token in output. ' +
      'Check sw.js for duplicate or malformed placeholders.'
    );
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, output, 'utf8');

  const bytes = Buffer.byteLength(output, 'utf8');
  const hash = crypto
    .createHash('sha256')
    .update(output)
    .digest('hex')
    .slice(0, 12);
  const target = path.relative(ROOT, OUT);

  if (reset.yes) {
    console.log(
      `[swpush] RESET via ${reset.source} — forcing version 1`
    );
  }

  console.log(
    `[swpush] wrote ${target}  ` +
    `version=${version}  ` +
    `builtAt=${builtAt}  ` +
    `bytes=${bytes}  ` +
    `hash=${hash}` +
    (reset.yes ? '  (RESET)' : '')
  );

  // On Vercel, log the version prominently so it shows up in the
  // deploy log — makes it easy to correlate a cached shell with
  // a specific build.
  if (process.env.VERCEL) {
    const label = reset.yes ? 'RESET' : 'ms';
    console.log(`[swpush] Vercel deploy — SW ${label} version: ${version}`);
  }

  // If we came in via marker, remove it so the NEXT build runs
  // normally. CLI/env resets are one-shot by construction.
  if (reset.source === 'marker') {
    try {
      fs.unlinkSync(RESET_MARKER);
      console.log('[swpush] Removed .swreset marker from build workspace');
    } catch (err) {
      console.warn('[swpush] Could not remove .swreset:', err.message);
    }
  }
}

main();
