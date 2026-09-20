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
  // §5.3: "soft cap 20 examples (SHOULD, not enforced)". Defined HERE because two writers now
  // need it — the authoring form and orphan adoption — and a cap that disagrees with itself
  // between them would silently drop authored examples on one path and not the other.
  const EXAMPLE_SOFT_CAP = 20;

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
      // TOMBSTONES ARE CONTENT. Omitting them made a revocation invisible to every caller that
      // asks "did this document change?" — so minting a tombstone with no other edit compared
      // equal to the document before it, the write was skipped as a no-op, and the deletion was
      // never persisted or synced. A deletion is a change; the signature has to say so.
      revoked_instructions: cfg.revoked_instructions || [],
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
  /** The step-3 cutover switch, owned by authored-source.js. Defaults to the A-home if that
   *  module has not loaded — the conservative direction, since it preserves today's behaviour. */
  function authoredHome() {
    const AS = (typeof globalThis !== 'undefined' && globalThis.PhaedoAuthoredSource) || null;
    // NO SILENT FALLBACK. Defaulting to 'fingerprint' post-cutover would make a routine re-derive
    // copy the stale A-home mirror over the subject's authored rules and erase them — silently,
    // because a re-derive looks like any other write. Refuse to guess.
    if (!AS || !AS.AUTHORED_HOME) {
      throw new Error('user-config: authored-source.js must load first — it owns AUTHORED_HOME');
    }
    // The EFFECTIVE home, not the armed constant: the upgrade gate can hold the cutover back
    // when a reader is behind, and every consumer must see the same answer or one of them mints
    // an empty §5 while another still writes the A-home. See authored-source.js.
    return typeof AS.effectiveAuthoredHome === 'function' ? AS.effectiveAuthoredHome() : AS.AUTHORED_HOME;
  }

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
      // POST-CUTOVER this must NOT copy the A-home. Once §5 is the authored home, a routine
      // fingerprint write (an extraction, a layer edit, a sync) would re-derive over the
      // subject's authored rules with a stale mirror and erase them — silently, because a
      // re-derive looks like any other write. So standing_instructions joins example_corpus as
      // content carried FORWARD from the prior document rather than rebuilt from the fingerprint.
      standing_instructions: authoredHome() === 'config'
        ? deepCopy((prior && Array.isArray(prior.standing_instructions)) ? prior.standing_instructions : [])
        : deepCopy(Array.isArray(fp.standing_rules) ? fp.standing_rules : []),
      example_corpus: deepCopy((prior && Array.isArray(prior.example_corpus)) ? prior.example_corpus : []),
      // §5.2 TOMBSTONES ARE CARRIED FORWARD IN BOTH HOMES, never rebuilt. A tombstone is the only
      // record that the subject DELETED something, and nothing else in the vault can reconstruct
      // it — the fingerprint holds what exists, never what was removed.
      //
      // Dropping it here was silent and it undid revocations: PRE-CUTOVER `standing_instructions`
      // is rebuilt from the A-home mirror, and the mirror takes a deleted rule back from any peer
      // that still holds it (the A-home has no revocation concept). The tombstone is what the read
      // path filters that zombie out with — so re-deriving without it handed the rule straight
      // back into force. Measured 2026-08-12: dropped pre-cutover, preserved post-cutover, which
      // is why this only bit once the upgrade gate closed.
      revoked_instructions: deepCopy((prior && Array.isArray(prior.revoked_instructions)) ? prior.revoked_instructions : []),
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
    // §5.4 — a configuration that does not name THIS fingerprint is not this subject's, and must
    // not govern what the agent is told. Reachable in ordinary use: replace the fingerprint (a
    // §8.2 restore, or a merge from another device) while an older configuration is still in the
    // vault, and its fingerprint_id now names something that is gone. Folding it anyway would
    // apply one identity's authored rules on top of another's, silently — the rendered context
    // block looks perfectly well-formed either way.
    //
    // Falls back to the A-home rather than throwing: this runs on the injection path, and a hard
    // failure there costs the subject their whole context block over a recoverable mismatch.
    if (!configGoverns(cfg, fp)) return { ...fp };
    const instructions = Array.isArray(cfg.standing_instructions) ? cfg.standing_instructions : [];
    const out = { ...fp };
    if (instructions.length) out.standing_rules = deepCopy(instructions);
    else delete out.standing_rules;
    return out;
  }

  /** §5.4 pairing. Mirrors authored-source.js configGoverns; pinned by test_authored_source.mjs. */
  function configGoverns(cfg, fp) {
    if (!isObj(cfg) || !isObj(fp)) return false;
    if (typeof fp.fingerprint_id !== 'string' || !fp.fingerprint_id) return false;
    if (cfg.fingerprint_id !== fp.fingerprint_id) return false;
    if (typeof fp.subject_id === 'string' && fp.subject_id &&
        typeof cfg.subject_id === 'string' && cfg.subject_id &&
        cfg.subject_id !== fp.subject_id) return false;
    return true;
  }

  /**
   * Should a §5 document be minted where none exists — or where the one present does not govern?
   *
   * This question has a DIFFERENT answer either side of the cutover, and asking the pre-cutover
   * version post-cutover is destructive rather than merely wrong.
   *
   * PRE-CUTOVER the derive copies the A-home, so A-home rules are exactly what there is to mint
   * FROM: rules present → mint; nothing → an empty document is pure churn.
   *
   * POST-CUTOVER the derive no longer reads the A-home (the inversion), so A-home rules are no
   * longer a reason to mint — and minting on them ERASES them from every reader. The document
   * comes out EMPTY, because there is no prior to carry forward and the fingerprint is no longer
   * consulted; and an empty §5 is AUTHORITATIVE ON READ by design — it means "the subject has no
   * rules" (authored-source.js: ABSENT and EMPTY are different). So a fingerprint that ARRIVES
   * carrying rules gets them masked by an empty sibling minted in the very same write.
   *
   * That is not a corner: it is a §8.2 restore of a fingerprint-only backup (any build before 29),
   * a sync drain from a device still on the A-home, or a re-pair after a reinstall. And it fails
   * in the dangerous direction — missing grants fail safe, missing PROHIBITIONS do not. With no
   * `escalate` / `decline` rule present the inferred signal governs (§10.5), and that can be
   * "proceed".
   *
   * So post-cutover: mint nothing. The surface keeps reading the A-home (source=fingerprint,
   * reason=no_config) and honestly reports that it is not yet config-home native — which is
   * precisely what the upgrade gate exists to notice. The document then gets created by something
   * that carries actual content: the write chokepoint mints its own, seeded with the rules the
   * resolver just showed the subject, or a configuration drains in from a peer that has one.
   */
  function shouldMint(fp) {
    if (authoredHome() === 'config') return false;
    return Array.isArray(fp.standing_rules) && fp.standing_rules.length > 0;
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
   *   - prior does not govern (§5.4)   → treated as ABSENT, never carried
   *     forward (see the gate below — carrying it forward LAUNDERS it)
   *   - nothing to mint from           → untouched (shouldMint, below: never
   *     mint a document just because a write happened)
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

    // §5.4 BEFORE anything else. A stored configuration that does not name THIS fingerprint is
    // not this subject's, and carrying it forward LAUNDERS it: deriveUserConfiguration re-stamps
    // subject_id / fingerprint_id from the fingerprint, turning a document every reader correctly
    // rejects into one that governs — and post-cutover it drags the other subject's
    // standing_instructions across with it. Reachable in ordinary use: a §8.2 restore or a device
    // merge replaces the fingerprint while an older configuration is still in the vault.
    //
    // Treated as ABSENT, not deleted — the same call popup.js _mutateExamples makes at its own
    // write. A mismatch can be transient (a fingerprint mid-restore), and the resolver already
    // refuses to let a non-governing document govern, so leaving it costs nothing and deleting
    // authored content on a recoverable mismatch could cost everything.
    const stored = isObj(vd.phaedo_user_configuration) ? vd.phaedo_user_configuration : null;
    const governs = stored && configGoverns(stored, fp);
    const prior = governs ? stored : null;

    // A non-governing document that nothing is about to overwrite is LEFT WHERE IT IS. The resolver
    // already refuses to let it govern, and it still honours that document's tombstones on the
    // fallback path (authored-source.js) — moving it aside here would silently drop those.
    if (!prior && !shouldMint(fp)) return vd;

    // Something IS about to write the slot. Set the orphan aside first — one definition, shared
    // with every other §5 writer (quarantineNonGoverning below).
    const q = quarantineNonGoverning(vd, fp);
    const cfg = deriveUserConfiguration(fp, { now: opts.now, prior });
    if (q.vault !== vd) return { ...q.vault, phaedo_user_configuration: cfg };
    if (prior
        && configContentSig(prior) === configContentSig(cfg)
        && prior.updated_at === cfg.updated_at
        && prior.subject_id === cfg.subject_id
        && prior.fingerprint_id === cfg.fingerprint_id) return vd;
    return { ...vd, phaedo_user_configuration: cfg };
  }

  /**
   * BEFORE ANY §5 WRITER REPLACES THE CONFIGURATION SLOT: set aside what is there if it does not
   * govern this fingerprint. Returns `{ vault, governing }` — `governing` is the stored document
   * when it pairs (write into it), otherwise null (derive fresh); `vault` has the orphan moved
   * into `phaedo_user_configuration_orphaned` and the main slot cleared when there was one to move.
   *
   * ONE DEFINITION, ON PURPOSE. The write finalizer quarantined an orphan on 2026-08-12 — but only
   * when IT was the first to notice. Every other §5 writer "treated a non-governing configuration
   * as absent and derived a fresh one", which is right for what governs and wrong for what happens
   * to the slot: `authorStandingRules` (post-cutover), popup `_mutateExamples`, and the §5 sync
   * merge each wrote a fresh document over the orphan before the finalizer ran, and the only copy
   * of the subject's `example_corpus` went with it. Measured 2026-09-13: authoring one rule with
   * the gate open, or adding one example, destroyed it. A bypass per writer is exactly how the
   * first fix failed; a helper every writer must call is how it stops failing.
   *
   * WHICH ORPHAN SURVIVES when the slot already holds one: the document with MORE authored
   * examples — that is the irreplaceable content and the reason the slot exists; "newest wins"
   * would let a freshly minted, then orphaned, EMPTY document evict twenty samples. Ties go to the
   * newer `updated_at`, then to the one being displaced.
   *
   * Never judges a fingerprint without identity (no `fingerprint_id`): nothing can pair to it, so
   * nothing is moved — a mid-migration fingerprint must not orphan a document that would pair a
   * moment later. Pure; never throws.
   */
  function quarantineNonGoverning(vd, fp) {
    if (!isObj(vd)) return { vault: vd, governing: null };
    const stored = isObj(vd.phaedo_user_configuration) ? vd.phaedo_user_configuration : null;
    if (!stored) return { vault: vd, governing: null };
    if (!isObj(fp) || typeof fp.fingerprint_id !== 'string' || !fp.fingerprint_id) {
      return { vault: vd, governing: null };                 // cannot judge → move nothing
    }
    if (configGoverns(stored, fp)) return { vault: vd, governing: stored };

    const prev = isObj(vd.phaedo_user_configuration_orphaned) ? vd.phaedo_user_configuration_orphaned : null;
    const count = (c) => (c && Array.isArray(c.example_corpus) ? c.example_corpus.length : 0);
    const when  = (c) => Date.parse(c && c.updated_at) || 0;
    let keep = stored;
    if (prev) {
      if (count(prev) > count(stored)) keep = prev;
      else if (count(prev) === count(stored) && when(prev) > when(stored)) keep = prev;
    }
    const next = { ...vd, phaedo_user_configuration_orphaned: keep };
    delete next.phaedo_user_configuration;
    return { vault: next, governing: null };
  }

  /**
   * ADOPT A QUARANTINED CONFIGURATION — the authored EXAMPLES only, and only from the same subject.
   *
   * Quarantine preserves an orphan; it does not give it back. This is the way back, and its whole
   * design is about what must NOT cross:
   *
   *   `example_corpus`  DOES cross. It is the only §5 content nothing can re-derive, it is what
   *                     the subject wants back, and it cannot grant authority or constrain a
   *                     model — the worst a wrong example can do is sit in a list looking wrong,
   *                     where the subject can see it and delete it.
   *
   *   `standing_instructions` DOES NOT. Rules shape what an agent may do; importing them would
   *                     re-stamp another document's constraints as this subject's own authored
   *                     word. That is exactly the LAUNDERING §5.4 exists to prevent, and it would
   *                     arrive wearing the subject's own identity. They are also recoverable from
   *                     the fingerprint or a peer, so refusing them costs nothing irreplaceable.
   *
   *   `revoked_instructions` DOES NOT — and this is the one that looks safe and is not. Elsewhere
   *                     a tombstone is honoured from a document we otherwise refuse, because there
   *                     it can only remove that same document's rules. Imported HERE it would
   *                     delete the rules the subject is living with right now, from a document
   *                     that by definition does not describe their current vault. A deletion is
   *                     only safe to trust about its own copy.
   *
   * Same-subject only. A different `subject_id` is not a re-seed or a restore — it is somebody
   * else's document, and nothing in it should reach this vault by any route.
   *
   * Returns { ok, reason, vault?, adopted?, skipped? }. Never throws, never partially applies.
   */
  function adoptOrphanedExamples(vd, opts = {}) {
    if (!isObj(vd)) return { ok: false, reason: 'no_vault' };
    const orphan = vd.phaedo_user_configuration_orphaned;
    const fp = vd.phaedo_fingerprint;
    if (!isObj(orphan)) return { ok: false, reason: 'nothing_quarantined' };
    if (!isObj(fp)) return { ok: false, reason: 'no_fingerprint' };
    if (typeof orphan.subject_id !== 'string' || !orphan.subject_id || orphan.subject_id !== fp.subject_id) {
      return { ok: false, reason: 'different_subject' };
    }

    const incoming = Array.isArray(orphan.example_corpus) ? orphan.example_corpus : [];
    if (!incoming.length) {
      // Nothing to recover, so stop holding it. Keeping an empty orphan would leave the notice on
      // screen forever with nothing behind it — a promise that something is waiting, when it isn't.
      const cleared = { ...vd };
      delete cleared.phaedo_user_configuration_orphaned;
      return { ok: true, reason: 'empty', vault: cleared, adopted: 0, skipped: 0 };
    }

    let cfg = isObj(vd.phaedo_user_configuration) && configGoverns(vd.phaedo_user_configuration, fp)
      ? vd.phaedo_user_configuration
      : null;
    if (!cfg) {
      try { cfg = deriveUserConfiguration(fp, { now: opts.now }); }
      catch { return { ok: false, reason: 'no_configuration' }; }
    }

    const current = Array.isArray(cfg.example_corpus) ? cfg.example_corpus.slice() : [];
    const seen = new Set(current.map((e) => (isObj(e) && e.example_id) || stable(e)));
    let skipped = 0;
    for (const e of incoming) {
      const k = (isObj(e) && e.example_id) || stable(e);
      if (seen.has(k)) continue;                      // already here — re-adopting must be a no-op
      if (current.length >= EXAMPLE_SOFT_CAP) { skipped++; continue; }
      seen.add(k);
      current.push(deepCopy(e));
    }
    const adopted = current.length - (Array.isArray(cfg.example_corpus) ? cfg.example_corpus.length : 0);

    // The orphan is released only on success, and only once its content is in the governing
    // document — so a failure anywhere above leaves the subject exactly as they were.
    const next = {
      ...vd,
      phaedo_user_configuration: { ...cfg, example_corpus: current, updated_at: opts.now || new Date().toISOString() },
    };
    delete next.phaedo_user_configuration_orphaned;
    return { ok: true, reason: 'adopted', vault: next, adopted, skipped };
  }

  const api = { deriveUserConfiguration, foldStandingInstructions, instructionActiveFor, maintainUserConfiguration, configContentSig, quarantineNonGoverning, adoptOrphanedExamples, EXAMPLE_SOFT_CAP, CONFIG_SCHEMA_REVISION };
  if (typeof globalThis !== 'undefined') globalThis.PhaedoUserConfig = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
