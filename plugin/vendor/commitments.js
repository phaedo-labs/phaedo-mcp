// §5.7 Commitments — decision STATE, projected into the §10.5 policy engine.
//
// The eight fingerprint layers are dispositional. Read the catalog: they model
// response length, tone, iteration style, ambiguity posture, evidence threshold —
// how a person decides. Even `temporal_and_context` is traits (early-project mode,
// urgency baseline, working mode), not situation. And §4.6 forbids episodic content
// in behavioral layers on purpose, so a behavioral model never quietly becomes a
// dossier.
//
// That leaves a hole an agent acting on someone's behalf falls straight into. The
// oracle can say "you would be cautious about this" when the true answer is "you
// already decided this" — you already told that vendor no, you are on leave until
// the 4th, that budget is frozen, you are mid-negotiation with those people. Style
// without state is how a proxy contradicts the person it represents.
//
// Commitments fill exactly that hole and nothing more. They are NOT memory: no
// recall, no retrieval, no conversation history. They are a short, authored,
// always-expiring list of things that should change a DECISION, consumed only at
// the consultation boundary.
//
// Three properties keep this from becoming a second product:
//
//   1. Authored only (§5.6). A producer MUST NOT infer a commitment. `source` is an
//      enum of exactly `subject` so an inferred value is a schema violation.
//   2. Deferential only. `effect` cannot be `autoproceed`. Being bound by something
//      is never a reason to hand an agent more latitude; autonomy expansion has one
//      path (§10.5 authorization via §10.7) and this is not it.
//   3. Perishable. `expires_at` is REQUIRED. Decision state that outlives its
//      situation silently blocks work forever, which is worse than not recording it.
//
// And they are never injected. The §9 projection is untouched — a commitment's text
// is episodic by nature (it names counterparties and amounts), so it goes to the
// consultation boundary, not into a context block that reaches a model verbatim.
// Even there the statement is withheld unless the subject marked it `disclose`.
//
// This module is the projection into the §10.5 rule shape the resolver already
// understands, which is what makes the whole feature small: precedence, expiry
// enforcement, domain matching and the deterministic pre-flight all work unchanged.
//
// Loaded as a CLASSIC script in popup.html (globalThis.PhaedoCommitments) and
// required by node tests + the MCP resolver — the dual pattern of sync-merge.js /
// rule-review.js.

(function () {
  'use strict';

  var EFFECTS = ['escalate', 'decline', 'bias_cautious'];
  var KINDS = ['commitment', 'constraint'];

  function uuid() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'cm-' + Math.random().toString(36).slice(2, 10);
  }

  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }

  // Live entries only. A lapsed commitment is inert — same fail-safe direction as a
  // lapsed §10.5 authorization: authority narrows, never widens, when time passes.
  function activeCommitments(fp, now) {
    now = (now == null) ? Date.now() : now;
    var list = (fp && Array.isArray(fp.commitments)) ? fp.commitments : [];
    return list.filter(function (c) {
      if (!isObj(c) || !c.statement || EFFECTS.indexOf(c.effect) === -1) return false;
      var t = Date.parse(c.expires_at);
      return Number.isFinite(t) && t > now;      // no expiry ⇒ NaN ⇒ inert (expires_at is required)
    });
  }

  // The generic hint used when a commitment must not be disclosed. It tells the agent
  // the truth — a standing decision covers this — without telling it WHAT the subject
  // decided or with whom. That distinction is the point: an arbitrary agent learning
  // "already told ACME no" is a disclosure, not a rationale.
  var OPAQUE_NOTE = 'a standing commitment of yours covers this';

  // Commitments → §10.5 policy rules. `disclose:false` (the default) substitutes the
  // opaque note, so the resolver's existing "Per your standing rule: …" phrasing never
  // leaks episodic text to a calling agent.
  function commitmentsAsPolicies(fp, opts) {
    opts = opts || {};
    var now = (opts.now == null) ? Date.now() : opts.now;
    return activeCommitments(fp, now).map(function (c) {
      return {
        id: c.commitment_id || null,
        match: { domains: Array.isArray(c.domains) ? c.domains.filter(Boolean) : [] },
        effect: c.effect,
        note: c.disclose === true ? String(c.statement) : OPAQUE_NOTE,
        expires_at: c.expires_at,
        // Marks the rule as decision STATE rather than a standing policy. The resolver
        // uses it for one thing: a `bias_cautious` commitment still says WHY it nudged.
        // The generic "nudged per your preference" is fine for a disposition, but for a
        // commitment it hides the only useful fact — that something the subject is
        // currently bound by is in play.
        rule_kind: 'commitment',
      };
    });
  }

  // Author a commitment (the subject's write — §5.6). Returns a NEW fingerprint, or
  // the input unchanged when the entry would be invalid. Deliberately strict rather
  // than coercing: a commitment that silently loses its expiry or its effect is a
  // guardrail that quietly does nothing.
  function addCommitment(fp, input, opts) {
    opts = opts || {};
    input = input || {};
    var statement = String(input.statement == null ? '' : input.statement).trim();
    if (!statement) return fp;
    if (EFFECTS.indexOf(input.effect) === -1) return fp;
    var t = Date.parse(input.expires_at);
    if (!Number.isFinite(t)) return fp;
    var now = opts.now || new Date().toISOString();
    var entry = {
      commitment_id: uuid(),
      kind: KINDS.indexOf(input.kind) === -1 ? 'commitment' : input.kind,
      statement: statement.slice(0, 500),
      domains: Array.isArray(input.domains)
        ? input.domains.map(function (d) { return String(d).trim(); }).filter(Boolean)
        : [],
      effect: input.effect,
      disclose: input.disclose === true,
      expires_at: new Date(t).toISOString(),
      source: 'subject',
      created_at: now,
      updated_at: now,
    };
    var list = (fp && Array.isArray(fp.commitments)) ? fp.commitments : [];
    var next = {};
    for (var k in fp) if (Object.prototype.hasOwnProperty.call(fp, k)) next[k] = fp[k];
    next.commitments = list.concat([entry]);
    // Same signal authored rules use, so the §0008 sync merge keeps this device's write.
    next.rules_updated_at = now;
    return next;
  }

  // Remove one (the subject changed their mind, or it is done). Lapsed entries are
  // ALSO dropped here — pruning on any write keeps the list from accumulating dead
  // state without needing a background job.
  function removeCommitment(fp, commitmentId, opts) {
    opts = opts || {};
    var now = opts.now || new Date().toISOString();
    var list = (fp && Array.isArray(fp.commitments)) ? fp.commitments : [];
    if (!list.length) return fp;
    var nowMs = Date.parse(now);
    var kept = list.filter(function (c) {
      if (!isObj(c)) return false;
      if (c.commitment_id === commitmentId) return false;
      var t = Date.parse(c.expires_at);
      return !(Number.isFinite(t) && Number.isFinite(nowMs) && t <= nowMs);
    });
    if (kept.length === list.length) return fp;
    var next = {};
    for (var k in fp) if (Object.prototype.hasOwnProperty.call(fp, k)) next[k] = fp[k];
    next.commitments = kept;
    next.rules_updated_at = now;
    return next;
  }

  var api = {
    EFFECTS: EFFECTS,
    KINDS: KINDS,
    OPAQUE_NOTE: OPAQUE_NOTE,
    activeCommitments: activeCommitments,
    commitmentsAsPolicies: commitmentsAsPolicies,
    addCommitment: addCommitment,
    removeCommitment: removeCommitment,
  };
  if (typeof globalThis !== 'undefined') globalThis.PhaedoCommitments = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
