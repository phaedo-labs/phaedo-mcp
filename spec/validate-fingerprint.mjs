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
  // re-check above). Enforce kind enum, the instruction→text conditional, the text
  // maxLength, and the episodic-content rail — the summary guard's asymmetric sibling.
  const srItems = fpDef.properties.standing_rules && fpDef.properties.standing_rules.items;
  const kindEnum = srItems && srItems.properties && srItems.properties.kind && srItems.properties.kind.enum;
  const textMax = (srItems && srItems.properties && srItems.properties.text && srItems.properties.text.maxLength) || 1000;
  for (const [i, r] of (Array.isArray(fp.standing_rules) ? fp.standing_rules : []).entries()) {
    const at = `standing_rules[${i}]`;
    if (!isObj(r)) { errs.push(`${at} must be an object`); continue; }
    if (!('kind' in r)) errs.push(`${at} missing kind`);
    else if (kindEnum && !kindEnum.includes(r.kind)) errs.push(`${at}.kind not in enum`);
    if (r.kind === 'instruction' && typeof r.text !== 'string') errs.push(`${at} instruction requires text`);
    if (r.text !== undefined && typeof r.text !== 'string') errs.push(`${at}.text must be a string`);
    if (typeof r.text === 'string' && r.text.length > textMax) errs.push(`${at}.text exceeds maxLength ${textMax}`);
    if (typeof r.text === 'string' && EPISODIC_RE.test(r.text)) errs.push(`${at}.text carries episodic content (URL/email/domain) — not admitted in an injected rule (§4.6)`);
  }
  return errs;
}

// ── Conflict resolution (Proposal 0006, Route A) ───────────────────────────────
// The §4.7 resolver now lives in ../extraction/resolve.js (browser-safe + packaged
// with the extension's extraction engine, so the producer renders FROM it — one
// deterministic resolver, no divergence). Re-exported here so the spec test-vectors
// and mcp/health keep importing it from this module unchanged.
export { resolveDimension, resolveLayer, RESOLUTION_FLOOR } from '../extraction/resolve.js';

// Validate an Appendix-C runtime vault payload. An empty vault (no
// phaedo_fingerprint) is legitimate (nothing to render) → no errors.
export function validateVaultData(vd, schema = loadFingerprintSchema()) {
  if (!isObj(vd)) return ['vault data must be an object'];
  if (vd.phaedo_fingerprint == null) return [];
  return validateFingerprint(vd.phaedo_fingerprint, schema);
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('validate-fingerprint.mjs')) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node spec/validate-fingerprint.mjs <fingerprint-or-vault.json> [more.json ...]');
    process.exit(2);
  }
  const schema = loadFingerprintSchema();
  let bad = 0, unreadable = 0;
  for (const f of files) {
    let doc;
    try { doc = JSON.parse(readFileSync(f, 'utf8')); }
    catch (e) { console.error(`✗ ${f}: not readable JSON — ${e.message}`); unreadable++; continue; }
    const errs = (isObj(doc) && 'phaedo_fingerprint' in doc) ? validateVaultData(doc, schema) : validateFingerprint(doc, schema);
    if (errs.length) {
      console.error(`✗ ${f}: ${errs.length} error(s)`);
      for (const e of errs) console.error(`    - ${e}`);
      bad++;
    } else {
      console.log(`✓ ${f}: conforms to the Phaedo fingerprint schema`);
    }
  }
  process.exit(unreadable ? 2 : bad ? 1 : 0);
}
