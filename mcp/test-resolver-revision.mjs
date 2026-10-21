#!/usr/bin/env node
// Resolver revision (precedent track Phase 1b): every inferred receipt says which version of
// the inferred path answered, and agreement can be split by it.
//
// THE TRIPWIRE (first section) is the reason this file exists: it fingerprints the inferred
// path's answers over a fixed grid. If the answers move while RESOLVER_REVISION stays the
// same, receipts from two different engines would carry one label — exactly the blur this
// feature removes — so the test fails and says what to do. Behaviour-based on purpose:
// refactors and comment edits do not trip it; changed answers do.
// Run: node test-resolver-revision.mjs   (from mcp/)

import assert from 'assert';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveConsultationCore, RESOLVER_REVISION } from './consult-core.js';
import { resolveConsultation, consultDrivers, withRevision } from './consult.js';
import { revisionOf, computeAgreementByRevision, NOT_RECORDED } from './agreement.js';
import { buildReceipt } from './receipts.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const HERE = dirname(fileURLToPath(import.meta.url));

// ── 1. Tripwire: the answers under each revision, pinned ───────────────────────
// To bump: change RESOLVER_REVISION in consult-core.js to `<date>.<what changed>`, run this
// file, and add the printed hash under the new name. Never edit an existing entry.
export const PINNED = {
  '2026-10-19.amount-bands': '92904db589ec6ffa',
};

const FPS = [
  JSON.parse(readFileSync(join(HERE, 'sample-fingerprint.json'), 'utf8')),
  { phaedo_fingerprint: { persona_strength: 0.6, layers: {
    decision_and_risk: { responses: [{ answer: 'Quality over speed' }, { answer: 'much more cautious and seek more input' }] },
    behavioral: { responses: [{ answer: 'covered the main risks' }, { answer: 'ask a clarifying question' }] } } } },
  { phaedo_fingerprint: { persona_strength: 0.6, layers: {
    decision_and_risk: { responses: [{ answer: 'Speed over quality' }, { answer: 'act fast and adjust' }] },
    behavioral: { responses: [{ answer: 'go with my gut' }, { answer: 'make a reasonable assumption' }] } } } },
  { phaedo_fingerprint: { persona_strength: 0.3, layers: {} } },   // abstain
];
export function inferredFingerprint() {
  const h = createHash('sha256');
  let n = 0;
  for (const vd of FPS)
    for (const type of ['action_approval', 'domain_risk_check', 'escalation_default'])
      for (const domain of ['finance', 'engineering', undefined])
        for (const reversible of [true, false, undefined])
          for (const magnitude of ['low', 'medium', 'high', undefined])
            for (const amount of [undefined, 50, 500, 5000])
              for (const ev of [undefined, ['ci_green']]) {
                const r = resolveConsultationCore(vd, { consultation_type: type,
                  action_descriptor: { domain, reversible, magnitude, amount },
                  ...(ev ? { context: { evidence_provided: ev } } : {}) });
                h.update(JSON.stringify([r.signal, r.confidence, r.deference_level]));
                n++;
              }
  // Synthetic profiles spanning the caution-score range: each of the three action_approval
  // cues cautious / bold / absent at two confidences, × ambiguity posture. Four hand-written
  // profiles hit only a few distinct scores, so a moved threshold between them went unseen
  // (mutation-checked: 0.55 → 0.45 on the irreversible-high branch was NOT caught before this).
  // Each cue can lean +1 / -1 / 0 (both keywords → present but neutral), so the caution score
  // is 0.5 + 0.13·k on a lattice (0.11 … 1.0). The grid reaches every k, which makes the
  // tripwire complete for threshold moves: one that crosses a reachable score is caught; one
  // that moves inside a gap changes no answer and is rightly ignored.
  const CUE_VALUES = {
    irreversible_style: ['more_cautious', 'fast_adjust', 'more_cautious fast_adjust'],
    decision_threshold: ['cover_risks', 'act_adjust', 'cover_risks act_adjust'],
    evidence_bar: ['high evidence', 'good enough', 'high evidence good enough'],
  };
  const options = (field) => [null, ...CUE_VALUES[field].flatMap((v) => [0.3, 0.6, 0.9].map((c) => ({ field, value: v, confidence: c })))];
  for (const a of options('irreversible_style')) for (const b of options('decision_threshold')) for (const c of options('evidence_bar'))
    for (const amb of [null, 'ask_first', 'assume_silent']) {
      const dr = [a, c].filter(Boolean);
      const bh = [b, amb && { field: 'handling_ambiguity', value: amb, confidence: 0.7 }].filter(Boolean);
      const vd = { phaedo_fingerprint: { persona_strength: 0.6, layers: { decision_and_risk: { signals: dr }, behavioral: { signals: bh } } } };
      for (const reversible of [true, false]) for (const magnitude of ['low', 'high']) for (const amount of [undefined, 5000])
        for (const ev of [undefined, ['ci_green']]) {
          const r = resolveConsultationCore(vd, { consultation_type: 'action_approval',
            action_descriptor: { domain: 'finance', reversible, magnitude, amount },
            ...(ev ? { context: { evidence_provided: ev } } : {}) });
          h.update(JSON.stringify([r.signal, r.confidence, r.deference_level]));
          n++;
        }
    }
  return { hash: h.digest('hex').slice(0, 16), n };
}
{
  const { hash, n } = inferredFingerprint();
  ok(n > 3000, `grid covers ${n} situations`);
  if (process.argv.includes('--print')) console.log(`${RESOLVER_REVISION}: ${hash}`);
  ok(PINNED[RESOLVER_REVISION] !== undefined,
    `RESOLVER_REVISION "${RESOLVER_REVISION}" has no pinned answer-hash. Add '${RESOLVER_REVISION}': '${hash}' to PINNED.`);
  assert.strictEqual(hash, PINNED[RESOLVER_REVISION],
    `The inferred path's answers changed but RESOLVER_REVISION is still "${RESOLVER_REVISION}". ` +
    `Bump RESOLVER_REVISION in consult-core.js (format <date>.<what changed>) and pin '${hash}' under the new name ` +
    `— otherwise receipts from two engines share one label and agreement cannot be split.`);
  pass++;
}

// ── 2. The stamp: on inferred drivers, never invented where there are none ────
const FP = FPS[1];
const req = { consultation_type: 'action_approval', action_descriptor: { domain: 'finance', reversible: true, magnitude: 'low', amount: 12000 } };
{
  const raw = await resolveConsultation(FP, req, {});
  const d = withRevision(consultDrivers(FP, req), raw);
  const rev = d.find((x) => x.cue === 'resolverRevision');
  ok(rev && rev.value === RESOLVER_REVISION && rev.confidence === null && rev.basis === null, 'rules answer → stamped with RESOLVER_REVISION');
  ok(d.filter((x) => x.cue === 'resolverRevision').length === 1, 'exactly one stamp');
  ok(withRevision([], raw).length === 0, 'no drivers (abstain / pre-flight) → no stamp invented');
  ok(Array.isArray(withRevision(undefined, raw)) && withRevision(undefined, raw).length === 0, 'missing drivers tolerated');
  ok(withRevision(consultDrivers(FP, req), { ...raw }).find((x) => x.cue === 'resolverRevision').value === RESOLVER_REVISION,
    'a copied response (e.g. the stale-authority guard) still reads as the rules');
  ok(/^\d{4}-\d{2}-\d{2}\.[a-z0-9-]+$/.test(RESOLVER_REVISION), 'revision format <date>.<what changed>');

  // The model judge, faked at the network edge.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ signal: 'clarify', confidence: 0.7, deference_level: 'medium', rationale_hint: 'x' }) } }] }) });
  try {
    const judged = await resolveConsultation(FP, req, { model: 'llama3.1:8b', modelUrl: 'http://127.0.0.1:9' });
    const dj = withRevision(consultDrivers(FP, req), judged).find((x) => x.cue === 'resolverRevision');
    ok(dj.value === 'judge:llama3.1:8b', 'judge answer → stamped judge:<model>, never the rules revision');
    globalThis.fetch = async () => { throw new Error('down'); };
    const fellBack = await resolveConsultation(FP, req, { model: 'llama3.1:8b', modelUrl: 'http://127.0.0.1:9' });
    ok(withRevision(consultDrivers(FP, req), fellBack).find((x) => x.cue === 'resolverRevision').value === RESOLVER_REVISION,
      'judge configured but failed → the rules answered → rules revision');
  } finally { globalThis.fetch = realFetch; }

  // The stamped receipt still fits the published schema.
  const schema = JSON.parse(readFileSync(join(HERE, '..', 'spec', 'schemas', 'consultation-receipt.schema.json'), 'utf8'));
  const items = schema.properties.drivers.items;
  const receipt = buildReceipt({ via: 'phaedo_consult', agentId: 't', request: req, response: raw, drivers: d });
  ok(receipt.drivers.some((x) => x.cue === 'resolverRevision' && x.value === RESOLVER_REVISION), 'stamp survives buildReceipt');
  ok(receipt.drivers.every((x) => items.required.every((k) => k in x) && Object.keys(x).every((k) => items.properties[k])), 'every driver fits the receipt schema');
}

// ── 3. The split ───────────────────────────────────────────────────────────────
{
  const NOW = Date.parse('2026-11-01T12:00:00Z');
  const at = (d) => new Date(NOW - d * 864e5).toISOString();
  const rc = (signal, user_action, days, revision, via = 'phaedo_consult') => ({
    receipt_id: `r${Math.random()}`, created_at: at(days), via,
    request: { action_descriptor: { domain: 'engineering' } }, response: { signal },
    user_action, ...(revision ? { drivers: [{ cue: 'irreversibleCaution', confidence: 0.5, basis: 'observed' }, { cue: 'resolverRevision', value: revision, confidence: null, basis: null }] } : {}),
  });
  const rs = [
    rc('proceed', 'approved', 20), rc('proceed', 'approved', 19),                       // before the stamp
    rc('proceed', 'approved', 5, 'A'), rc('proceed', 'rejected', 4, 'A'),
    rc('decline', 'rejected', 3, 'B'), rc('proceed_with_note', 'approved', 2, 'B'), rc('escalate', 'approved', 1, 'B'),
    rc('proceed', 'approved', 1, null, 'phaedo_check_authorization'),
    rc('proceed', 'approved', 40, 'A'),                                                 // outside 30d
    rc('proceed', 'approved', 2, 'judge:llama3.1:8b'),
  ];
  ok(revisionOf(rs[0]) === NOT_RECORDED && revisionOf(rs[2]) === 'A', 'revisionOf reads the stamp; none → not recorded');
  ok(revisionOf(rs[7]) === 'standing rule (pre-flight)', 'a matched pre-flight is attributed to the standing rule');
  ok(revisionOf({}) === NOT_RECORDED && revisionOf(null) === NOT_RECORDED, 'malformed → not recorded, never guessed');
  const split = computeAgreementByRevision(rs, { now: NOW });
  ok(split[NOT_RECORDED].scored === 2 && split[NOT_RECORDED].rate === 1, 'pre-stamp receipts keep their own rate');
  ok(split.A.scored === 2 && split.A.rate === 0.5, 'revision A: 1 of 2 (the 40-day-old one is outside the window)');
  ok(split.B.scored === 2 && split.B.rate === 1 && split.B.non_directional === 1, 'revision B: 2 of 2, the escalate is non-directional');
  ok(split['judge:llama3.1:8b'].scored === 1, 'judge answers are their own group');
  ok(split['standing rule (pre-flight)'].scored === 1, 'pre-flights are their own group');
  ok(Object.keys(computeAgreementByRevision(rs, { now: NOW, windowDays: 1 })).every((k) => k !== NOT_RECORDED), 'empty groups are dropped');
  ok(JSON.stringify(computeAgreementByRevision(null, { now: NOW })) === '{}', 'no receipts → empty split');
}

console.log(`✓ test-resolver-revision: ${pass} checks passed`);
