// Anamnesis ↔ AP2 profile — standing authorizations as Intent Mandates.
//
// WHY THIS EXISTS. The standing risk to Anamnesis is not that a rival builds a
// better decision oracle; it is the standards cold-start. One implementer is a
// format, not a standard, and evangelism has not moved that number. Binding to a
// standard that ALREADY has implementers does: every AP2 participant becomes a
// partial Anamnesis consumer without adopting Anamnesis.
//
// AP2 (Google → FIDO Alliance, May 2026; Mastercard's Verifiable Intent
// co-contributed; the FIDO Payments TWG is chaired by Mastercard and Visa) defines
// an INTENT MANDATE: a verifiable credential, signed by the user with a
// hardware-backed device key, TTL'd, carrying structured constraints and the
// agent's stated understanding of the request ("prompt playback"), plus an
// intentionally open-ended risk payload.
//
// Read that against §10.5. An Intent Mandate is a standing authorization
// (`match` + `amount_gt` + `expires_at`) rendered as a credential the card networks
// already accept — and Phaedo's escalate-to-phone flow is architecturally the signing
// ceremony, once §8.3 gives the phone a signing key. The two designs arrived
// at the same primitive from opposite ends. "Prompt playback" is the payments
// industry independently discovering §10.2 `action_binding`.
//
// WHAT THIS MODULE DOES, AND DOES NOT. It is a PURE SERIALIZER: it renders the
// subject's authorizations into the Intent Mandate payload shape, and renders a
// consultation signal into a risk-payload entry. It does NOT sign — and today
// NOTHING does: §8.3 asymmetric signing is unbuilt, so no subject signing key
// exists anywhere in the product yet. That is the honest current state; the
// intended design is that the key is generated non-extractably on the phone and
// the ceremony that turns this payload into a credential is the phone's, not the
// server's. Deliberately unreachable from here either way. Scope + the P-256 vs
// Ed25519 decision: docs/roadmap/asymmetric-signing-scope-2026-07-23.md.
//
// The mapping is lossy in ONE direction on purpose. Anamnesis carries dispositions
// and inferred signals that have no place in a payment credential, so only the
// deterministic, subject-authored half crosses: authorizations, their bounds, and
// their expiry. Nothing inferred, no layer content, no persona. That is the §10.4
// boundary applied to a new transport, and it is also why this is safe to hand to a
// merchant's stack.
//
// PURE: no I/O, no crypto, no network.

import { signingInput } from './signing.js';

const MAG_RANK = { low: 0, medium: 1, high: 2 };

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// AP2 expresses shopping constraints as structured fields, not prose. §10.5 `match`
// is already structured, so the translation is mechanical — the only real decision is
// which constraints have a faithful counterpart and which must be dropped rather than
// approximated. `magnitude` has none (it is a behavioral notion, not a commerce one),
// so it is carried as an advisory annotation, never as a spend limit.
function matchToConstraints(match) {
  const m = isObj(match) ? match : {};
  const out = {};
  const domains = Array.isArray(m.domains) ? m.domains.map((d) => String(d)).filter(Boolean) : [];
  if (domains.length) out.categories = domains;
  // AP2's `max_amount` is a spend cap, so only a genuine CEILING may fill it.
  // `amount_lt` is that ceiling. `amount_gt` is a FLOOR — "fires above N" — and on an
  // autoproceed rule it means "auto-proceed only the LARGE ones", the opposite of a
  // cap. Mapping it to `max_amount` (as this did before `amount_lt` existed) would
  // have told a merchant the subject capped spending at exactly the figure above
  // which they wanted extra scrutiny. It is carried as an annotation instead.
  // Both ceiling forms map to `max_amount`, and when both are present the LOWER wins — AP2 has
  // one field and no way to say "exclusive", so the credential must not assert more headroom than
  // the rule grants. `amount_lte: 20` becomes `max_amount: 20`; `amount_lt: 20` also becomes 20,
  // which is the pre-existing (slightly generous by one cent) mapping, unchanged.
  const ceilings = [m.amount_lt, m.amount_lte].filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (ceilings.length) {
    out.max_amount = Math.min(...ceilings);
  }
  if (typeof m.amount_gt === 'number' && Number.isFinite(m.amount_gt)) {
    out.annotations = { ...(out.annotations || {}), anamnesis_amount_floor: m.amount_gt };
  }
  if (typeof m.reversible === 'boolean') out.refundable_only = m.reversible;
  if (m.magnitude_max && MAG_RANK[m.magnitude_max] !== undefined) {
    out.annotations = { ...(out.annotations || {}), anamnesis_magnitude_max: m.magnitude_max };
  }
  return out;
}

// One §10.5 authorization → the Intent Mandate constraint block it corresponds to,
// or null when it has no faithful translation.
//
// Only AUTOPROCEED authorizations become mandates. That is the whole semantic match:
// an Intent Mandate is a grant of authority to act without the human present, and
// `autoproceed` is the only Anamnesis effect that grants anything. An `escalate` or
// `decline` rule is the ABSENCE of a mandate — the correct AP2 rendering of "ask me
// first" is not a restrictive credential, it is no credential at all, and emitting
// one would invert its meaning to a merchant.
export function authorizationToIntentConstraints(rule, { now = Date.now() } = {}) {
  if (!isObj(rule)) return null;
  if (rule.kind !== undefined && rule.kind !== 'authorization') return null;
  if (rule.effect !== 'autoproceed') return null;
  // A lapsed authorization must not be exported as live authority.
  const exp = Date.parse(rule.expires_at);
  if (Number.isFinite(exp) && exp <= now) return null;
  // Nor must a CLIENT-SCOPED one (§10.5 `agents`). AP2 has no vocabulary for "this
  // specific paired client", so a scoped grant cannot be expressed in a mandate — and
  // emitting it unscoped would tell a merchant the subject granted unconditionally
  // what they in fact granted to exactly one client. That is the same inversion this
  // function already refuses for restrictive rules, and it crosses to a third party,
  // where it is least correctable. A scope that cannot be carried must instead
  // withhold the credential: the correct AP2 rendering of a grant this format cannot
  // express is no grant at all. (An ABSENT `agents` is unscoped and exports normally;
  // an empty array is a scope naming nobody, so it withholds too.)
  if (Array.isArray(rule.agents)) return null;
  return {
    source_rule_id: rule.instruction_id || rule.id || null,
    constraints: matchToConstraints(rule.match),
    // §10.5 require_binding maps onto AP2's own posture that a mandate authorizes a
    // BOUNDED transaction, not open-ended spending. Carried through so a verifier can
    // see the subject demanded the agent commit to a concrete action.
    requires_action_binding: rule.require_binding === true,
    expires_at: Number.isFinite(exp) ? new Date(exp).toISOString() : null,
  };
}

// The unsigned Intent Mandate payload for a subject's live authorizations.
//
// Returns null when the subject has granted nothing — which is the common case and
// the right answer: no authority, no mandate. Callers MUST NOT synthesize an empty
// mandate, because an empty credential reads to a merchant as "authorized with no
// constraints", the exact inversion this module exists to avoid.
export function buildIntentMandatePayload(fp, opts = {}) {
  const {
    now = Date.now(),
    agentId = null,
    promptPlayback = null,          // the agent's stated understanding (AP2 "prompt playback")
    consultSignal = null,           // §10.3 signal, if a consultation preceded this
  } = opts;

  // A standing authorization lives in EITHER home (spec §10.5: "a `consult_policies` rule
  // or `standing_rules` authorization"), so an Intent Mandate — the subject's live
  // authorizations — must read both. Reading only `standing_rules` silently dropped every
  // autoproceed guardrail authored through the extension's Decision-guardrails form (which
  // writes `consult_policies`), so a subject with real grants got an empty mandate. The
  // per-rule guards are unchanged and live in authorizationToIntentConstraints: autoproceed
  // only, not lapsed, and never a client-scoped grant (AP2 can't express `agents`).
  const standingRules = Array.isArray(fp?.standing_rules) ? fp.standing_rules : [];
  const policyRules   = Array.isArray(fp?.consult_policies?.rules) ? fp.consult_policies.rules : [];
  // §10.5 tombstones — a REVOKED authorization must never become a mandate grant. This is
  // the highest-stakes read of the two homes: a grant here is what a payment credential is
  // minted against, so a rule the subject revoked that survived in a stale or restored copy
  // would sign away authority they took back. Same consumer MUST as normalizePolicies.
  const revoked = new Set(
    (Array.isArray(fp?.consult_policies?.revoked) ? fp.consult_policies.revoked : [])
      .map((t) => (t && typeof t === 'object' && t.id != null ? String(t.id) : null))
      .filter(Boolean)
  );
  const grants = [];
  const seen = new Set();   // dedupe by source rule id — the same authorization must not
  for (const r of [...standingRules, ...policyRules]) {           // become two mandate grants
    if (r && typeof r === 'object') {
      const rid = r.id != null ? String(r.id) : (r.instruction_id != null ? String(r.instruction_id) : null);
      if (rid && revoked.has(rid)) continue;
    }
    const g = authorizationToIntentConstraints(r, { now });
    if (!g) continue;
    if (g.source_rule_id && seen.has(g.source_rule_id)) continue;
    if (g.source_rule_id) seen.add(g.source_rule_id);
    grants.push(g);
  }
  if (!grants.length) return null;

  // The mandate expires with the FIRST grant to lapse — an aggregate credential must
  // not outlive the narrowest authority inside it.
  const expiries = grants.map((g) => Date.parse(g.expires_at)).filter(Number.isFinite);
  const expiresAt = expiries.length ? new Date(Math.min(...expiries)).toISOString() : null;

  return {
    mandate_type: 'intent',
    // Version the profile, not the payment protocol: AP2 moves on its own cadence and
    // a verifier needs to know which mapping produced this.
    anamnesis_profile: '0.1',
    issued_at: new Date(now).toISOString(),
    expires_at: expiresAt,
    ...(agentId ? { agent_id: String(agentId) } : {}),
    ...(promptPlayback ? { prompt_playback: String(promptPlayback).slice(0, 500) } : {}),
    grants,
    // AP2 leaves the risk payload open-ended for exactly this kind of signal. It is
    // the ONE place a behavioral system has something to say to a payments network,
    // and it says it in the §10.4 currency: a constrained signal, never persona.
    risk_payload: buildRiskPayload({ consultSignal }),
    // Unsigned by construction. The server CANNOT sign: per §8.3 the subject's key is
    // non-extractable in the phone's Secure Enclave, so signing is a ceremony that belongs
    // to the device holding the key. `intentMandateSigningInput()` below computes the exact
    // bytes the phone would be asked to sign. Until a signature comes back, this object is
    // a proposal, never a credential.
    signature: null,
  };
}

/**
 * The exact bytes a §8.3 signature over an Intent Mandate covers: the §6 RFC 8785 canonical
 * form of the payload with `signature` omitted. This is the seam between the server (which
 * builds the mandate) and the phone (which holds the only key that can sign it) — both sides
 * must agree on these bytes or the resulting signature verifies nowhere.
 *
 * Omitting `signature` is what keeps the input stable once the signature is attached, so a
 * verifier recomputes the same bytes from the finished credential.
 */
export function intentMandateSigningInput(payload) {
  return signingInput(payload, { field: 'signature' });
}

// §10.3 signal → AP2 risk-payload entry. Deliberately minimal: a merchant learns
// that the subject's own oracle was consulted and what it said — which is exactly the
// claim that makes a mandate more trustworthy — and learns nothing about the subject.
export function buildRiskPayload({ consultSignal = null } = {}) {
  const payload = { anamnesis_consulted: !!consultSignal };
  if (consultSignal) payload.anamnesis_signal = String(consultSignal);
  return payload;
}
