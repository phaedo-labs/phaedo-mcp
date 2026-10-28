// The §5 step-3 upgrade gate — who is current, and may the A-home be retired yet.
//
// WHY THIS EXISTS. Step 3 deletes the fingerprint A-home, which is where authored content lives
// today. A surface that has not upgraded then reads NOTHING where the subject's rules used to be,
// and the failure is asymmetric: a missing GRANT fails safe (no `autoproceed` match, so the agent
// asks) but a missing PROHIBITION does not — with no `escalate`/`decline` rule present the
// inferred signal governs, and that can be "proceed". Retiring the A-home while any reader is
// behind therefore removes caution specifically, never permission.
//
// Sequencing decision 3 (config-home-v02-sequencing-2026-07-26) defines the gate: with one user
// it is "Randy's phone and extension are both on the new build." This module makes that a
// runtime fact instead of a release-day memory.
//
// THE SHAPE THAT MATTERS: this fails CLOSED, and the way it fails closed is not the obvious one.
// `[].every(...)` is TRUE in JavaScript, so a naive "do all peers support it?" answers YES when
// NO PEER HAS EVER REPORTED. That is this codebase's recurring failure exactly — silence read as
// success. Silence here means "you do not know", and not knowing means do not retire anything.
//
// Mirrored by mobile/src/lib/capabilities.ts; kept honest by
// scripts/test_mobile_capabilities_parity.mjs, which RUNS both over the same inputs.

(function () {
  'use strict';

  /** This surface can send and receive the §5 artifact. True on both surfaces since #266/#267. */
  const CONFIG_TRANSPORT = 'config_transport_v0.1';

  /**
   * The capability step 3 requires: this surface SOURCES authored content from §5 and stays
   * correct when the A-home is absent. Deliberately distinct from CONFIG_TRANSPORT — carrying
   * the artifact and reading from it are different claims, and conflating them is how a gate
   * ends up opening on the wrong evidence. Nothing advertises this yet; the step-3 read path
   * is what earns it.
   */
  //
  // ⚠️ NECESSARY BUT NOT SUFFICIENT FOR STEP 3 — found on device 2026-07-27. Every surface now
  // genuinely READS from §5, and this gate goes green on that basis. But §5 cannot yet CARRY an
  // authored rule between devices: mergeConfig folds only `example_corpus`, so a rule authored on
  // the extension is discarded by the phone's merge. Correct today (standing_instructions is
  // re-derived from the A-home, which is what actually syncs rules) and broken the moment step 3
  // makes §5 the authored home. See scripts/test_config_sync_rules_gap.mjs — the tripwire that
  // must be deleted, not silenced, when the merge learns to carry rules.
  const CONFIG_HOME = 'config_home_v0.2';

  /**
   * What each surface implements — PER SURFACE, not one shared list.
   *
   * This file is loaded by the extension AND vendored into the published MCP, and the two do not
   * become §5-native at the same moment. A single shared list would have made the agent claim
   * CONFIG_HOME the instant the extension earned it, which is precisely the "gate opens on the
   * wrong evidence" failure the gate exists to prevent — and it would have been invisible, since
   * the agent would simply have started reading a home it does not understand.
   *
   * A surface earns CONFIG_HOME only when EVERY one of its authored-content reads resolves
   * through §5 and it stays correct with the A-home absent.
   */
  const CAPABILITIES_BY_SURFACE = {
    // Both read sites go through §5: the injection path (context-block.js renderContextBlock)
    // and the popup's rule display (_readStandingRules → authored-source.js).
    extension: [CONFIG_TRANSPORT, CONFIG_HOME],
    // The agent's authored-content readers (ap2.js, autonomy-promotion.js, consult-core.js) all
    // take a FINGERPRINT rather than a vault, so §5 is folded in ONCE at the vd boundary
    // (fingerprint-source.js foldConfigHome) and every one of them is §5-canonical by
    // construction. Same boundary carries the §5.4 check.
    agent: [CONFIG_TRANSPORT, CONFIG_HOME],
  };

  /** Back-compat for callers that ask without naming a surface: the conservative intersection. */
  const CAPABILITIES = [CONFIG_TRANSPORT];


  // WHO MUST BE CURRENT depends on WHO IS ASKING. Retiring the A-home harms any surface that READS
  // authored content, and there are three; the asker is not one of its own peers, because it knows
  // its own capability from CAPABILITIES_BY_SURFACE — it is the code that is running.
  //
  // This used to be a single list, ['phone', 'agent'], which is the EXTENSION's view written as if
  // it were universal. The moment the phone gained a gate of its own that list had it checking
  // ITSELF and the agent while never hearing about the extension — the one peer whose readiness
  // actually matters to it.
  //
  // `self` is REQUIRED in effect: an unrecognised value falls back to checking all three, which
  // can only add blockers. The opposite default — assuming a caller meant the extension — could
  // REMOVE one, and a gate that quietly stops checking a reader is the failure this whole module
  // exists to prevent.
  const ALL_READERS = ['extension', 'phone', 'agent'];
  function readersFor(self) {
    return ALL_READERS.includes(self) ? ALL_READERS.filter((s) => s !== self) : ALL_READERS.slice();
  }

  /** The extension's peer set. Kept as a named export because callers and tests reference it. */
  const READERS = readersFor('extension');

  // A report older than this is not evidence about the fleet as it stands now — a device can be
  // reinstalled, downgraded, or simply gone. 30 days is long enough that a phone left in a drawer
  // over a holiday does not trip the gate, short enough that a stale record cannot authorise a
  // one-way door months later.
  const MAX_REPORT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  /**
   * The payload a surface stamps into what it deposits. Deliberately a CAPABILITY LIST rather
   * than a version number: "what can you do" survives version drift and forks, "what version are
   * you" needs a comparison table that nobody maintains.
   */
  function advertise(surface, now) {
    if (typeof surface !== 'string' || !surface) return null;
    // An UNKNOWN surface gets the conservative set, never the most capable one. Guessing upward
    // here would let a surface nobody has audited close the gate's last blocker.
    const caps = CAPABILITIES_BY_SURFACE[surface] || CAPABILITIES;
    return {
      surface,
      capabilities: caps.slice(),
      stamped_at: now || new Date().toISOString(),
    };
  }

  /**
   * Fold an incoming advertisement into the record of what each peer last reported. Keyed by
   * surface, newest-wins — a surface only ever describes itself, so there is no merge conflict
   * to resolve and no union to get wrong.
   */
  function recordPeer(known, incoming) {
    const base = isObj(known) ? known : {};
    if (!isObj(incoming) || typeof incoming.surface !== 'string' || !incoming.surface) return base;
    const prior = base[incoming.surface];
    const pt = prior ? Date.parse(prior.stamped_at) || 0 : 0;
    const it = Date.parse(incoming.stamped_at) || 0;
    if (it <= pt) return base;
    return {
      ...base,
      [incoming.surface]: {
        capabilities: Array.isArray(incoming.capabilities) ? incoming.capabilities.slice() : [],
        stamped_at: incoming.stamped_at,
      },
    };
  }

  /**
   * Fold a LIST of advertisements. The phone deposits its own plus any it is couriering for a
   * paired agent, because the agent has no direct channel to the extension — the same courier
   * role the phone already plays for capture snapshots and delegation suggestions.
   */
  function recordPeers(known, list) {
    if (!Array.isArray(list)) return isObj(known) ? known : {};
    return list.reduce((acc, ad) => recordPeer(acc, ad), isObj(known) ? known : {});
  }

  /**
   * May the A-home be retired? Returns a REASON, not just a boolean — the caller has to be able
   * to tell the subject why their cutover is being withheld, and "false" alone cannot.
   *
   * Fails closed on: no record at all, a reader that has never reported, a reader that reported
   * without the capability, and a report too old to be evidence.
   */
  function retirementBlockers(known, now, opts) {
    const at = now ? Date.parse(now) : Date.now();
    const rec = isObj(known) ? known : {};
    const blockers = [];
    for (const surface of readersFor(opts && opts.self)) {
      const entry = rec[surface];
      if (!isObj(entry)) {
        // The empty-record case. This is the branch `[].every(...)` would have answered "fine".
        blockers.push({ surface, reason: 'never_reported' });
        continue;
      }
      const caps = Array.isArray(entry.capabilities) ? entry.capabilities : [];
      if (!caps.includes(CONFIG_HOME)) {
        blockers.push({ surface, reason: 'lacks_capability' });
        continue;
      }
      const stamped = Date.parse(entry.stamped_at) || 0;
      if (!stamped || at - stamped > MAX_REPORT_AGE_MS) {
        blockers.push({ surface, reason: 'report_too_old' });
      }
    }
    return blockers;
  }

  /** Convenience over retirementBlockers. Never call this without surfacing the blockers. */
  function canRetireAHome(known, now, opts) {
    return retirementBlockers(known, now, opts).length === 0;
  }

  /** One line a human can act on. */
  function describeBlockers(blockers) {
    if (!Array.isArray(blockers) || !blockers.length) return 'every reader is current';
    const words = {
      never_reported: 'has never reported in',
      lacks_capability: 'is on an older build',
      report_too_old: 'has not been seen recently enough to count',
    };
    return blockers.map((b) => `${b.surface} ${words[b.reason] || b.reason}`).join('; ');
  }

  const api = {
    CONFIG_TRANSPORT, CONFIG_HOME, CAPABILITIES, CAPABILITIES_BY_SURFACE, READERS, ALL_READERS,
    readersFor, MAX_REPORT_AGE_MS,
    advertise, recordPeer, recordPeers, retirementBlockers, canRetireAHome, describeBlockers,
  };
  if (typeof globalThis !== 'undefined') globalThis.PhaedoCapabilities = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
