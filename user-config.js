// Phaedo §5 User Configuration — the authored sibling artifact (config home migration, part 1).
//
// v0.1 carries authored rules on the fingerprint as `phaedo_fingerprint.standing_rules`
// (the pragmatic A-home, Proposal 0007). The §5 destination is a SIBLING artifact —
// authored content with its own document identity, paired to the fingerprint via
// `fingerprint_id` (§5.4), riding the same envelope with artifact_kind
// 'user_configuration' and a distinct key-derivation context (§5.5).
//
// This module is the migration seam between the two homes:
//
//   deriveUserConfiguration(fp, opts)  A-home → §5 document. Pure; copies
//                                      standing_rules VERBATIM (authored content is
//                                      never summarized or normalized). Pass the
//                                      prior config to keep configuration_id /
//                                      created_at / example_corpus stable — the
//                                      fingerprint has no corpus, so the corpus
//                                      only ever comes from the prior document.
//   foldStandingInstructions(fp, cfg)  §5 → A-home back-compat mirror: returns a
//                                      fingerprint whose standing_rules reflect the
//                                      config's standing_instructions, for readers
//                                      that still consume the A-home (injection,
//                                      resolver, sync). Empty → key omitted (house
//                                      convention, matches sync-merge.js).
//
// Dual-home rule while the migration is in flight: the §5 document is CANONICAL
// when present; the A-home is the transported/injected form until the storage and
// sync increments land. derive(fold(fp, cfg)) round-trips the instructions
// byte-identically (locked by scripts/test_user_config.mjs).
//
// Authored-only is preserved structurally: derive reads ONLY standing_rules (never
// suggested_rules — a proposal queue is not authored content), and nothing in this
// module gives extraction a write path into either home.
//
// Pure + dependency-free. Loaded as a classic script (exposes
// globalThis.PhaedoUserConfig) and required by scripts/test_user_config.mjs.

(function () {
  'use strict';

  // §5.1 schema_revision for documents this module derives.
  const CONFIG_SCHEMA_REVISION = 1;

  // Matches migration.js stampProtocolFields — the version stamped on derived docs.
  const PHAEDO_PROTOCOL_VERSION = '0.1';

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    // Non-crypto fallback mirrors migration.js — ids are opaque, not secrets.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  const isObj = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
  const deepCopy = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

  // Stable serialization (sorted keys) so a pure reordering doesn't read as a change.
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    }
    return JSON.stringify(v);
  }

  // Change signature over the authored payload of a config document. Timestamps and
  // document identity are excluded — two documents with the same rules and corpus
  // are the same authored content.
  function configContentSig(cfg) {
    if (!isObj(cfg)) return stable(null);
    return stable({
      standing_instructions: cfg.standing_instructions || [],
      example_corpus: cfg.example_corpus || [],
    });
  }

  /**
   * Derive the §5 User Configuration document from a fingerprint carrying the
   * v0.1 A-home `standing_rules`.
   *
   * @param fp    fingerprint document (the inner phaedo_fingerprint object). Must
   *              carry subject_id + fingerprint_id (§5.4 pairing is mandatory).
   * @param opts  { now?, prior?, configurationId? }
   *              now — RFC 3339 timestamp to stamp (injectable for determinism).
   *              prior — the existing config document, if any: preserves
   *              configuration_id, created_at, and example_corpus; updated_at is
   *              re-stamped only when the authored content actually changed.
   *              configurationId — explicit id for a fresh document (else minted).
   * @returns the §5.1 document (a new object; fp is never mutated).
   */
  function deriveUserConfiguration(fp, opts = {}) {
    if (!isObj(fp)) throw new Error('deriveUserConfiguration: fingerprint must be an object');
    if (typeof fp.subject_id !== 'string' || !fp.subject_id) {
      throw new Error('deriveUserConfiguration: fingerprint.subject_id is required (run migration.js stampProtocolFields first)');
    }
    if (typeof fp.fingerprint_id !== 'string' || !fp.fingerprint_id) {
      throw new Error('deriveUserConfiguration: fingerprint.fingerprint_id is required — a §5 configuration must pair to a fingerprint (§5.4)');
    }
    const now = opts.now || new Date().toISOString();
    const prior = isObj(opts.prior) ? opts.prior : null;

    const cfg = {
      phaedo_protocol_version: PHAEDO_PROTOCOL_VERSION,
      configuration_id: (prior && prior.configuration_id) || opts.configurationId || uuid(),
      subject_id: fp.subject_id,
      fingerprint_id: fp.fingerprint_id,
      created_at: (prior && prior.created_at) || now,
      updated_at: now,
      schema_revision: CONFIG_SCHEMA_REVISION,
      standing_instructions: deepCopy(Array.isArray(fp.standing_rules) ? fp.standing_rules : []),
      example_corpus: deepCopy((prior && Array.isArray(prior.example_corpus)) ? prior.example_corpus : []),
    };
    // Same authored content as the prior document → keep its updated_at, so a
    // no-op re-derive is not an artifact change (sync/persist can skip it).
    if (prior && configContentSig(prior) === configContentSig(cfg) && typeof prior.updated_at === 'string') {
      cfg.updated_at = prior.updated_at;
    }
    return cfg;
  }

  /**
   * §5.2 scope activation (v0.2 / OQ5) — the DETERMINISTIC consumer contract.
   *
   * Decides whether a standing instruction is active for a given session
   * context. Fail-closed: a scoped rule with no matching (or no known) context
   * is INACTIVE — a consumer that cannot establish the session's domain/task
   * must not apply a scoped rule globally. (Model-mediated injection consumers
   * with no context take the other §5.2 branch: render the rule with an
   * explicit conditional scope prefix instead — see context-block.js
   * renderOperatingRules, whose inline scopeActive mirrors this function;
   * parity is locked by scripts/test_user_config.mjs.)
   *
   * Matching mirrors the §10.5 resolver (mcp/consult-policy.js): the session's
   * domain string CONTAINS one of the rule's scope_domains, case-insensitive;
   * task_hint likewise CONTAINS one of scope_tasks.
   *
   * @param rule            a standing-instruction entry
   * @param sessionContext  { domain?, task_hint? } (§9.2) or null/undefined
   */
  function instructionActiveFor(rule, sessionContext) {
    if (!isObj(rule)) return false;
    const scope = rule.scope;
    if (scope !== 'domain' && scope !== 'task') return true;   // global / absent / unknown-scope → always active
    const ctx = isObj(sessionContext) ? sessionContext : {};
    if (scope === 'domain') {
      const d = typeof ctx.domain === 'string' ? ctx.domain.toLowerCase() : '';
      if (!d) return false;
      return (Array.isArray(rule.scope_domains) ? rule.scope_domains : [])
        .some((k) => typeof k === 'string' && k && d.includes(k.toLowerCase()));
    }
    const hint = typeof ctx.task_hint === 'string' ? ctx.task_hint.toLowerCase() : '';
    if (!hint) return false;
    return (Array.isArray(rule.scope_tasks) ? rule.scope_tasks : [])
      .some((k) => typeof k === 'string' && k && hint.includes(k.toLowerCase()));
  }

  /**
   * Fold a §5 config document back onto the fingerprint A-home — the back-compat
   * mirror for readers that still consume `standing_rules` (injection, resolver,
   * sync). The config is canonical: its standing_instructions REPLACE the
   * fingerprint's standing_rules. Empty instructions → the key is omitted
   * (house convention). fp is never mutated.
   */
  function foldStandingInstructions(fp, cfg) {
    if (!isObj(fp)) throw new Error('foldStandingInstructions: fingerprint must be an object');
    if (!isObj(cfg)) throw new Error('foldStandingInstructions: config must be an object');
    const instructions = Array.isArray(cfg.standing_instructions) ? cfg.standing_instructions : [];
    const out = { ...fp };
    if (instructions.length) out.standing_rules = deepCopy(instructions);
    else delete out.standing_rules;
    return out;
  }

  /**
   * §5 vault maintenance (config home migration, part 2) — the dual-home
   * invariant, as a pure vault-payload transform. Applied by the extension SW
   * on EVERY vault write (vault-crypto.js write finalizer), so whenever the
   * A-home `standing_rules` change through any writer (popup mutate, sync
   * merge, conflict review, extraction persist — none of which need to know),
   * the §5 sibling `phaedo_user_configuration` is re-derived in the same
   * atomic write and the two homes stay in lockstep.
   *
   * Policy (each rule keeps a failure mode out):
   *   - no fingerprint                 → untouched (nothing to pair to)
   *   - fingerprint missing identity   → untouched (§5.4 needs subject_id +
   *     fingerprint_id; migration.js stamps them on the read path first)
   *   - no prior config AND no rules   → untouched (never mint an empty
   *     document just because a write happened)
   *   - unchanged authored content     → the SAME vd object back (no churn:
   *     an extraction-only write must not restamp the config)
   *
   * Never throws into the write path — callers wrap defensively, but the
   * transform itself is total on plain data.
   */
  function maintainUserConfiguration(vd, opts = {}) {
    if (!isObj(vd)) return vd;
    const fp = vd.phaedo_fingerprint;
    if (!isObj(fp)) return vd;
    if (typeof fp.subject_id !== 'string' || !fp.subject_id ||
        typeof fp.fingerprint_id !== 'string' || !fp.fingerprint_id) return vd;
    const prior = isObj(vd.phaedo_user_configuration) ? vd.phaedo_user_configuration : null;
    const rules = Array.isArray(fp.standing_rules) ? fp.standing_rules : [];
    if (!prior && !rules.length) return vd;
    const cfg = deriveUserConfiguration(fp, { now: opts.now, prior });
    if (prior
        && configContentSig(prior) === configContentSig(cfg)
        && prior.updated_at === cfg.updated_at
        && prior.subject_id === cfg.subject_id
        && prior.fingerprint_id === cfg.fingerprint_id) return vd;
    return { ...vd, phaedo_user_configuration: cfg };
  }

  const api = { deriveUserConfiguration, foldStandingInstructions, instructionActiveFor, maintainUserConfiguration, configContentSig, CONFIG_SCHEMA_REVISION };
  if (typeof globalThis !== 'undefined') globalThis.PhaedoUserConfig = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
