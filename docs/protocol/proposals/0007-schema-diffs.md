# Proposal 0007 — Concrete schema diffs (QUEUED, do not apply until folded)

Exact, ready-to-apply deltas for Proposal 0007 (rev. 3 — one authored home, authorization as a typed
variant of `standing_rules`). **Not** applied to the live `spec/schemas/*` yet — per the review gate,
schema files change only when the proposal is folded. Every change is **additive + optional**: no
`required` change on existing objects, no enum narrowing, no closed-enum addition. An old consumer stays
conformant and ignores the new keys (§4.5).

---

## 1. `spec/schemas/consultation-policy.schema.json` — expose `$defs`, deprecate the array

Refactor the inline matcher/effect into `$defs` so `standing_rules` can `$ref` one definition instead of
duplicating it. The existing `rules[].items` then references the same `$defs`. No shape change for
existing `consult_policies` documents.

```jsonc
// add a top-level $defs:
"$defs": {
  "match": {
    "type": "object",
    "description": "All present constraints must hold for the rule to apply.",
    "properties": {
      "domains": { "type": "array", "items": { "type": "string" }, "description": "Substring match (case-insensitive) on the action descriptor's domain." },
      "magnitude_min": { "enum": ["low", "medium", "high"] },
      "magnitude_max": { "enum": ["low", "medium", "high"] },
      "reversible": { "type": "boolean" },
      "amount_gt": { "type": "number", "description": "Numeric threshold; matches only when the action carries an `amount` strictly greater." }
    }
  },
  "effect": {
    "enum": ["escalate", "require_human", "decline", "autoproceed", "bias_cautious", "bias_bold"],
    "description": "Force effects (escalate/require_human→escalate, decline, autoproceed→proceed) are authored authorizations @ confidence 1.0 / deference high. bias_* are soft nudges."
  }
}
```

- Update `rules[].items.properties.match` → `{ "$ref": "#/$defs/match" }` and `...effect` → `{ "$ref": "#/$defs/effect" }`.
- Add to the schema `description`: *"DEPRECATED as a standalone array as of Proposal 0007 — authored
  authorizations are now `standing_rules` entries with `kind:"authorization"`. This schema is retained
  for the back-compat read path and the `$defs` shared by `standing_rules`; removed in v0.2 with the §5
  migration."*

---

## 2. `spec/schemas/fingerprint.schema.json` — the single authored home `standing_rules`

Add one optional property to `phaedo_fingerprint.properties` (alongside `layers`, `consult_policies`,
`extensions`). A tagged union on `kind`: `instruction` (verbatim rule) | `authorization` (matcher→effect
gate, sharing the §10.5 `$defs`).

```jsonc
// inside properties.phaedo_fingerprint.properties, after "consult_policies":
"standing_rules": {
  "type": "array",
  "description": "Subject-AUTHORED standing instructions (§5.2 shape), the single home for authored rules. Carried on the fingerprint as the v0.1 A-home (supersedes the standalone consult_policies array; migrates to the §5 User Configuration sibling in v0.2). Authored content: stated once, no producer confidence score, applied VERBATIM, never inferred. The extraction pipeline MUST NOT write this array (locked by an invariant test). `kind:\"instruction\"` is a verbatim rule (optionally bound to a Decision&Risk dimension via `decision`, which marks it authored-canonical in §4.7). `kind:\"authorization\"` is a deterministic gate carrying §10.5 match/effect, consumed by the consultation resolver; if it also carries `text` it injects too.",
  "items": {
    "type": "object",
    "required": ["kind"],
    "properties": {
      "instruction_id": { "type": "string", "description": "Stable id (UUID v4)." },
      "kind": { "enum": ["instruction", "authorization"], "description": "Variant discriminator (Proposal 0003 model)." },
      "text": { "type": "string", "maxLength": 1000, "description": "Verbatim rule (§5.2). UTF-8, NFC. Injected as-is — MUST NOT be summarized. Required for instruction; optional for authorization (present → the gate also injects)." },
      "exception": { "type": "string", "maxLength": 1000, "description": "OPTIONAL boundary, rendered '(Exception: …)'." },
      "scope": { "enum": ["global", "domain", "task"], "description": "§5.2 scope. v0.1: only `global` normative; use `decision.domain` / `match.domains` for v0.1 domain scoping." },
      "priority": { "type": "integer", "description": "§5.2 ordering hint; lower injects first. Ties broken by created_at." },
      "decision": {
        "type": "object",
        "description": "OPTIONAL (instruction). Binding to one Decision&Risk dimension; present → the projection/consultation treats it authored-canonical (§4.7).",
        "required": ["dimension"],
        "properties": {
          "dimension": { "type": "string", "description": "evidence_threshold | ambiguity_posture | options_vs_recommendation | speed_vs_quality | reversible_vs_irreversible (spec/layer-vocabulary.json)." },
          "polarity": { "enum": ["positive", "negative"], "description": "§4.3. A negative authored rule is canonical over a contradicting inferred positive." },
          "domain": { "type": "string", "description": "OPTIONAL domain scope, same substring namespace as action_descriptor.domain / match.domains." }
        }
      },
      "match": { "$ref": "consultation-policy.schema.json#/$defs/match", "description": "AUTHORIZATION only — §10.5 matcher. Optional (matchless = matches all)." },
      "effect": { "$ref": "consultation-policy.schema.json#/$defs/effect", "description": "AUTHORIZATION only — §10.5 effect. Required when kind=authorization." },
      "note": { "type": "string", "description": "AUTHORIZATION only — resolver rationale_hint source (back-compat with consult_policies.note)." },
      "created_at": { "type": "string", "description": "RFC 3339." },
      "updated_at": { "type": "string", "description": "RFC 3339." }
    },
    "allOf": [
      { "if": { "properties": { "kind": { "const": "instruction" } } },   "then": { "required": ["text"] } },
      { "if": { "properties": { "kind": { "const": "authorization" } } }, "then": { "required": ["effect"] } }
    ]
  }
}
```

> **§4.6 note.** `standing_rules.text` is authored prose, which is *correct* here — it is **not** a
> behavioral-layer signal value, so §4.6 ("structured signals only, no episodic content") does not apply.
> The episodic-content prohibition still binds `layer.signals[].value`, unchanged. This is exactly why
> authored rules must NOT live in `signals[]` (rev. 1, withdrawn).

---

## 3. `mcp/consult-policy.js` — one new policy source, resolver unchanged

`loadPolicies(vd, opts)` already concatenates sources. Add `standing_rules` (kind=authorization),
projected to the raw shape `normalizePolicies` consumes. `applyPolicies` / `matchAuthorization` are
untouched.

```js
// project authorization-kind standing_rules → the consult_policies raw rule shape
function authorizationsFromStandingRules(fp) {
  const rules = Array.isArray(fp?.standing_rules) ? fp.standing_rules : [];
  return rules
    .filter((r) => r && r.kind === 'authorization' && r.effect)
    .map((r) => ({ id: r.instruction_id || null, match: r.match || {}, effect: r.effect, note: r.note || r.text || null }));
}

// in loadPolicies(vd, opts), add as the FIRST (most-authoritative, current) source:
try { list = list.concat(normalizePolicies(authorizationsFromStandingRules(vd?.phaedo_fingerprint))); } catch { /* ignore */ }
// …then the existing deprecated consult_policies sources, unchanged.
```

---

## 4. Tests

- **`spec/test-schemas.mjs`** — validate a fingerprint carrying `standing_rules` of both kinds (instruction
  with/without `decision`; authorization with/without `text`); assert the existing sample (no
  `standing_rules`) still validates; assert the `kind`-conditional `required` (instruction⇒text,
  authorization⇒effect).
- **`scripts/test_standing_rules_invariant.mjs`** (new) — mirror `test_consult_policies_invariant.mjs`:
  producer never CREATES `standing_rules`; an authored `standing_rules` survives a reconcile pass
  byte-identical; an adversarial `layer:"standing_rules"` signal lands under `layers.*`, never the
  top-level authored array.
- **`mcp/test-consult-policy.mjs`** — add a case proving a `kind:"authorization"` `standing_rules` entry
  drives `matchAuthorization` identically to the equivalent `consult_policies` rule (parity), and that a
  `kind:"instruction"` entry is ignored by the resolver.
- **`spec/test-vectors/resolution.json`** — TC-RESOLVE cases: a bound `standing_rules.decision` yields the
  authored value even when `signals[]` holds contradicting observed candidates above `RESOLUTION_FLOOR`
  (authored overrides inferred); an *unbound* entry leaves `resolveDimension(signals)` untouched.

## 5. Non-changes (explicit, to bound the blast radius)

- `decision-risk-signal.schema.json` — **unchanged.** No `endorsed` evidence tier (rev. 1, withdrawn).
- `validate-fingerprint.mjs` `EV_TIER` / `resolveDimension` over `signals[]` — **unchanged**; the
  authored-canonical override is a projection-layer step on top, not a new signal tier.
- `extraction/fingerprint-update.js` `layer.confidence` mean — **unchanged**; authored rules never touch
  inferred layer confidence.
- `mcp/consult-core.js` `BASIS_WEIGHT` — **unchanged.**
- `consult_policies` read path / `applyPolicies` / `matchAuthorization` — **unchanged** (deprecated, still
  honored through the v0.2 migration).
- Wire `phaedo_protocol_version` — stays **`0.1`** (additive only).
