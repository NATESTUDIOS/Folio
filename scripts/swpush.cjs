#!/usr/bin/env node
// ============================================================
// scripts/swpush.cjs
// ------------------------------------------------------------
// Rewrites the CACHE_VERSION and CACHE_BUILT_AT constants in
// public/sw.js on every build.
//
// Idempotent: it matches EITHER the placeholder OR an already-
// injected numeric version, AND it accepts either single-quote
// (') or double-quote (") string delimiters — so it works no
// matter how public/sw.js was formatted.
//
// The output preserves the quote style found in the source. If
// public/sw.js uses double quotes, the injected values use double
// quotes. If it uses single quotes, they use single quotes.
//
// Version format:  <unix-ms>       e.g. 1762613422345
// Reset format:    1               (see RESET below)
//
// This is the ONLY script. There is no separate source file.
// public/sw.js is both the source and the output. The two
// constants on lines 1–12 are the only thing this script touches.
//
// ------------------------------------------------------------
// RESET TO VERSION 1
// ------------------------------------------------------------
// Trigger any of:
//
//   1. Env var:      SW_RESET=1 node scripts/swpush.cjs
//   2. CLI flag:     node scripts/swpush.cjs --reset
//   3. Marker file:  create `.swreset` at the repo root, commit,
//                    let Vercel build, then delete it and commit.
//
// One-shot: the next build after reset resumes timestamping.
// ============================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const SW = path.join(ROOT, 'public', 'sw.js');
const RESET_MARKER = path.join(ROOT, '.swreset');

// ------------------------------------------------------------
// Reset detection
// ------------------------------------------------------------

function shouldReset(argv) {
  if (argv.includes('--reset')) return { yes: true, source: 'cli' };

  const env = String(process.env.SW_RESET || '').toLowerCase();
  if (env === '1' || env === 'true' || env === 'yes') {
    return { yes: true, source: 'env' };
  }

  if (fs.existsSync(RESET_MARKER)) return { yes: true, source: 'marker' };

  return { yes: false, source: null };
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------

function main() {
  const reset = shouldReset(process.argv.slice(2));

  let source;
  try {
    source = fs.readFileSync(SW, 'utf8');
  } catch (err) {
    console.error('[swpush] Cannot read public/sw.js:', err.message);
    process.exit(1);
  }

  // Match EITHER the placeholder OR an already-injected numeric
  // value, wrapped in EITHER ' or ". The (['"]) capture group
  // and \1 back-reference enforce that the opening and closing
  // quotes match each other — so `"foo'` (mismatched) will NOT
  // match, which is the correct behavior.
  const VERSION_RE =
    /const CACHE_VERSION = (['"])(?:__FOLIO_SW_VERSION__|\d+)\1;/;
  const BUILT_AT_RE =
    /const CACHE_BUILT_AT = Number\((['"])(?:__FOLIO_SW_BUILT_AT__|\d+)\1\);/;

  if (!VERSION_RE.test(source)) {
    console.error(
      '[swpush] Cannot find CACHE_VERSION line in public/sw.js.\n' +
      '  Expected one of:\n' +
      '    const CACHE_VERSION = "__FOLIO_SW_VERSION__";\n' +
      "    const CACHE_VERSION = '__FOLIO_SW_VERSION__';\n" +
      '    const CACHE_VERSION = "<digits>";\n' +
      "    const CACHE_VERSION = '<digits>';"
    );
    process.exit(1);
  }

  if (!BUILT_AT_RE.test(source)) {
    console.error(
      '[swpush] Cannot find CACHE_BUILT_AT line in public/sw.js.\n' +
      '  Expected one of:\n' +
      '    const CACHE_BUILT_AT = Number("__FOLIO_SW_BUILT_AT__");\n' +
      "    const CACHE_BUILT_AT = Number('__FOLIO_SW_BUILT_AT__');\n" +
      '    const CACHE_BUILT_AT = Number("<digits>");\n' +
      "    const CACHE_BUILT_AT = Number('<digits>');"
    );
    process.exit(1);
  }

  const version = reset.yes ? 1 : Date.now();
  const builtAt = reset.yes ? 1 : version;

  // Replacement callbacks receive (fullMatch, capturedQuote).
  // We echo the captured quote back so the output preserves the
  // source's quote style.
  const output = source
    .replace(
      VERSION_RE,
      (_, q) => `const CACHE_VERSION = ${q}${version}${q};`
    )
    .replace(
      BUILT_AT_RE,
      (_, q) => `const CACHE_BUILT_AT = Number(${q}${builtAt}${q});`
    );

  if (output === source) {
    // Nothing changed. This can only happen if two builds run in
    // the same millisecond against the same file. Surface it
    // rather than fail silently.
    console.warn(
      `[swpush] No change written — version already ${version}. ` +
      'Two builds in the same millisecond?'
    );
  }

  fs.writeFileSync(SW, output, 'utf8');

  const bytes = Buffer.byteLength(output, 'utf8');
  const hash = crypto
    .createHash('sha256')
    .update(output)
    .digest('hex')
    .slice(0, 12);

  if (reset.yes) {
    console.log(`[swpush] RESET via ${reset.source} — forcing version 1`);
  }

  console.log(
    `[swpush] wrote public/sw.js  ` +
    `version=${version}  ` +
    `builtAt=${builtAt}  ` +
    `bytes=${bytes}  ` +
    `hash=${hash}` +
    (reset.yes ? '  (RESET)' : '')
  );

  if (process.env.VERCEL) {
    const label = reset.yes ? 'RESET' : 'ms';
    console.log(`[swpush] Vercel deploy — SW ${label} version: ${version}`);
  }

  // Marker is one-shot — remove it from the build workspace so the
  // next build runs normally. Commit the deletion on GitHub too,
  // otherwise the marker file stays in the repo and every build
  // would reset again (still works, just not what you want).
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