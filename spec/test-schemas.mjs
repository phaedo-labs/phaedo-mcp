#!/usr/bin/env node
// Ties the published JSON Schemas to the reference implementation: the consult
// engine's real output must satisfy the response schema, and the shipped sample
// policy must satisfy the policy schema. No JSON-Schema engine (zero deps) — a
// focused check of the contract (required keys, enums, bounds) that would actually
// drift. Run: node spec/test-schemas.mjs

import assert from 'assert';
import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { buildConsultationResponse, checkAuthorization } from '../mcp/consult.js';
import { validateFingerprint } from './validate-fingerprint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (p) => JSON.parse(readFileSync(resolve(HERE, p), 'utf8'));
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const enumOf = (schema, path) => path.split('.').reduce((o, k) => o[k], schema).enum;

// ── consultation-response.schema.json ↔ live engine output ────────────────────
console.log('\nconsultation-response schema ↔ engine');
const respSchema = load('schemas/consultation-response.schema.json');
const required = respSchema.required;
const signalEnum = enumOf(respSchema, 'properties.signal');
const defEnum = enumOf(respSchema, 'properties.deference_level');
ok(signalEnum.join(',') === 'proceed,proceed_with_note,clarify,escalate,decline,insufficient_signal', 'response signal enum is the 6 §10.3 signals (incl. insufficient_signal abstain)');
// the engine can actually emit the abstain signal (a zero-coverage fingerprint)
const abstain = buildConsultationResponse({ phaedo_fingerprint: { persona_strength: 0.3, layers: {} } }, { consultation_type: 'action_approval', action_descriptor: { domain: 'x', reversible: false, magnitude: 'high' } });
ok(abstain.signal === 'insufficient_signal' && signalEnum.includes(abstain.signal), 'engine emits insufficient_signal and it ∈ schema enum');

const fp = { phaedo_fingerprint: { persona_strength: 0.6, layers: {
  decision_and_risk: { responses: [{ answer: 'Quality over speed' }, { answer: 'much more cautious and seek more input' }] },
  behavioral: { responses: [{ answer: 'covered the main risks' }, { answer: 'ask a clarifying question' }] },
} } };
for (const t of ['action_approval', 'domain_risk_check', 'escalation_default', 'voice_draft']) {
  const r = buildConsultationResponse(fp, { consultation_type: t, action_descriptor: { domain: 'finance', reversible: false, magnitude: 'high' } });
  ok(required.every((k) => k in r), `${t}: response has all required keys`);
  ok(Object.keys(r).every((k) => respSchema.properties[k]), `${t}: response has no keys outside the schema (additionalProperties:false)`);
  ok(signalEnum.includes(r.signal), `${t}: signal ∈ schema enum`);
  ok(defEnum.includes(r.deference_level), `${t}: deference ∈ schema enum`);
  ok(typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1, `${t}: confidence in [0,1]`);
  ok(typeof r.rationale_hint === 'string' && r.rationale_hint.length <= respSchema.properties.rationale_hint.maxLength, `${t}: rationale_hint within maxLength`);
}

// ── consultation-policy.schema.json ↔ shipped sample ──────────────────────────
console.log('\nconsultation-policy schema ↔ sample');
const polSchema = load('schemas/consultation-policy.schema.json');
// Proposal 0007: match/effect moved to $defs (shared with standing_rules); rules[] $refs them.
const effectEnum = polSchema.$defs.effect.enum;
ok(effectEnum.join(',') === 'escalate,require_human,decline,autoproceed,bias_cautious,bias_bold', 'policy effect enum matches the engine');
ok('amount_gt' in polSchema.$defs.match.properties, 'policy schema defines the amount_gt numeric threshold (§10.5 authorizations)');
ok(polSchema.properties.rules.items.properties.effect.$ref === '#/$defs/effect', 'rules[] effect $refs the shared $defs');
ok(polSchema.properties.rules.items.properties.match.$ref === '#/$defs/match', 'rules[] match $refs the shared $defs');
const sample = load('../mcp/consult-policies.sample.json');
ok(Array.isArray(sample.rules) && sample.rules.length > 0, 'sample policy has rules');
ok(sample.rules.some((r) => typeof (r.match || {}).amount_gt === 'number'), 'sample includes a numeric-threshold authorization (amount_gt)');
const magEnum = polSchema.$defs.match.properties.magnitude_max.enum;
for (const r of sample.rules) {
  ok('effect' in r, `rule ${r.id || '?'}: has required 'effect'`);
  ok(effectEnum.includes(r.effect), `rule ${r.id || '?'}: effect ∈ enum (${r.effect})`);
  const m = r.match || {};
  if (m.magnitude_min) ok(magEnum.includes(m.magnitude_min), `rule ${r.id}: magnitude_min ∈ enum`);
  if (m.magnitude_max) ok(magEnum.includes(m.magnitude_max), `rule ${r.id}: magnitude_max ∈ enum`);
  if ('reversible' in m) ok(typeof m.reversible === 'boolean', `rule ${r.id}: reversible is boolean`);
  if ('amount_gt' in m) ok(typeof m.amount_gt === 'number', `rule ${r.id}: amount_gt is a number`);
}

// ── authorization-check-response.schema.json ↔ live engine output (M3) ────────
console.log('\nauthorization-check-response schema ↔ engine');
const acSchema = load('schemas/authorization-check-response.schema.json');
const acReq = acSchema.required;
const acFp = (rules) => ({ phaedo_fingerprint: { persona_strength: 0.6, consult_policies: { version: '0.1', rules },
  layers: { decision_and_risk: { responses: [{ answer: 'much more cautious and seek more input' }] } } } });
const acRule = [{ id: 'spend', match: { domains: ['financial'], reversible: false, amount_gt: 5000 }, effect: 'escalate', note: 'big spend' }];
for (const [label, ac] of [
  ['matched', checkAuthorization(acFp(acRule), { consultation_type: 'action_approval', action_descriptor: { domain: 'financial', reversible: false, amount: 12000 } })],
  ['no-match', checkAuthorization(acFp([]), { consultation_type: 'action_approval', action_descriptor: { domain: 'cooking' } })],
]) {
  ok(acReq.every((k) => k in ac), `auth-check ${label}: has all required keys`);
  ok(Object.keys(ac).every((k) => acSchema.properties[k]), `auth-check ${label}: no keys outside schema (additionalProperties:false)`);
  ok(acSchema.properties.signal.enum.includes(ac.signal), `auth-check ${label}: signal ∈ schema enum (incl. null)`);
  ok(ac.rationale_hint.length <= acSchema.properties.rationale_hint.maxLength, `auth-check ${label}: rationale_hint within maxLength`);
}

// ── consultation-request.schema.json sanity ───────────────────────────────────
console.log('\nconsultation-request schema');
const reqSchema = load('schemas/consultation-request.schema.json');
ok(reqSchema.required.includes('consultation_type'), 'request requires consultation_type');
ok(enumOf(reqSchema, 'properties.consultation_type').length === 4, 'request consultation_type enum has the 4 types');

// ── consultation-receipt.schema.json ↔ the real buildReceipt (M4, §10.6) ──────
console.log('\nconsultation-receipt schema ↔ engine');
{
  const rSchema = load('schemas/consultation-receipt.schema.json');
  const { buildReceipt } = await import('../mcp/receipts.js');
  const receipt = buildReceipt({
    via: 'phaedo_consult', agentId: 'spec-test',
    request: { consultation_type: 'action_approval', action_descriptor: { domain: 'financial', reversible: false, magnitude: 'high', amount: 12000, summary: 'x' } },
    response: { signal: 'escalate', confidence: 0.78, deference_level: 'high' },
  });
  ok(rSchema.required.every((k) => k in receipt), 'receipt has all required keys');
  ok(Object.keys(receipt).every((k) => rSchema.properties[k]), 'receipt has no keys outside the schema (additionalProperties:false)');
  ok(rSchema.properties.via.enum.includes(receipt.via), 'via ∈ schema enum');
  ok(receipt.user_action === null && rSchema.properties.user_action.enum.includes(null), 'user_action null at write, null ∈ enum');
  ok(Object.keys(receipt.response).sort().join(',') === rSchema.properties.response.required.sort().join(','), 'response carries exactly the signal fields');
  ok(!JSON.stringify(receipt).includes('rationale'), 'receipt stores no rationale/hint text');
  ok(!('drivers' in receipt), 'no drivers key when none were passed (clean for deterministic/abstain)');

  // a receipt WITH provenance drivers conforms to the (additive) schema
  const withDrivers = buildReceipt({
    via: 'phaedo_consult', agentId: 'spec-test',
    request: { consultation_type: 'action_approval', action_descriptor: { domain: 'financial', reversible: false } },
    response: { signal: 'escalate', confidence: 0.78, deference_level: 'high' },
    drivers: [{ cue: 'irreversibleCaution', lean: 0.6, confidence: 0.8, basis: 'observed' }, { cue: 'ambiguityPosture', value: 'ask_first', confidence: 0.7, basis: 'self_reported' }],
  });
  const dItems = rSchema.properties.drivers.items;
  ok(Object.keys(withDrivers).every((k) => rSchema.properties[k]), 'driver-bearing receipt has no keys outside the schema');
  ok(Array.isArray(withDrivers.drivers) && withDrivers.drivers.length === 2, 'drivers are recorded');
  ok(withDrivers.drivers.every((d) => dItems.required.every((k) => k in d) && Object.keys(d).every((k) => dItems.properties[k])), 'each driver matches the schema item shape');
  ok(!JSON.stringify(withDrivers.drivers).match(/proceed_with_note|escalate.*because|"text"/), 'drivers carry direction/confidence/basis, not layer text');
}

// ── vault-data.schema.json ↔ the runtime guards (M0.2, informative) ───────────
console.log('\nvault-data schema ↔ runtime guards');
const vdSchema = load('schemas/vault-data.schema.json');
const VD_KEYS = ['phaedo_fingerprint', 'phaedo_behavioral_signals', 'phaedo_linguistic_profile', 'phaedo_session_metrics'];
ok(Object.keys(vdSchema.properties).sort().join(',') === [...VD_KEYS].sort().join(','), 'vd schema documents exactly the 4 wrapper keys');
ok(!vdSchema.required, 'vd schema has no required keys (an empty vault is legitimate)');
ok(/INFORMATIVE/.test(vdSchema.title), 'vd schema is marked INFORMATIVE (not a wire artifact)');
{
  const { validateVaultShape } = await import('../mcp/consult-core.js');
  const { readdirSync } = await import('fs');
  // The snapshot fixture corpus lives in the (private) monorepo's scripts/; in the
  // public phaedo-mcp repo, validate the guard + the shipped sample instead.
  const fixDir = resolve(HERE, '..', 'scripts', 'fixtures', 'context-block');
  if (existsSync(fixDir)) {
    const fixtures = readdirSync(fixDir).filter((f) => f.endsWith('.vd.json'));
    ok(fixtures.length >= 5, 'fixture corpus present (≥5 payloads)');
    for (const f of fixtures) {
      const vd = JSON.parse(readFileSync(resolve(fixDir, f), 'utf8'));
      ok(validateVaultShape(vd).length === 0, `${f}: conforms to the vd contract`);
      ok(Object.keys(vd).every((k) => VD_KEYS.includes(k)), `${f}: uses only documented wrapper keys`);
    }
  } else {
    const sample = load('../mcp/sample-fingerprint.json');
    ok(validateVaultShape(sample).length === 0, 'shipped sample conforms to the vd contract');
    ok(Object.keys(sample).every((k) => VD_KEYS.includes(k)), 'sample uses only documented wrapper keys');
  }
  ok(validateVaultShape({ phaedo_fingerprint: { layers: null } }).length > 0, 'guard rejects a type breach (layers: null)');
}

// ── decision-risk-signal.schema.json ↔ what extraction emits (0002, §4.2.7) ───
// The producer side lives in the (private) extraction pipeline — present in the
// monorepo, absent in the public phaedo-mcp repo. Skip the producer↔schema tie
// when extraction/ isn't checked out; the schema itself is still validated above.
if (existsSync(resolve(HERE, '../extraction/fingerprint-update.js'))) {
  console.log('\ndecision-risk-signal schema ↔ extraction emission');
  const drSchema = load('schemas/decision-risk-signal.schema.json');
  const { buildFingerprintUpdate } = await import('../extraction/fingerprint-update.js');
  const u = buildFingerprintUpdate([
    { layer: 'decision_and_risk', field: 'evidence_threshold', polarity: 'positive', value: 0.8, confidence: 0.7, source: 'extraction' },
  ], { sessionId: 's', now: '2026-06-10T00:00:00Z' });
  const sig = u.decision_and_risk.signals[0];
  ok(drSchema.required.every((k) => k in sig), 'emitted D&R signal has all required 0002 keys');
  ok(sig.dimension === 'evidence_threshold' && sig.field === sig.dimension, 'dimension == field');
  ok(drSchema.properties.evidence_basis.enum.includes(sig.evidence_basis), 'evidence_basis ∈ schema enum');
  ok(drSchema.properties.polarity.enum.includes(sig.polarity), 'polarity ∈ schema enum');
  ok(typeof sig.confidence === 'number' && sig.confidence >= 0 && sig.confidence <= 1, 'confidence in [0,1]');
}

// ── fingerprint.schema.json ↔ the real producer output (P1.1 conformance tie) ──
// Closes the central drift: until now nothing validated an *emitted fingerprint*
// against the published schema (only the consult surface was tied). This is the
// fingerprint analogue of the consult tie above. Zero-dep house style: a focused
// checker that READS its enums/bounds/required-keys FROM the loaded schema, so
// tightening the schema tightens the check (the schema stays the source of
// truth). Uniqueness per (field, polarity, domain) — which JSON Schema cannot
// express across array items — is enforced here too.
console.log('\nfingerprint schema ↔ producer output');
const fpSchema = load('schemas/fingerprint.schema.json');
ok(fpSchema.required.includes('phaedo_fingerprint'), 'fingerprint schema requires phaedo_fingerprint');
ok(fpSchema.properties.phaedo_fingerprint.properties.layers, 'fingerprint schema defines layers');
ok(!!fpSchema.$defs.signal && !!fpSchema.$defs.layer, 'fingerprint schema defines layer + signal');
// delegation channel reserved (Slice 4): the signal $def documents origin self|delegation
ok(fpSchema.$defs.signal.properties.origin?.enum?.join(',') === 'self,delegation', 'signal schema reserves the origin (self|delegation) delegation channel');

// validateFingerprint is the shared checker imported from validate-fingerprint.mjs
// (the same code the `phaedo-validate` CLI runs) — the tie and the tool can never
// disagree. It reads its enums/bounds/required-keys from the schema we pass in.

// (1) The shipped real artifact conforms.
const sampleFp = load('../mcp/sample-fingerprint.json').phaedo_fingerprint;
ok(validateFingerprint(sampleFp, fpSchema).length === 0, 'shipped sample fingerprint conforms to the schema');

// (2) Live extraction→reconcile output, assembled + stamped through the REAL
// producer (migration.stampProtocolFields), conforms — proving the shipping
// producer emits a schema-valid fingerprint, not just a hand-built fixture.
if (existsSync(resolve(HERE, '../extraction/fingerprint-update.js'))) {
  const { buildFingerprintUpdate: bfu } = await import('../extraction/fingerprint-update.js');
  const { reconcileFingerprint } = await import('../extraction/reconcile.js');
  const mig = (await import('../migration.js')).default;   // classic CJS module → its api
  const now = '2026-06-15T00:00:00Z';
  const upd = bfu([
    { layer: 'surface', field: 'directness', polarity: 'positive', value: 'high', confidence: 0.7, source: 'extraction' },
    { layer: 'decision_and_risk', field: 'evidence_threshold', polarity: 'positive', value: 0.8, confidence: 0.6, source: 'extraction' },
  ], { sessionId: 's1', now });
  const reconciled = reconcileFingerprint({}, upd, { now });
  // mirror the product assembly (identity/derived) then the §4.1 protocol stamp.
  const assembled = { fingerprint_id: 'f-test', persona_strength: 0.6, updated_at: now, ...reconciled };
  const stamped = mig.stampProtocolFields(assembled, { mintSubject: true });
  ok(stamped.changed && stamped.fp.phaedo_protocol_version === '0.1' && typeof stamped.fp.subject_id === 'string' && Number.isInteger(stamped.fp.schema_revision),
     'producer stamps the §4.1 protocol-identity fields');
  ok(validateFingerprint(stamped.fp, fpSchema).length === 0, 'live extraction→reconcile output (producer-stamped) conforms to the schema');
}

// (3) The tie actually catches the drift classes it exists to catch.
ok(validateFingerprint({ layers: { surface: { signals: [
  { field: 'x', polarity: 'positive', value: 'a' }, { field: 'x', polarity: 'positive', value: 'a' },
] } } }, fpSchema).some((e) => /duplicate/.test(e)), 'catches duplicate signal (uniqueness the schema cannot express)');
ok(validateFingerprint({ layers: { surface: { signals: [
  { field: 'x', polarity: 'sideways', value: 'a' },
] } } }, fpSchema).some((e) => /polarity/.test(e)), 'catches non-enum polarity');
ok(validateFingerprint({ layers: { surface: { confidence: 2, signals: [] } } }, fpSchema).some((e) => /confidence/.test(e)), 'catches out-of-range confidence');
ok(validateFingerprint({ layers: { surface: { signals: [{ field: 'x', polarity: 'positive' }] } } }, fpSchema).some((e) => /missing value/.test(e)), 'catches missing required value');

// §4.7 conflict_records — the drift gate for the spec v0.1.40 validator walk.
// Previously these only failed via spec/test-vectors.mjs (BAD-0014); putting them
// HERE means a CI run of just test-schemas.mjs also catches a regression.
ok(validateFingerprint({ conflict_records: [{ resolution: { by: 'oracle' } }] }, fpSchema).some((e) => /resolution\.by/.test(e)),
   'catches conflict_records[].resolution.by not in enum');
ok(validateFingerprint({ conflict_records: [{}] }, fpSchema).some((e) => /missing conflict_id|missing layer|missing field|missing status|missing candidates/.test(e)),
   'catches a conflict_record missing all required fields (was silent-accepted before the required-field walk)');
ok(validateFingerprint({ conflict_records: [{ conflict_id: 'c', layer: 'surface', field: 'x', status: 'resolved', candidates: [],
   resolution: { by: 'system' } }] }, fpSchema).some((e) => /chosen_value|prior_value/.test(e)),
   "catches a by:'system' resolution missing chosen_value/prior_value (the audit pair the review UI dispatches on)");

// §4.7 PRODUCER PARITY for BAD-0014 — the schema's resolution.by enum is enforced
// at validate-time but no test asserts producer source files only write enum values.
// A future commit that slipped `by: 'oracle'` into reconcile.js / conflict-review.js
// / mobile would only fail at validation (and only when someone runs the validator) —
// silent staged data otherwise. This drift gate reads the schema enum and greps every
// `by: 'value'` literal in the producer files; every captured value must be in the
// enum. Object-key syntax (`by:\s*['"]...['"]`) only matches write sites; filter
// expressions (`x.resolution.by === 'system'`) don't match (no colon, comparison op).
{
  const byEnum = new Set(fpSchema.properties.phaedo_fingerprint.properties.conflict_records.items.properties.resolution.properties.by.enum);
  const { readFileSync } = await import('node:fs');
  const { resolve: r2 } = await import('node:path');
  const repoRoot = r2(HERE, '..');
  const PRODUCER_FILES = [
    r2(repoRoot, 'extraction/reconcile.js'),
    r2(repoRoot, 'conflict-review.js'),
    r2(repoRoot, 'mobile/src/lib/conflictReview.ts'),
  ].filter((f) => existsSync(f));   // public repo ships spec/ without the producers — gate what's present
  const offenders = [];
  for (const file of PRODUCER_FILES) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bby:\s*['"](\w+)['"]/g)) {
      if (!byEnum.has(m[1])) offenders.push(`${file}: by:'${m[1]}'`);
    }
  }
  ok(offenders.length === 0,
     `producer parity for resolution.by enum [${[...byEnum].sort().join(',')}] — every literal in producer source must be in the schema enum; offenders: ${offenders.join(' | ')}`);
}

// (4) Runtime guard (the product's fail-safe) and the published schema agree on a breach.
{
  const { validateVaultShape } = await import('../mcp/consult-core.js');
  const breach = { phaedo_fingerprint: { layers: null } };
  ok(validateVaultShape(breach).length > 0 && validateFingerprint(breach.phaedo_fingerprint, fpSchema).length > 0,
     'runtime guard and published schema agree: layers:null is a breach');
}

// (5) The phaedo-validate CLI (P1.2) — the implementer-facing surface — exits 0
// on the conforming sample and 1 on a known-bad fixture, end-to-end.
{
  const { execFileSync } = await import('node:child_process');
  const cli = resolve(HERE, 'validate-fingerprint.mjs');
  const run = (file) => {
    try { execFileSync('node', [cli, resolve(HERE, file)], { stdio: 'pipe' }); return 0; }
    catch (e) { return e.status ?? -1; }
  };
  ok(run('../mcp/sample-fingerprint.json') === 0, 'phaedo-validate CLI exits 0 on the conforming sample');
  ok(run('fixtures/bad-fingerprint.json') === 1, 'phaedo-validate CLI exits 1 on a non-conforming fixture');
}

// ── standing_rules ↔ schema (Proposal 0007, one authored home) ────────────────
console.log('\nstanding_rules schema (Proposal 0007)');
{
  const sr = fpSchema.properties.phaedo_fingerprint.properties.standing_rules;
  ok(!!sr && sr.type === 'array', 'fingerprint schema defines standing_rules[]');
  const it = sr.items;
  ok(it.required.includes('kind'), 'kind is required on every entry');
  ok(it.properties.kind.enum.join(',') === 'instruction,authorization', 'kind discriminator enum = instruction,authorization');
  // conditional required: instruction⇒text, authorization⇒effect (allOf if/then)
  const conds = (it.allOf || []).map((c) => [c.if.properties.kind.const, c.then.required[0]]);
  ok(conds.some(([k, r]) => k === 'instruction' && r === 'text'), 'instruction requires text');
  ok(conds.some(([k, r]) => k === 'authorization' && r === 'effect'), 'authorization requires effect');
  // the authorization variant shares the §10.5 $defs (single definition, no drift)
  ok(it.properties.match.$ref === 'consultation-policy.schema.json#/$defs/match', 'authorization match $refs the shared §10.5 $defs');
  ok(it.properties.effect.$ref === 'consultation-policy.schema.json#/$defs/effect', 'authorization effect $refs the shared §10.5 $defs');
  // decision binding shape
  ok(it.properties.decision.required.includes('dimension'), 'decision binding requires a dimension');
  ok(it.properties.decision.properties.polarity.enum.join(',') === 'positive,negative', 'decision polarity enum = positive,negative');
  ok('value' in it.properties.decision.properties, 'decision binding carries an optional catalog value (template-sourced rules)');
  ok(it.properties.source.enum.join(',') === 'interview,interview_template,delta_promotion,delegation_promotion', 'source provenance enum incl. interview_template + delegation_promotion');
  ok(it.properties.decision.properties.origin.enum.join(',') === 'self,delegation', 'decision binding carries an optional origin (act-as-me authored rules)');
  // focused structural check (validateFingerprint covers layers/signals, not the authored block)
  const reqFor = (e) => e.kind === 'instruction' ? ['kind', 'text'] : e.kind === 'authorization' ? ['kind', 'effect'] : ['kind'];
  const validRule = (e) => reqFor(e).every((k) => k in e);
  ok(validRule({ kind: 'instruction', text: 'I confirm recurring costs in writing.', decision: { dimension: 'evidence_threshold', polarity: 'negative' } }), 'a well-formed instruction validates');
  ok(!validRule({ kind: 'instruction' }), 'an instruction without text is rejected');
  ok(validRule({ kind: 'authorization', match: { domains: ['finance'], amount_gt: 5000 }, effect: 'escalate' }), 'a well-formed authorization validates');
  ok(!validRule({ kind: 'authorization', match: {} }), 'an authorization without effect is rejected');
}

// ── §4.2 per-layer vocabulary ↔ the producer catalog (P2.1, OQ13) ─────────────
console.log('\nlayer vocabulary ↔ catalog (§4.2 / OQ13)');
{
  const vocab = load('layer-vocabulary.json');
  const CANON = ['surface', 'behavioral', 'creative', 'domain_and_expertise', 'temporal_and_context', 'collaboration_and_relationship', 'decision_and_risk', 'big_picture'];
  ok(vocab.behavioral_layers.join(',') === CANON.join(','), 'behavioral_layers lists the 8 canonical layers in order');
  ok(Object.keys(vocab.layers).every((l) => CANON.includes(l)), 'every vocabulary layer is a canonical layer');
  // When the producer catalog is present (monorepo), the published vocabulary must
  // match it exactly — no drift. (Skipped in the public repo, where extraction/ is absent.)
  if (existsSync(resolve(HERE, '../extraction/catalog.js'))) {
    const { CATALOG } = await import('../extraction/catalog.js');
    const fromCatalog = {};
    for (const e of CATALOG) (fromCatalog[e.layer] ??= new Set()).add(e.field);
    for (const l of CANON) {
      if (!fromCatalog[l]) continue;
      const expected = [...fromCatalog[l]].sort().join(',');
      ok(`${l}: published vocabulary matches the catalog`, (vocab.layers[l] || []).slice().sort().join(',') === expected);
    }
  }
}

// ── §11.3 conformance statement ↔ reality (P1.4) ──────────────────────────────
// The published self-identification must not drift from the spec or the vectors.
console.log('\nconformance statement ↔ reality (§11.3)');
{
  const conf = load('conformance.json');
  // protocol_version tracks the spec document version.
  const specMd = readFileSync(resolve(HERE, '../docs/protocol/v0.1.md'), 'utf8');
  const specVer = (specMd.match(/^# .*\bv(\d+\.\d+(?:\.\d+)?)/m) || [])[1];  // title-agnostic (name may change)
  ok(!!specVer && conf.protocol_version === specVer, `conformance protocol_version (${conf.protocol_version}) matches the spec (${specVer})`);
  // The Level-0 tier is declared and points at the real product surface.
  ok(conf.levels.includes(0) && conf.profiles.includes('Projection Consumer'), 'declares Level 0 / Projection Consumer');
  ok(/phaedo:\/\/fingerprint\/projection/.test(conf.level_0_surface), 'Level-0 surface names the real MCP projection resource');
  // The categories reported as passing must be exactly the populated vector sets.
  const vectorFiles = ['canonicalization.json', 'fingerprint-conformance.json', 'consultation.json', 'resolution.json'];
  const populated = vectorFiles.map((f) => load(`test-vectors/${f}`).category).sort();
  const claimedPass = Object.entries(conf.test_vector_results).filter(([, v]) => v === 'pass').map(([k]) => k).sort();
  ok(claimedPass.join(',') === populated.join(','), `reported-passing categories (${claimedPass.join(',')}) match the populated vector sets`);
}

console.log(`\n✓ spec schemas: ${pass} checks passed`);
