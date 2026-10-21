// Consult runtime — the I/O half of a consultation, shared by every caller that resolves
// one: the MCP server (server.js) and the Claude Code ship hook (hooks/pre-ship.mjs).
//
// One copy, on purpose. This repo has paid twice for two consult paths that drifted — the
// stale-authority guard once lived on phaedo_check_authorization alone, and the tools an
// agent actually used answered from a revoked cache with no downgrade. A hook that loaded
// policies or delegation signals its own way would be the third time.

import { join } from 'path';
import { readFileSync, existsSync } from 'fs';
import { loadFingerprint, loadFingerprintPreferCache } from './fingerprint-source.js';
import { readServingClientId } from './phone-source.js';
import { consultOptsFromEnv, deriveDelegationSignals, withDelegationSignals, authoredDelegationSignals } from './consult.js';
import { defaultStateDir } from './cache.js';
import { readReceipts } from './receipts.js';

/**
 * The consult options for a process rooted at `baseDir` (the mcp/ directory): env config,
 * the subject's deference policies, and this install's own paired-client id.
 */
export function buildConsultOpts(baseDir, env = process.env, { warn = (m) => process.stderr.write(m) } = {}) {
  const opts = consultOptsFromEnv(env);
  // Deference policies: PHAEDO_CONSULT_POLICIES if set, else the default file beside
  // the server (mcp/consult-policies.json — what policy-editor.html produces). Zero
  // config: drop the file in and restart the client. (Portable vault policies in
  // phaedo_consult_policies always apply too, regardless of this file.)
  const policiesPath = env.PHAEDO_CONSULT_POLICIES || join(baseDir, 'consult-policies.json');
  if (existsSync(policiesPath)) {
    try { opts.policies = JSON.parse(readFileSync(policiesPath, 'utf8')); }
    catch (e) { warn(`[phaedo-mcp] ignoring malformed consult policies (${policiesPath}): ${e.message}\n`); }
  }
  // §10.5 `agents`: this process's OWN paired-client identity, resolved once at startup.
  // One server serves one paired client, so it never asks a caller who is calling — it
  // reads who it IS. Null (unpaired / unreadable) makes `agents`-scoped RELAXING rules
  // inert, which is the fail-safe direction; the server still answers everything else.
  opts.clientId = readServingClientId(baseDir);
  return opts;
}

// Load the fingerprint for a consult and fold in the act-as-me channel: delegation
// signals derived from this subject's own override history (§10.6 receipts). The
// origin-aware resolver then lets a `delegation` correction outrank a `self` signal on
// the same dimension. Best-effort — if receipts are unreadable, the consult still
// answers from the plain fingerprint (delegation learning never breaks a consultation).
export async function loadConsultVd(baseDir, { preferCache = false, warn = (m) => process.stderr.write(m) } = {}) {
  // preferCache (escalation, ship hook): read the at-rest cache instead of a live phone
  // pull, so the caller doesn't add a fingerprint-read AUTHORIZE prompt on the phone.
  const vd = preferCache ? await loadFingerprintPreferCache(baseDir) : await loadFingerprint(baseDir);
  try {
    // Two delegation sources, both origin-aware: live override history (every override)
    // + the subject's ENDORSED, portable delegation rules (authored_delegation). The
    // authored rule thus shapes consult too, not only the §9 injection it already renders in.
    const signals = deriveDelegationSignals(await readReceipts(defaultStateDir()))
      .concat(authoredDelegationSignals(vd && vd.phaedo_fingerprint));
    return withDelegationSignals(vd, signals);
  } catch (e) {
    warn(`[phaedo-mcp] delegation derive skipped (consult unaffected): ${e.message}\n`);
    return vd;
  }
}
