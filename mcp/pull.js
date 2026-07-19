#!/usr/bin/env node
// Debug check: pull the fingerprint via the configured source (phone pairing.json
// → live authorize/pull/decrypt, or the at-rest cache) and print a NON-sensitive
// confirmation — no profile content. Verifies the pairing works end to end.
//
//   npm run pull

import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { loadFingerprint } from './fingerprint-source.js';

const BASE_DIR = dirname(fileURLToPath(import.meta.url));

loadFingerprint(BASE_DIR)
  .then((vd) => {
    const fp = (vd && vd.phaedo_fingerprint) || {};
    const layers = fp.layers ? Object.keys(fp.layers).length : 0;
    process.stdout.write(
      `✓ Read your profile from the phone — fingerprint ${fp.fingerprint_id || '(no id)'}, ${layers} layer(s).\n`
    );
    process.exit(0);
  })
  .catch((err) => {
    process.stderr.write(`✗ Couldn't read your profile: ${err.message}\n`);
    process.exit(1);
  });
