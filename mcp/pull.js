#!/usr/bin/env node
// Debug check: pull the fingerprint via the configured source (phone pairing.json
// → live authorize/pull/decrypt, or the at-rest cache) and print a NON-sensitive
// confirmation — no profile content. Verifies the pairing works end to end.
//
//   npm run pull

import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { loadFingerprint, sourceOf } from './fingerprint-source.js';

const BASE_DIR = dirname(fileURLToPath(import.meta.url));

loadFingerprint(BASE_DIR)
  .then((vd) => {
    const fp = (vd && vd.phaedo_fingerprint) || {};
    const layers = fp.layers ? Object.keys(fp.layers).length : 0;
    const src = sourceOf(vd);
    // This line used to say "from the phone" unconditionally — including when the pull had
    // failed and the at-rest cache was served instead. That is precisely how a 22-hour-old
    // profile went unnoticed while the agent answered authorization questions from it. The
    // whole point of this command is to verify the pairing works, so it has to distinguish
    // "your phone answered" from "your phone didn't, here's an old copy".
    if (src.starter) {
      process.stdout.write(
        `✓ No phone paired — serving a starter profile built from your own sessions on this computer, ${layers} layer(s).\n` +
        `  Pair the Phaedo phone app (npm run pair) to replace it with your full profile.\n`
      );
      process.exit(0);
    }
    if (src.live) {
      process.stdout.write(
        `✓ Read your profile from the phone — fingerprint ${fp.fingerprint_id || '(no id)'}, ${layers} layer(s).\n`
      );
      process.exit(0);
    }
    const hours = src.ageMs != null ? Math.round(src.ageMs / 3600000) : null;
    process.stdout.write(
      `⚠ Could NOT reach your phone — served a CACHED copy${hours != null ? ` about ${hours}h old` : ''} ` +
      `(fingerprint ${fp.fingerprint_id || '(no id)'}, ${layers} layer(s)).\n` +
      `  Anything you changed since then — including a revoked authorization — is NOT reflected.\n` +
      `  Open Phaedo on your phone and approve the card, then run this again.\n`
    );
    process.exit(2);                       // distinct from 1 (hard failure) — stale, not broken
  })
  .catch((err) => {
    process.stderr.write(`✗ Couldn't read your profile: ${err.message}\n`);
    process.exit(1);
  });
