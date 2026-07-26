// A STALE read must never expand autonomy — and must always say it is stale.
//
// Found on device 2026-07-25, and it is the third layer of "revoking a guardrail doesn't
// work". The first two were the sync merge (#247) and the phone's old merge code. This is
// the third: even with both fixed, the agent kept answering "yes, you're authorized" for a
// REVOKED $500 payment grant, because `loadFingerprint` had silently fallen back to an
// at-rest cache and nothing anywhere said so.
//
// Root cause of the staleness: /v1/authorize — which waits for a HUMAN to notice their
// phone and pass a biometric gate — shared a 5-SECOND timeout with the machine-to-machine
// profile read. Every approval lost that race, every failure was "transient", and every
// transient failure took the silent cache path. The cache had not refreshed in ~22 hours.
//
// Two invariants here:
//   1. The human-approval timeout is far longer than the reachability timeout.
//   2. An authority-EXPANDING answer computed from a cached read is downgraded to escalate,
//      and provenance is reported either way.
//
//   node mcp/test-stale-authority.mjs

import assert from 'assert';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// ── 1. the two timeouts are separate, and the human one is generous ──────────
console.log('\nthe human-approval timeout is not the machine-reachability timeout');
{
  const src = readFileSync(resolve(HERE, 'phone-source.js'), 'utf8');
  const reach = /const TIMEOUT_MS\s*=\s*(\d+)/.exec(src);
  const approve = /const APPROVE_TIMEOUT_MS\s*=\s*(\d+)/.exec(src);
  ok(reach && approve, 'both timeouts are declared');

  const reachMs = Number(reach[1]), approveMs = Number(approve[1]);
  ok(approveMs >= 60000, `human approval gets at least 60s (got ${approveMs}ms)`);
  ok(approveMs > reachMs * 4, `approval window is far longer than reachability (${approveMs} vs ${reachMs})`);

  // …and the authorize call must actually USE the human one. This is the regression that
  // matters: a future edit that "unifies the timeouts" reintroduces the exact bug.
  // Anchor on the actual fetch call, not the header comment that also names the endpoint.
  const authorizeIdx = src.indexOf('endpoint}/v1/authorize');
  ok(authorizeIdx > -1, 'found the /v1/authorize fetch');
  const authorizeBlock = src.slice(authorizeIdx, authorizeIdx + 700);
  ok(/AbortSignal\.timeout\(APPROVE_TIMEOUT_MS\)/.test(authorizeBlock),
    '/v1/authorize aborts on the HUMAN timeout, not the reachability one');

  const profileIdx = src.indexOf('endpoint}/v1/profile');
  ok(profileIdx > -1, 'found the /v1/profile fetch');
  const profileBlock = src.slice(profileIdx, profileIdx + 700);
  ok(/AbortSignal\.timeout\(TIMEOUT_MS\)/.test(profileBlock),
    '/v1/profile still fails fast on the reachability timeout');
}

// ── 2. provenance + the no-expansion rule ────────────────────────────────────
const { SOURCE, sourceOf } = await import('./fingerprint-source.js');

console.log('\nprovenance: a live read and a cached read are distinguishable');
{
  const live = { phaedo_fingerprint: {} };
  ok(sourceOf(live).live === true, 'an unmarked read reports as live');

  const stale = { phaedo_fingerprint: {} };
  Object.defineProperty(stale, SOURCE, {
    value: { live: false, cachedAt: Date.now() - 22 * 3600000, ageMs: 22 * 3600000 },
    enumerable: false, configurable: true, writable: true,
  });
  ok(sourceOf(stale).live === false, 'a stamped read reports as cached');
  ok(!Object.keys(stale).includes('SOURCE'), 'the marker does not appear as an enumerable key');
  ok(JSON.parse(JSON.stringify(stale)).phaedo_fingerprint !== undefined
    && !('SOURCE' in JSON.parse(JSON.stringify(stale))),
    'the marker never survives serialization — it is about the READ, not the artifact');
}

console.log('\na cached read cannot answer "go ahead"');
{
  // Mirror of server.js withStaleAuthorityGuard. Kept in lockstep by the source check below.
  const EXPANDING = new Set(['proceed', 'autoproceed', 'bias_bold']);
  const guard = (response, src) => {
    const out = { ...response };
    const hours = src.ageMs != null ? Math.round(src.ageMs / 3600000) : null;
    out.profile_source = src.live ? { live: true } : { live: false, cached_age_hours: hours };
    if (src.live) return out;
    if (!EXPANDING.has(String(response?.signal))) return out;
    out.signal = 'escalate';
    out.authorization_matched = false;
    out.stale_downgrade = true;
    return out;
  };

  const staleSrc = { live: false, cachedAt: 0, ageMs: 22 * 3600000 };
  const liveSrc  = { live: true, cachedAt: null, ageMs: 0 };

  // THE case from the device: a revoked grant still matching in a stale copy.
  const matched = { signal: 'proceed', authorization_matched: true };
  const guarded = guard(matched, staleSrc);
  ok(guarded.signal === 'escalate', 'a stale "proceed" becomes "escalate"');
  ok(guarded.authorization_matched === false, 'and it no longer claims an authorization matched');
  ok(guarded.stale_downgrade === true, 'the downgrade is flagged, not silent');
  ok(guarded.profile_source.cached_age_hours === 22, 'the age is reported (22h)');

  ok(guard(matched, liveSrc).signal === 'proceed', 'a LIVE read is untouched');
  ok(guard(matched, liveSrc).profile_source.live === true, 'a live read still states its provenance');

  // Restrictive answers survive staleness — they fail in the safe direction.
  for (const signal of ['escalate', 'decline', 'require_human', 'bias_cautious']) {
    ok(guard({ signal }, staleSrc).signal === signal,
      `a stale "${signal}" is preserved (deference is always safe to honour)`);
  }
}

console.log('\nthe guard is actually wired into the authorization pre-flight');
{
  const src = readFileSync(resolve(HERE, 'server.js'), 'utf8');
  ok(/withStaleAuthorityGuard\(checkAuthorization\(/.test(src),
    'phaedo_check_authorization routes its answer through the stale guard');
  ok(/const EXPANDING_SIGNALS = new Set\(\['proceed', 'autoproceed', 'bias_bold'\]\)/.test(src),
    'the expanding-signal set matches the one asserted above');
}

console.log('\npull.js distinguishes a phone read from a cached one');
{
  const src = readFileSync(resolve(HERE, 'pull.js'), 'utf8');
  ok(/sourceOf/.test(src), 'pull.js checks provenance');
  ok(/CACHED copy/.test(src), 'it says plainly when the answer came from cache');
  ok(!/^\s*process\.stdout\.write\(\s*`✓ Read your profile from the phone[\s\S]*?\);\s*$/m.test(src.replace(/if \(src\.live\) \{[\s\S]*?\}/, '')),
    'the unconditional "from the phone" claim is gone');
}

console.log(`\n✓ stale authority: ${pass} checks passed\n`);
