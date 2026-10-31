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

console.log('\na cached read cannot answer "go ahead" on one of the subject\'s rules');
{
  // Mirror of server.js withStaleAuthorityGuard. Kept in lockstep by the source check below.
  const EXPANDING = new Set(['proceed', 'autoproceed', 'bias_bold']);
  const guard = (response, src, { ruleDecided = true, leeway = false } = {}) => {
    const out = { ...response };
    const hours = src.ageMs != null ? Math.round(src.ageMs / 3600000) : null;
    out.profile_source = src.live ? { live: true } : { live: false, cached_age_hours: hours };
    if (src.live) return out;
    if (!EXPANDING.has(String(response?.signal))) return out;
    if (!ruleDecided) return out;
    if (leeway) return out;
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

  // RULES ONLY (Randy, 2026-10-31). Phaedo's inferred "proceed" is not a revocable permission;
  // guarding it from a cached copy would turn nearly every consult into an ask.
  const inferred = guard({ signal: 'proceed' }, staleSrc, { ruleDecided: false });
  ok(inferred.signal === 'proceed', 'a stale INFERRED "proceed" stands — no grant, nothing to have revoked');
  ok(inferred.profile_source.live === false && inferred.profile_source.cached_age_hours === 22, '…and still says it came from a 22h-old copy');
  ok(!inferred.stale_downgrade, '…and is not flagged as downgraded');
  ok(guard({ signal: 'proceed' }, staleSrc).signal === 'escalate', 'the default is rule-decided — a caller that forgets to say is guarded (fail closed)');
  ok(guard(matched, staleSrc, { ruleDecided: true, leeway: true }).signal === 'proceed', 'a rule inside the shared leeway still applies from a cached copy');
  ok(guard(matched, staleSrc, { ruleDecided: true, leeway: false }).signal === 'escalate', '…and outside it, it is withheld');
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
  // Each says whether a rule decided — consult and escalate by asking the policy matcher,
  // the pre-flight from its own match.
  for (const tool of ['phaedo_consult', 'phaedo_escalate']) {
    ok(/withStaleAuthorityGuard\(raw, vd, await guardFacts\(vd, (args \|\| \{\}|req)\)\)/.test(handler(tool)),
      `${tool} tells the guard whether one of the subject's rules relaxed it, and the leeway`);
  }
  ok(/withStaleAuthorityGuard\(preGuard, vd, await guardFacts\(vd, req, matchedPreGuard\)\)/.test(handler('phaedo_check_authorization')),
    'the pre-flight is rule-decided exactly when an authorization matched');
  ok(/async function guardFacts\(vd, req, ruleDecided = ruleRelaxes\(vd, req\)\) \{/.test(src)
     && /if \(src\.live \|\| !ruleDecided\) return \{ ruleDecided \};/.test(src)
     && /return \{ ruleDecided, leeway: false \};/.test(src)
     && /leeway: ruleLeeway\(\{ source: src, descriptor: req\?\.action_descriptor, receipts, now: Date\.now\(\) \}\)\.ok/.test(src),
    'the leeway comes from the shared lib/rule-leeway.js, only for a cached copy, and fails closed');
  const hook = readFileSync(resolve(HERE, 'hooks', 'pre-ship.mjs'), 'utf8');
  ok(/return ruleLeeway\(\{ source, descriptor, receipts, now \}\);/.test(hook), 'the ship hook applies the same leeway — a merge and a direct consult agree');
  ok(/function ruleRelaxes\(vd, req\) \{\s*try \{ return standingRuleRelaxes\(vd, req, CONSULT_OPTS\); \} catch \{ return true; \}/.test(src),
    'if the matcher throws, the answer is treated as rule-decided (fail closed)');

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

// ── 5. the consult loader keeps the read's provenance through its overlay ────────────
// Found 2026-10-31: loadConsultVd returned the act-as-me overlay — a spread copy — and the
// provenance marker is non-enumerable, so the copy read as LIVE. The guard above therefore never
// engaged on phaedo_consult / phaedo_escalate whenever the subject had a delegation signal (on
// the reference Mac: always).
console.log('\nthe consult loader keeps "this came from the cache" through its overlay');
{
  const { carrySource } = await import('./fingerprint-source.js');
  const { withDelegationSignals } = await import('./consult.js');
  const vd = { phaedo_fingerprint: { layers: {} } };
  Object.defineProperty(vd, SOURCE, { value: { live: false, cachedAt: 1, ageMs: 11 * 864e5 }, enumerable: false, configurable: true, writable: true });
  const sig = [{ layer: 'decision_and_risk', field: 'x', value: 'y' }];
  ok(sourceOf(withDelegationSignals(vd, sig)).live === true, 'the hazard: a bare overlay copy reads as live');
  const kept = carrySource(vd, withDelegationSignals(vd, sig));
  ok(sourceOf(kept).live === false && sourceOf(kept).ageMs === 11 * 864e5, 'carrySource keeps it cached, with its age');
  ok(carrySource(vd, vd) === vd && sourceOf(carrySource({}, kept)).live === false, 'no-op when there is nothing new or nothing to carry');
  const rt = readFileSync(resolve(HERE, 'consult-runtime.js'), 'utf8');
  ok(/return carrySource\(vd, withDelegationSignals\(vd, signals\)\)/.test(rt), 'loadConsultVd passes its overlay through carrySource');
}

// ── 6. "did one of the subject's rules relax this?" — the guard's question ─────────────
console.log('\nstandingRuleRelaxes: only the subject\'s own relaxing rules count');
{
  const { standingRuleRelaxes } = await import('./consult.js');
  const base = JSON.parse(readFileSync(resolve(HERE, 'sample-fingerprint.json'), 'utf8'));
  const DAY = 864e5;
  const withRules = (rules) => ({ ...base, phaedo_fingerprint: { ...base.phaedo_fingerprint, standing_rules: [], consult_policies: { rules } } });
  const req = { consultation_type: 'action_approval', action_descriptor: { domain: 'finance', reversible: true, magnitude: 'low', amount: 400 } };
  const grant = (over = {}) => ({ id: 'g', match: { domains: ['finance'], reversible: true }, effect: 'autoproceed', ...over });
  ok(standingRuleRelaxes(withRules([grant()]), req) === true, 'THE July case: a matching payment grant relaxes it');
  ok(standingRuleRelaxes(withRules([grant({ effect: 'bias_bold' })]), req) === true, 'a bold bias is a relaxing rule too');
  ok(standingRuleRelaxes(withRules([]), req) === false, 'no rules → inferred judgment, not rule-decided');
  ok(standingRuleRelaxes(withRules([grant({ effect: 'escalate' })]), req) === false, 'a restrictive rule is not a relaxation');
  ok(standingRuleRelaxes(withRules([grant({ expires_at: new Date(Date.now() - DAY).toISOString() })]), req) === false, 'an expired grant does not count');
  ok(standingRuleRelaxes(withRules([grant({ match: { domains: ['engineering'] } })]), req) === false, 'a grant for another domain does not count');
}

// ── 7. the shared leeway: when a cached copy may still apply a rule ───────────────────
console.log('\nruleLeeway: reversible, lower-stakes, no money, recent copy, no recent no');
{
  const { ruleLeeway, RULE_FRESH_DAYS, RULE_PUSHBACK_DAYS } = await import('./lib/rule-leeway.js');
  const DAY = 864e5, NOW = Date.parse('2026-10-31T20:00:00Z');
  const d = { domain: 'engineering', reversible: true, magnitude: 'medium' };
  const cached = (days) => ({ live: false, cachedAt: NOW - days * DAY, ageMs: days * DAY });
  const L = (over = {}) => ruleLeeway({ source: cached(3), descriptor: d, receipts: [], now: NOW, ...over });
  const no = (action, daysAgo, domain = 'engineering') => ({ user_action: action, user_action_at: new Date(NOW - daysAgo * DAY).toISOString(), request: { action_descriptor: { domain } } });
  ok(RULE_FRESH_DAYS === 7 && RULE_PUSHBACK_DAYS === 30, 'bounds: 7-day copy, 30-day "no" window');
  ok(L().ok === true, 'a routine, reversible action from a 3-day-old copy → ok');
  ok(L({ source: { live: true } }).ok === true, 'a live read → ok');
  ok(L({ source: cached(6.9) }).ok === true && L({ source: cached(7.1) }).why === 'stale', 'the copy may be up to 7 days old, not more');
  ok(L({ source: { live: false, ageMs: null } }).why === 'stale', 'a copy of unknown age → no');
  ok(L({ descriptor: { ...d, reversible: false } }).why === 'not_reversible', 'irreversible → strict');
  ok(L({ descriptor: { ...d, reversible: undefined } }).why === 'not_reversible', 'reversibility unstated → strict');
  ok(L({ descriptor: { ...d, magnitude: 'high' } }).why === 'high', 'high stakes → strict');
  ok(L({ descriptor: { ...d, magnitude: undefined } }).why === 'magnitude_unstated', 'stakes unstated → strict');
  ok(L({ descriptor: { ...d, magnitude: 'Low' } }).ok === true, 'magnitude case does not matter');
  ok(L({ descriptor: { domain: 'finance', reversible: true, magnitude: 'low', amount: 500 } }).why === 'priced', 'THE July case: any payment stays live-only');
  ok(L({ descriptor: { ...d, amount: 0 } }).why === 'priced', 'even a zero amount is a priced action');
  ok(L({ descriptor: { ...d, amount: null } }).ok === true, 'a stored null amount is unpriced');
  ok(L({ receipts: [no('rejected', 2)] }).why === 'pushback', 'one recent no in the domain → strict at once');
  ok(L({ receipts: [no('modified', 2)] }).why === 'pushback', 'a recent "do it differently" → strict');
  ok(L({ receipts: [no('rejected', 31)] }).ok === true, 'a no older than 30 days no longer counts');
  ok(L({ receipts: [no('rejected', 2, 'finance')] }).ok === true, 'a no in another domain does not count');
  ok(L({ descriptor: { ...d, domain: 'Engineering' } , receipts: [no('rejected', 2)] }).why === 'pushback', 'domains compare canonically (casing)');
  ok(L({ receipts: [no('approved', 1)] }).ok === true, 'approvals never count against it');
  ok(ruleLeeway().ok === false && ruleLeeway({}).why === 'not_reversible', 'nothing to go on → strict');
}

console.log(`\n✓ stale authority: ${pass} checks passed\n`);
