#!/usr/bin/env node
// Phaedo fingerprint conformance validator — "phaedo-validate" (P1.2).
//
// The SINGLE checker shared by the spec conformance tie (spec/test-schemas.mjs)
// and the CLI an implementer runs on their own producer output. Keeping one
// checker means the tie and the tool can never disagree. Zero-dep, house style:
// it READS its enums/bounds/required-keys FROM fingerprint.schema.json, so the
// published schema stays the source of truth. It additionally enforces signal
// uniqueness per (field, polarity, domain) — the §4.2.7 reconcile key — which
// JSON Schema cannot express across array items.
//
// Library:
//   import { validateFingerprint, validateVaultData, loadFingerprintSchema } from './validate-fingerprint.mjs'
//   validateFingerprint(fp)  → string[] of human-readable errors ([] = conforms)
//   validateVaultData(vd)    → same, for an Appendix-C runtime wrapper (empty vault = [])
//
// CLI:
//   node spec/validate-fingerprint.mjs <fingerprint-or-vault.json> [more.json ...]
//   exit 0 = all conform · 1 = at least one non-conforming · 2 = usage/read error

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadFingerprintSchema() {
  return JSON.parse(readFileSync(resolve(HERE, 'schemas', 'fingerprint.schema.json'), 'utf8'));
}

export function loadUserConfigurationSchema() {
  return JSON.parse(readFileSync(resolve(HERE, 'schemas', 'user-configuration.schema.json'), 'utf8'));
}

// The §5.2 standing-instruction entry shape is canonical in
// user-configuration.schema.json ($defs/standing_instruction); the fingerprint
// A-home's standing_rules[] $refs it. Resolve that one ref here so both homes
// validate against the single definition.
function standingInstructionDef(ucSchema = loadUserConfigurationSchema()) {
  return ucSchema.$defs.standing_instruction;
}

const isObj = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);

// §4.6 layer admission: the eight layers are BEHAVIORAL (persona patterns); they
// do not admit episodic content (a URL, email, or specific domain is a fact about
// a life, not a stable pattern — it belongs to the separate, opt-in content scope).
// High-precision markers only, to avoid flagging legitimate free-text values
// (e.g. "node.js" — .js is not a web TLD here). MUST match the producer-side
// guard in extraction/fingerprint-update.js.
const EPISODIC_RE = /(https?:\/\/|\bwww\.)|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|\b[a-z0-9][a-z0-9-]*\.(com|org|net|io|so|co|ai|app|xyz|info)\b/i;
const valueText = (v) => Array.isArray(v) ? v.map(valueText).join(' ') : (v == null ? '' : String(v));

// Projection hygiene (§4.6 + P0, 2026-06-16). The rendered `summary` is the
// human-readable projection consumers inject VERBATIM (context-block.js §5b).
// The producer's renderLayerSummary guards it at generation, but the STANDARD
// must enforce independently — a third-party or stale producer's summary is
// untrusted, and a fingerprint that conforms structurally can still project
// garbage. Summaries are "- Label: value" lines. MUST stay in sync with the
// renderer's sanitizeSummary() in context-block.js.
const SUMMARY_DIM_RE = /^[-*\s]*([^:]{1,60}):\s*(.+)$/;     // "- Label: value"
// Whole value is an opaque code (e.g. "s2", "s2 d", "s2_d"). Anchored + a
// separator before any second token, so contiguous real codes (e.g. "H1B")
// do NOT match — only producer-internal codes that aren't human-readable.
const SUMMARY_OPAQUE_RE = /^[a-z]\d(?:[ _][a-z0-9]+)*$/i;
function checkSummary(text, lid) {
  const errs = [];
  const at = `layer ${lid}.summary`;
  const seenDims = new Set();
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;             // headings/blank
    if (EPISODIC_RE.test(line)) errs.push(`${at} carries episodic content (URL/email/domain) — not admitted in a behavioral layer (§4.6)`);
    const m = line.match(SUMMARY_DIM_RE);
    if (!m) continue;
    const dim = m[1].trim().toLowerCase(), val = m[2].trim();
    if (seenDims.has(dim)) errs.push(`${at} repeats dimension "${m[1].trim()}" — emit one resolved value per dimension`);
    seenDims.add(dim);
    if (SUMMARY_OPAQUE_RE.test(val)) errs.push(`${at} has an opaque/non-human-readable value ("${val}") for "${m[1].trim()}"`);
  }
  return errs;
}

// Validate a §4.1 fingerprint document (the inner phaedo_fingerprint object).
export function validateFingerprint(fp, schema = loadFingerprintSchema()) {
  const fpDef = schema.properties.phaedo_fingerprint;
  const sigDef = schema.$defs.signal;
  const layerDef = schema.$defs.layer;
  const inRange = (x, p) => typeof x === 'number' && x >= (p.minimum ?? -Infinity) && x <= (p.maximum ?? Infinity);
  const errs = [];
  if (!isObj(fp)) return ['fingerprint must be an object'];
  for (const k of (fpDef.required || [])) if (!(k in fp)) errs.push(`missing required ${k}`);
  // §4.1 identity fields — TYPE/shape, not just presence. Consumers branch on the
  // version string (.startsWith()/.split('.')), so a non-string or garbage version
  // must not pass conformance (validateFingerprint is the sole authority — there is
  // no ajv backstop).
  const pvDef = fpDef.properties.phaedo_protocol_version;
  if ('phaedo_protocol_version' in fp &&
      !(typeof fp.phaedo_protocol_version === 'string' && new RegExp(pvDef.pattern).test(fp.phaedo_protocol_version)))
    errs.push('phaedo_protocol_version must be a "MAJOR.MINOR" string');
  if ('subject_id' in fp && typeof fp.subject_id !== 'string') errs.push('subject_id must be a string');
  if ('schema_revision' in fp && !(Number.isInteger(fp.schema_revision) && fp.schema_revision >= 0))
    errs.push('schema_revision must be an integer >= 0');
  if ('layers' in fp && !isObj(fp.layers)) errs.push('layers must be an object');
  if (fp.persona_strength !== undefined && !inRange(fp.persona_strength, fpDef.properties.persona_strength)) errs.push('persona_strength out of [0,1]');
  for (const [lid, L] of Object.entries(isObj(fp.layers) ? fp.layers : {})) {
    if (!isObj(L)) { errs.push(`layer ${lid} must be an object`); continue; }
    if (L.confidence !== undefined && !inRange(L.confidence, layerDef.properties.confidence)) errs.push(`layer ${lid}.confidence out of [0,1]`);
    if (L.signals !== undefined && !Array.isArray(L.signals)) { errs.push(`layer ${lid}.signals must be an array`); continue; }
    const seen = new Set();
    for (const [i, s] of (L.signals || []).entries()) {
      const at = `layer ${lid}.signals[${i}]`;
      if (!isObj(s)) { errs.push(`${at} must be an object`); continue; }
      for (const k of (sigDef.required || [])) if (!(k in s)) errs.push(`${at} missing ${k}`);
      if (s.polarity !== undefined && !sigDef.properties.polarity.enum.includes(s.polarity)) errs.push(`${at}.polarity not in enum`);
      if (s.evidence_basis !== undefined && !sigDef.properties.evidence_basis.enum.includes(s.evidence_basis)) errs.push(`${at}.evidence_basis not in enum`);
      if (s.confidence !== undefined && !inRange(s.confidence, sigDef.properties.confidence)) errs.push(`${at}.confidence out of [0,1]`);
      if (EPISODIC_RE.test(valueText(s.value))) errs.push(`${at} value carries episodic content (URL/email/domain) — not admitted in a behavioral layer (§4.6)`);
      const key = `${s.field}::${s.polarity}::${s.domain ?? ''}`;   // §4.2.7 reconcile key
      if (seen.has(key)) errs.push(`${at} duplicate signal (field,polarity,domain)=${key}`);
      seen.add(key);
    }
    if (typeof L.summary === 'string' && L.summary.trim()) for (const e of checkSummary(L.summary, lid)) errs.push(e);
  }
  // §4.7 conflict_records — the new `resolution` shape carries authority/provenance.
  // Validate the bits that matter operationally: `by` is the cue the review surface
  // dispatches on (system→show, user→hide), so an unknown value would silently mis-route.
  if (Array.isArray(fp.conflict_records)) {
    const crDef = fpDef.properties.conflict_records && fpDef.properties.conflict_records.items;
    const crProps = (crDef && crDef.properties) || {};
    const crRequired = (crDef && Array.isArray(crDef.required)) ? crDef.required : [];
    const statusEnum = crProps.status && crProps.status.enum;
    const byEnum = crProps.resolution && crProps.resolution.properties && crProps.resolution.properties.by && crProps.resolution.properties.by.enum;
    for (const [i, r] of fp.conflict_records.entries()) {
      const at = `conflict_records[${i}]`;
      if (!isObj(r)) { errs.push(`${at} must be an object`); continue; }
      // Required-field walk (mirrors the signal pattern at line 91) — previously a
      // record missing all required fields would silently validate. Schema says
      // {conflict_id, layer, field, status, candidates} are required.
      for (const k of crRequired) if (!(k in r)) errs.push(`${at} missing ${k}`);
      if (statusEnum && r.status !== undefined && !statusEnum.includes(r.status)) errs.push(`${at}.status not in enum`);
      if (isObj(r.resolution) && byEnum && r.resolution.by !== undefined && !byEnum.includes(r.resolution.by)) {
        errs.push(`${at}.resolution.by not in enum (got "${r.resolution.by}")`);
      }
      // by:'system' carries an auto-resolution — the audit pair (chosen_value+prior_value)
      // is what makes it actionable in the review UI. A system override missing either
      // would render an empty card and produce a useless revert. Enforce.
      if (isObj(r.resolution) && r.resolution.by === 'system') {
        if (!('chosen_value' in r.resolution)) errs.push(`${at}.resolution missing chosen_value (required when by='system')`);
        if (!('prior_value' in r.resolution))  errs.push(`${at}.resolution missing prior_value (required when by='system')`);
      }
    }
  }
  // §5.2 standing_rules — injected VERBATIM into the context block ("Injected as-is —
  // MUST NOT be summarized"), so the standard must independently bound them: a stale
  // or third-party producer's rule is untrusted (same reasoning as the summary
  // re-check above). Same rail as the §5 sibling's standing_instructions (one
  // canonical entry shape — user-configuration.schema.json $defs/standing_instruction).
  for (const e of checkAuthoredRules(fp.standing_rules, 'standing_rules')) errs.push(e);
  for (const e of checkCommitments(fp.commitments)) errs.push(e);
  return errs;
}

// §5.7 decision state. Three properties are load-bearing and therefore checked
// rather than assumed:
//   - `expires_at` REQUIRED and parseable. Decision state that outlives its
//     situation blocks work forever, which is worse than not recording it.
//   - `effect` restricted to deferential outcomes. `autoproceed` here would be a
//     second, unaudited path to autonomy expansion.
//   - `source` may only be `subject`. Commitments are authored (§5.6); an inferred
//     one is a schema violation, not a convention.
// The §4.6 episodic rail deliberately does NOT apply — a commitment names
// counterparties and dates by nature, which is why it never enters the projection.
const COMMITMENT_EFFECTS = ['escalate', 'decline', 'bias_cautious'];
function checkCommitments(arr) {
  const errs = [];
  if (arr !== undefined && !Array.isArray(arr)) return ['commitments must be an array'];
  for (const [i, c] of (Array.isArray(arr) ? arr : []).entries()) {
    const at = `commitments[${i}]`;
    if (!isObj(c)) { errs.push(`${at} must be an object`); continue; }
    if (typeof c.commitment_id !== 'string' || !c.commitment_id) errs.push(`${at}.commitment_id must be a non-empty string`);
    if (typeof c.statement !== 'string' || !c.statement.trim()) errs.push(`${at}.statement must be a non-empty string`);
    if (typeof c.statement === 'string' && c.statement.length > 500) errs.push(`${at}.statement exceeds maxLength 500`);
    if (!COMMITMENT_EFFECTS.includes(c.effect)) errs.push(`${at}.effect must be one of: ${COMMITMENT_EFFECTS.join(', ')} (a commitment may never expand autonomy)`);
    if (typeof c.expires_at !== 'string' || !Number.isFinite(Date.parse(c.expires_at))) errs.push(`${at}.expires_at is required and must be an RFC 3339 timestamp`);
    if (c.kind !== undefined && !['commitment', 'constraint'].includes(c.kind)) errs.push(`${at}.kind not in enum`);
    if (c.source !== undefined && c.source !== 'subject') errs.push(`${at}.source must be "subject" — commitments are authored, never inferred`);
    if (c.disclose !== undefined && typeof c.disclose !== 'boolean') errs.push(`${at}.disclose must be a boolean`);
    if (c.domains !== undefined && !(Array.isArray(c.domains) && c.domains.every((d) => typeof d === 'string'))) errs.push(`${at}.domains must be an array of strings`);
  }
  return errs;
}

// Shared rail for the ONE authored-rule entry shape, applied to both homes:
// fingerprint.standing_rules (v0.1 A-home) and the §5 config's
// standing_instructions. Enforces kind enum, the instruction→text conditional,
// the text maxLength, and the episodic-content rail.
function checkAuthoredRules(arr, label, itemsDef = standingInstructionDef()) {
  const errs = [];
  const kindEnum = itemsDef && itemsDef.properties && itemsDef.properties.kind && itemsDef.properties.kind.enum;
  const textMax = (itemsDef && itemsDef.properties && itemsDef.properties.text && itemsDef.properties.text.maxLength) || 1000;
  for (const [i, r] of (Array.isArray(arr) ? arr : []).entries()) {
    const at = `${label}[${i}]`;
    if (!isObj(r)) { errs.push(`${at} must be an object`); continue; }
    if (!('kind' in r)) errs.push(`${at} missing kind`);
    else if (kindEnum && !kindEnum.includes(r.kind)) errs.push(`${at}.kind not in enum`);
    if (r.kind === 'instruction' && typeof r.text !== 'string') errs.push(`${at} instruction requires text`);
    if (r.kind === 'authorization' && r.effect === undefined) errs.push(`${at} authorization requires effect`);
    if (r.text !== undefined && typeof r.text !== 'string') errs.push(`${at}.text must be a string`);
    if (typeof r.text === 'string' && r.text.length > textMax) errs.push(`${at}.text exceeds maxLength ${textMax}`);
    if (typeof r.text === 'string' && EPISODIC_RE.test(r.text)) errs.push(`${at}.text carries episodic content (URL/email/domain) — not admitted in an injected rule (§4.6)`);
    // §5.2 v0.2 scope (OQ5): a scoped rule must carry its activation keys — a
    // scope:'domain' rule with no scope_domains could never activate (or worse,
    // a lenient consumer would apply it globally).
    const scopeEnum = itemsDef && itemsDef.properties && itemsDef.properties.scope && itemsDef.properties.scope.enum;
    if (r.scope !== undefined && scopeEnum && !scopeEnum.includes(r.scope)) errs.push(`${at}.scope not in enum`);
    const nonEmptyStrArr = (a) => Array.isArray(a) && a.length > 0 && a.every((s) => typeof s === 'string' && s);
    if (r.scope === 'domain' && !nonEmptyStrArr(r.scope_domains)) errs.push(`${at} scope 'domain' requires a non-empty scope_domains array of strings`);
    if (r.scope === 'task' && !nonEmptyStrArr(r.scope_tasks)) errs.push(`${at} scope 'task' requires a non-empty scope_tasks array of strings`);
    // §10.5 binding gate. Typed strictly: a resolver reads `require_binding === true`,
    // so a truthy-but-not-true value ("yes", 1) would be silently ignored and the
    // subject would believe an autoproceed rule was gated when it is not.
    if (r.require_binding !== undefined && typeof r.require_binding !== 'boolean')
      errs.push(`${at}.require_binding must be a boolean`);
    if (r.require_binding !== undefined && r.kind !== 'authorization')
      errs.push(`${at}.require_binding applies to authorizations only`);
  }
  return errs;
}

// Validate a §5 User Configuration document (the inner phaedo_user_configuration
// object). Same zero-dep house style as validateFingerprint: required/type/enum
// checks read FROM user-configuration.schema.json, plus the standing-instruction
// rail shared with the fingerprint A-home. The §5.3 example corpus is authored
// CONTENT by definition — the §4.6 episodic rail deliberately does NOT apply to
// example content (a writing sample may legitimately contain a URL).
export function validateUserConfiguration(cfg, schema = loadUserConfigurationSchema()) {
  const cfgDef = schema.properties.phaedo_user_configuration;
  const errs = [];
  if (!isObj(cfg)) return ['user configuration must be an object'];
  for (const k of (cfgDef.required || [])) if (!(k in cfg)) errs.push(`missing required ${k}`);
  const pvDef = cfgDef.properties.phaedo_protocol_version;
  if ('phaedo_protocol_version' in cfg &&
      !(typeof cfg.phaedo_protocol_version === 'string' && new RegExp(pvDef.pattern).test(cfg.phaedo_protocol_version)))
    errs.push('phaedo_protocol_version must be a "MAJOR.MINOR" string');
  for (const k of ['configuration_id', 'subject_id', 'fingerprint_id']) {
    if (k in cfg && !(typeof cfg[k] === 'string' && cfg[k])) errs.push(`${k} must be a non-empty string`);
  }
  if ('schema_revision' in cfg && !(Number.isInteger(cfg.schema_revision) && cfg.schema_revision >= 0))
    errs.push('schema_revision must be an integer >= 0');
  if ('standing_instructions' in cfg && !Array.isArray(cfg.standing_instructions))
    errs.push('standing_instructions must be an array');
  for (const e of checkAuthoredRules(cfg.standing_instructions, 'standing_instructions')) errs.push(e);
  // §5.3 example corpus.
  const exDef = cfgDef.properties.example_corpus.items;
  const exKindEnum = exDef.properties.kind.enum;
  const contentMax = exDef.properties.content.maxLength;
  if ('example_corpus' in cfg && !Array.isArray(cfg.example_corpus)) errs.push('example_corpus must be an array');
  for (const [i, ex] of (Array.isArray(cfg.example_corpus) ? cfg.example_corpus : []).entries()) {
    const at = `example_corpus[${i}]`;
    if (!isObj(ex)) { errs.push(`${at} must be an object`); continue; }
    for (const k of (exDef.required || [])) if (!(k in ex)) errs.push(`${at} missing ${k}`);
    if (ex.kind !== undefined && !exKindEnum.includes(ex.kind)) errs.push(`${at}.kind not in enum`);
    if (ex.content !== undefined && typeof ex.content !== 'string') errs.push(`${at}.content must be a string`);
    if (typeof ex.content === 'string' && ex.content.length > contentMax) errs.push(`${at}.content exceeds maxLength ${contentMax}`);
    if (ex.label !== undefined && typeof ex.label !== 'string') errs.push(`${at}.label must be a string`);
    if (ex.tags !== undefined && !(Array.isArray(ex.tags) && ex.tags.every((t) => typeof t === 'string')))
      errs.push(`${at}.tags must be an array of strings`);
  }
  return errs;
}

// ── Conflict resolution (Proposal 0006, Route A) ───────────────────────────────
// The §4.7 resolver now lives in ../extraction/resolve.js (browser-safe + packaged
// with the extension's extraction engine, so the producer renders FROM it — one
// deterministic resolver, no divergence). Re-exported here so the spec test-vectors
// and mcp/health keep importing it from this module unchanged.
export { resolveDimension, resolveLayer, resolveEffective, RESOLUTION_FLOOR } from '../extraction/resolve.js';

// Validate an Appendix-C runtime vault payload. An empty vault (no
// phaedo_fingerprint) is legitimate (nothing to render) → no errors. When the
// §5 sibling artifact rides the payload (config home migration, part 2) it is
// validated too, including the §5.4 pairing invariant against the fingerprint.
export function validateVaultData(vd, schema = loadFingerprintSchema()) {
  if (!isObj(vd)) return ['vault data must be an object'];
  const errs = [];
  if (vd.phaedo_fingerprint != null) errs.push(...validateFingerprint(vd.phaedo_fingerprint, schema));
  if (vd.phaedo_user_configuration != null) {
    const cfg = vd.phaedo_user_configuration;
    errs.push(...validateUserConfiguration(cfg).map((e) => `phaedo_user_configuration: ${e}`));
    const fp = vd.phaedo_fingerprint;
    if (isObj(cfg) && isObj(fp)) {
      if (typeof fp.fingerprint_id === 'string' && cfg.fingerprint_id !== fp.fingerprint_id)
        errs.push('phaedo_user_configuration.fingerprint_id does not match the vault fingerprint (§5.4 pairing)');
      if (typeof fp.subject_id === 'string' && cfg.subject_id !== fp.subject_id)
        errs.push('phaedo_user_configuration.subject_id does not match the vault fingerprint');
    }
  }
  return errs;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('validate-fingerprint.mjs')) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node spec/validate-fingerprint.mjs <fingerprint-config-or-vault.json> [more.json ...]');
    process.exit(2);
  }
  const schema = loadFingerprintSchema();
  let bad = 0, unreadable = 0;
  for (const f of files) {
    let doc;
    try { doc = JSON.parse(readFileSync(f, 'utf8')); }
    catch (e) { console.error(`✗ ${f}: not readable JSON — ${e.message}`); unreadable++; continue; }
    // Artifact detection: wrapped config → §5 validator; wrapped fingerprint/vault
    // → vault validator; a bare doc routes on its identity field (configuration_id
    // is unique to the §5 document).
    let errs, kind;
    if (isObj(doc) && 'phaedo_user_configuration' in doc) {
      errs = validateUserConfiguration(doc.phaedo_user_configuration); kind = 'user-configuration';
    } else if (isObj(doc) && 'phaedo_fingerprint' in doc) {
      errs = validateVaultData(doc, schema); kind = 'fingerprint';
    } else if (isObj(doc) && 'configuration_id' in doc) {
      errs = validateUserConfiguration(doc); kind = 'user-configuration';
    } else {
      errs = validateFingerprint(doc, schema); kind = 'fingerprint';
    }
    if (errs.length) {
      console.error(`✗ ${f}: ${errs.length} error(s)`);
      for (const e of errs) console.error(`    - ${e}`);
      bad++;
    } else {
      console.log(`✓ ${f}: conforms to the Phaedo ${kind} schema`);
    }
  }
  process.exit(unreadable ? 2 : bad ? 1 : 0);
}
