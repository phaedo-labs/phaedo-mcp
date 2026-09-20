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
  // Slice to the end of the fetch OPTIONS object rather than a fixed byte count. A fixed
  // window silently stops covering the call the moment a comment is added inside it — which
  // is exactly what happened when the agent's capability advertisement landed in this body.
  const authorizeEnd = src.indexOf('});', authorizeIdx);
  ok(authorizeEnd > authorizeIdx, 'found the end of the authorize fetch options');
  const authorizeBlock = src.slice(authorizeIdx, authorizeEnd);
  ok(/AbortSignal\.timeout\(APPROVE_TIMEOUT_MS\)/.test(authorizeBlock),
    '/v1/authorize aborts on the HUMAN timeout, not the reachability one');

  const profileIdx = src.indexOf('endpoint}/v1/profile');
  ok(profileIdx > -1, 'found the /v1/profile fetch');
  const profileEnd = src.indexOf('});', profileIdx);
  ok(profileEnd > profileIdx, 'found the end of the profile fetch options');
  const profileBlock = src.slice(profileIdx, profileEnd);
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

console.log('\nthe guard is wired into ALL THREE decision tools, not just the pre-flight');
{
  const src = readFileSync(resolve(HERE, 'server.js'), 'utf8');
  // It covered phaedo_check_authorization ALONE. The two tools an autonomous agent actually
  // uses — consult and escalate — answered from a possibly-revoked cached profile with no
  // downgrade and no provenance. escalate was worst: it reads the cache UNCONDITIONALLY and
  // then tells the agent the signal is not blocking, i.e. proceed and never wake the subject.
  //
  // Asserted per HANDLER rather than by counting call sites, so a guard that moved to the wrong
  // tool cannot satisfy it.
  // Sliced by registerTool BOUNDARY, not a fixed character window — a window big enough for one
  // handler is too small for the next, and one that guesses wrong reports a false failure (or,
  // worse, a false pass by swallowing a neighbouring handler's guard).
  const bounds = [...src.matchAll(/server\.registerTool\(\s*'([a-z_]+)'/g)]
    .map((m) => ({ name: m[1], at: m.index }));
  const handler = (name) => {
    const i = bounds.findIndex((b) => b.name === name);
    if (i === -1) return '';
    return src.slice(bounds[i].at, i + 1 < bounds.length ? bounds[i + 1].at : src.length);
  };
  ok(bounds.length >= 8, `found ${bounds.length} registered tools to slice by`);
  for (const tool of ['phaedo_check_authorization', 'phaedo_consult', 'phaedo_escalate']) {
    ok(/withStaleAuthorityGuard\(/.test(handler(tool)),
      `${tool} routes its answer through the stale guard`);
  }

  // And the pre-flight's RECEIPT is gated on the pre-guard result. The guard clears
  // `authorization_matched`, so gating on the post-guard value meant the one case that most
  // needs an audit trail — an authorization fired against a possibly-revoked cached grant and
  // was withheld — left no record at all (§10.6).
  ok(/const matchedPreGuard = preGuard\.authorization_matched === true;/.test(src)
     && /if \(matchedPreGuard\) \{/.test(src),
    'the §10.6 receipt is gated on the PRE-guard match, so a withheld authorization is still audited');
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
