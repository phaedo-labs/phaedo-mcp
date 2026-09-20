// Where authored content comes FROM — the step-3 read path.
//
// Authored standing rules live in two places during the migration: the fingerprint A-home
// (`fp.standing_rules`, Proposal 0007) and the §5 User Configuration (`standing_instructions`,
// derived from the A-home on every write). The sequencing decision is that the §5 copy is
// AUTHORITATIVE ON READ where both exist, so that step 3 can later delete the A-home and change
// nothing about what readers see. Every reader routing through here is what makes that true.
//
// WHY A RESOLVER AND NOT `cfg.standing_instructions || fp.standing_rules`:
//
//   1. §5.4. A configuration that does not name the fingerprint it arrived with is not this
//      subject's — stale, mis-routed, or hostile. Letting it govern would let one identity's
//      authored rules apply to another. It must fall back, not be trusted.
//   2. ABSENT and EMPTY are different. No §5 document at all means "this surface has not been
//      migrated, use the A-home". A §5 document with an empty list means "the subject has no
//      rules", and falling back there would RESURRECT rules the subject deleted — the same
//      failure as the union-vs-tombstone bug in §10.5 revocation (#247).
//   3. The caller needs to know WHICH home answered. A reader that cannot report its provenance
//      cannot be verified on device, and "it works" would be indistinguishable from "it silently
//      read the old home the whole time".
//
// Mirrored by mobile/src/lib/authoredSource.ts; kept honest by
// scripts/test_mobile_authored_source_parity.mjs, which RUNS both over the same inputs.

(function () {
  'use strict';

  /**
   * WHICH HOME IS AUTHORITATIVE for authored rules — the step-3 cutover switch.
   *
   * It lives HERE, with the resolver, because "where does authored content live" is one question
   * and both the reader and the writer must answer it identically. authored-write.js re-exports
   * it; user-config.js reads it to decide whether a re-derive may overwrite standing_instructions.
   * This module imports nothing, so every consumer can read it without an import cycle.
   *
   * 'fingerprint' — today. Rules live on the A-home; §5 is DERIVED from it on every write.
   * 'config'      — after step 3. §5 is the source; the A-home is a mirror, and the derive must
   *                 stop overwriting §5 or a routine fingerprint write erases authored rules.
   *
   * Flipping this IS the cutover. It ships only once the upgrade gate reads green against real
   * device reports (owner decision 2026-07-27: release check, not runtime interlock).
   *
   * FLIPPED to 'config' on 2026-07-28 and REVERTED the same day, before any device carried it.
   * The revert is the mechanism working: one constant, so a bad answer costs one line.
   *
   * A post-flip review found SIX confirmed paths that lose authored content, every one of them
   * benign while the A-home is authoritative and live the moment it is not:
   *   1. the phone's chokepoint replaces §5 wholesale from the mirror, so any authored save
   *      destroys a §5-only rule (mobile/src/lib/authoredWrite.ts)
   *   2. background.js never loads THIS module, so the vault write finalizer throws on every
   *      service-worker write and §5 is never maintained there
   *   3. the live /v1/profile sync path carries no §5 at all (popup.js silentSync)
   *   4. popup.js _actOnOverride authors a rule outside the write chokepoint
   *   5. the SW capture re-deposit strips the §5 envelope off the wire, so authored rules and
   *      the irreplaceable example_corpus never reach the phone
   *   6. a non-governing §5 document is never cleared, and absorbs authored content into a
   *      document that can never govern — and is excluded from §8.2 backup at the same moment
   *
   * WHAT MUST BE TRUE BEFORE FLIPPING AGAIN — all six closed, plus:
   *   - every authoring site routes through the chokepoint, enumerated BY BEHAVIOUR
   *   - every reader routes through resolveStandingInstructions, likewise
   *   - the upgrade gate is actually CONSULTED (it currently has zero production call sites)
   *   - the phone advertises config_home_v0.2 only once it genuinely satisfies it
   *   - a device pass on a build that carries the phone half
   * See docs/state/current-state.md and scripts/test_cutover_readiness.mjs.
   */
  const AUTHORED_HOME = 'config';

  // ── The upgrade gate, wired ────────────────────────────────────────────────────────────────
  //
  // `AUTHORED_HOME` ARMS the cutover. It does not perform it. The effective home is `'config'`
  // only when the constant says so AND capabilities.js reports every reader current — so flipping
  // the constant on a fleet where the phone or the agent is behind changes NOTHING until they
  // catch up, instead of retiring the A-home out from under them.
  //
  // This is the wiring the gate was missing. `canRetireAHome` and `retirementBlockers` were
  // correct and well tested and had ZERO production call sites: evidence was collected into
  // `phaedo_peer_capabilities` and never asked. The 2026-07-28 flip shipped without the mechanism
  // designed to authorise it ever being consulted, and six loss paths went with it.
  //
  // WHY A LATCH RATHER THAN A READ. The consumers (user-config.js, authored-write.js) are pure
  // functions over a vault object, and the capability record lives outside the vault on purpose —
  // it is fleet metadata, and the gate must be answerable without unlocking anything. Making
  // those functions async, or handing them a storage handle, would put I/O on the authoring path.
  // So the surface that CAN read storage pushes the record in, and the pure modules read it
  // synchronously.
  //
  // IT FAILS CLOSED IN EVERY DIRECTION. Unset (nobody pushed a record), capabilities.js not
  // loaded, an empty record, a reader that never reported, a reader on an older build, a report
  // too old — all of them resolve to `'fingerprint'`. Silence is not consent; the only path to
  // `'config'` is positive evidence from every reader.
  let _peerCapabilities = null;

  /**
   * Publish what the fleet last reported. Called by whichever surface can read storage
   * (background.js on startup, popup.js after each mailbox drain).
   */
  function setPeerCapabilities(known) {
    _peerCapabilities = isObj(known) ? known : null;
  }

  /** What was last published. Exposed so a caller can show the subject the same evidence. */
  function peerCapabilities() { return _peerCapabilities; }

  /**
   * The home that is actually in force, and why. Returns a REASON so a withheld cutover can be
   * explained rather than merely observed — the same discipline `retirementBlockers` follows.
   *
   * @returns {{ home: string, armed: boolean, blockers: Array, reason: string }}
   */
  function effectiveAuthoredHomeDetail(now) {
    // Read the PUBLISHED value, not the closure constant. `api.AUTHORED_HOME` is what every
    // consumer sees, so reading anything else would let the module disagree with its own exports
    // — and it is the value the cutover suites set to stage post-cutover conditions, which means
    // they exercise this path rather than a parallel one.
    const armed = (api && api.AUTHORED_HOME) || AUTHORED_HOME;
    if (armed !== 'config') {
      return { home: 'fingerprint', armed: false, blockers: [], reason: 'not_armed' };
    }
    const CAP = (typeof globalThis !== 'undefined' && globalThis.PhaedoCapabilities) || null;
    if (!CAP || typeof CAP.retirementBlockers !== 'function') {
      // The gate module is not present, so the fleet's state is unknowable here. Unknowable is
      // not the same as fine — this is the `[].every(...)` trap the gate itself was built around.
      return { home: 'fingerprint', armed: true, blockers: [], reason: 'gate_unavailable' };
    }
    if (!isObj(_peerCapabilities)) {
      return { home: 'fingerprint', armed: true, blockers: [], reason: 'no_capability_record' };
    }
    // NAME THE ASKER. The extension's peers are the phone and the agent; passing nothing would
    // fall back to checking all three including itself, which never reports and would block
    // forever. See readersFor in capabilities.js.
    const blockers = CAP.retirementBlockers(_peerCapabilities, now, { self: 'extension' });
    if (blockers.length) {
      return { home: 'fingerprint', armed: true, blockers, reason: 'readers_behind' };
    }
    return { home: 'config', armed: true, blockers: [], reason: 'fleet_current' };
  }

  /** The home in force. Use `effectiveAuthoredHomeDetail` when you need to explain a fallback. */
  function effectiveAuthoredHome(now) {
    return effectiveAuthoredHomeDetail(now).home;
  }

  /** Where an answer came from. Returned, never inferred by the caller. */
  const SOURCE = {
    CONFIG: 'config',            // §5 — the post-cutover home
    FINGERPRINT: 'fingerprint',  // the A-home — the fallback step 3 removes
    NONE: 'none',                // neither home had anything to say
  };

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  /**
   * The configuration's live instructions — those not buried by a §5.2 tombstone.
   *
   * Keyed by the FROZEN identity in sync-merge.js. When that module is absent (a reader that
   * loads only the resolver) the tombstones cannot be evaluated, and the honest answer is to
   * return the rules unchanged rather than guess: dropping rules we cannot key would lose
   * authored content, and that is the worse direction here.
   */
  function withoutRevoked(cfg) {
    const rules = cfg.standing_instructions;
    const tombs = Array.isArray(cfg.revoked_instructions) ? cfg.revoked_instructions : [];
    if (!tombs.length) return rules;
    const SM = (typeof globalThis !== 'undefined' && globalThis.PhaedoSyncMerge) || null;
    if (!SM || typeof SM.instructionKey !== 'function') return rules;
    const dead = new Set(tombs.map((t) => (isObj(t) ? t.key : null)).filter(Boolean));
    if (!dead.size) return rules;
    return rules.filter((r) => !dead.has(SM.instructionKey(r)));
  }

  /**
   * Does this configuration belong to this fingerprint? Mirrors config-sync.js `pairingHolds`
   * deliberately rather than importing it: this module is loaded by readers that have no reason
   * to pull in the transport, and the rule is three lines. Parity between the two is asserted in
   * scripts/test_authored_source.mjs so the duplication cannot drift.
   */
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
   * The authoritative standing instructions, and where they came from.
   *
   * §5 wins whenever it is present AND governs — including when it is EMPTY, because an empty
   * authored set is a statement ("I have no rules"), not an absence. Only a missing or
   * non-governing configuration falls through to the A-home.
   *
   * @returns {{ rules: Array, source: string, reason?: string }}
   */
  function resolveStandingInstructions(fp, cfg) {
    const aHome = isObj(fp) && Array.isArray(fp.standing_rules) ? fp.standing_rules : null;

    if (isObj(cfg) && Array.isArray(cfg.standing_instructions)) {
      if (configGoverns(cfg, fp)) {
        // §5.2 tombstones are enforced HERE, not only at the merge. A device that has not merged
        // since the revocation still holds the rule in `standing_instructions`; honouring the
        // tombstone at read time is what makes the revocation take effect immediately rather
        // than on the next sync. §10.5 learned this the hard way — ap2.js honoured its
        // tombstones while the consult resolver did not, so one artifact gave two answers.
        return { rules: withoutRevoked(cfg), source: SOURCE.CONFIG };
      }
      // Present but not this subject's. Fall back rather than trust it, and SAY so — a §5.4
      // rejection that looks identical to "no configuration here" is how a mis-paired document
      // would go unnoticed for months.
      //
      // BUT ITS DELETIONS STILL COUNT. The A-home has no revocation concept, and its copy is
      // union-merged, so a rule the subject deleted comes back from any peer that still holds it
      // — and falling back to that copy put the deleted rule into force again (measured
      // 2026-08-12). Honouring the tombstones on a document we otherwise refuse is safe in a way
      // that honouring its rules would not be: a tombstone can only ever REMOVE an instruction,
      // never add one or change what it says. The worst it can do is withhold a rule the subject
      // wanted; the alternative is obeying one they revoked, which is the direction that cannot
      // be noticed from the outside.
      if (aHome) {
        return { rules: withoutRevoked({ standing_instructions: aHome, revoked_instructions: cfg.revoked_instructions }),
                 source: SOURCE.FINGERPRINT, reason: 'config_pairing_failed' };
      }
      return { rules: [], source: SOURCE.NONE, reason: 'config_pairing_failed' };
    }

    if (aHome) return { rules: aHome, source: SOURCE.FINGERPRINT, reason: 'no_config' };
    return { rules: [], source: SOURCE.NONE, reason: 'no_config' };
  }

  /**
   * True once this surface would behave identically with the A-home deleted — i.e. §5 answered.
   * This is the evidence a surface needs before it may advertise `config_home_v0.2` to the
   * upgrade gate. Claiming the capability on the strength of "the code is deployed" rather than
   * "the read actually resolved to §5" is exactly how a gate opens on the wrong evidence.
   */
  function readsFromConfigHome(fp, cfg) {
    return resolveStandingInstructions(fp, cfg).source === SOURCE.CONFIG;
  }

  // Declared before the functions above can run (they only read it at call time), so
  // `effectiveAuthoredHomeDetail` can consult the published value.
  const api = {
    AUTHORED_HOME, SOURCE, configGoverns, resolveStandingInstructions, readsFromConfigHome,
    setPeerCapabilities, peerCapabilities, effectiveAuthoredHome, effectiveAuthoredHomeDetail,
  };
  if (typeof globalThis !== 'undefined') globalThis.PhaedoAuthoredSource = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
