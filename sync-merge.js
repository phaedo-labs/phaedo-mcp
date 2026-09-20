// Phaedo sync — authored-content merge (Proposal 0007 follow-up).
//
// Whole-fingerprint last-write-wins (popup.js reconcileFingerprint) can't handle the
// case where one device AUTHORS rules while the other EXTRACTS signals: whichever
// side's `updated_at` is newer wins the entire fingerprint and silently drops the
// other side's edits. That clobbers a rule authored on the phone whenever the
// extension's copy happens to be newer (it re-stamps on extraction).
//
// Authored content is not inferred, so it must not be subject to that timestamp race.
// This module merges the authored parts — `standing_rules` and the rule_elicitation
// answers — by UNION (never lose a rule written on either device), to be applied on
// top of the existing last-write-wins for the inferred parts. Union is the safe
// direction: the worst case is a duplicate or a resurrected deletion, never a loss.
//
// ⚠️ THAT IS TRUE OF `reconcileAuthored` AND OF THE §5 MERGE, AND ONLY PARTLY TRUE OF THE
// MAILBOX PATH. `mergeFingerprintForLocal` → `assembleMerged` takes the authored WINNER's
// rules and keeps from the loser only its promotion-sourced ones (delta / conflict / delegation),
// so a hand-authored rule that exists only on the side that LOST the authored clock is dropped
// there — and on an exact clock tie the phone argument wins. Measured 2026-09-13 with 400
// randomized two-device trials: convergent whenever the clocks differ; direction-dependent on
// every tie. Ties are effectively unreachable in practice (millisecond clocks, and every authored
// write stamps one), and post-cutover §5 — which does union, with tombstones — is the home that
// governs, so this is recorded rather than changed: making the A-home mirror union on a tie is
// the D11 decision (docs/reviews/full-audit-2026-07-28.md), an owner call about which surface
// is authoritative, not a bug fix.
//
// Pure + dependency-free. Loaded as a classic script in popup.html (exposes
// globalThis.PhaedoSyncMerge) and required by scripts/test_sync_merge.mjs.

(function () {
  'use strict';

  // Stable serialization (sorted keys) so a pure reordering doesn't read as a change.
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }

  // Fields that do NOT define a rule's identity: per-device ids (each device mints its own,
  // so they never match across a sync), presentation, clocks, and lifetime. Two copies of the
  // same authorization differing only in these — a renewed `expires_at`, a re-typed note — are
  // the SAME rule, and keying on them would let both survive as duplicates.
  const RULE_VOLATILE = new Set([
    'instruction_id', 'id', 'note', 'priority', 'source',
    'created_at', 'updated_at', 'expires_at',
  ]);

  // Order-insensitive stable serialization, for identity only. `domains`, `agents`,
  // `scope_domains` and `scope_tasks` are SETS — two devices listing them in different orders
  // have not authored different rules. Never applied to stored data, only to the key.
  function stableIdentity(v) {
    if (Array.isArray(v)) return '[' + v.map(stableIdentity).sort().join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort()
        .map(k => JSON.stringify(k) + ':' + stableIdentity(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }

  /**
   * A standing rule's identity is its CONTENT, not its instruction_id.
   *
   * Rules carrying `text` key exactly as they always have — dimension + text — so this changes
   * nothing for them. §5.2 AUTHORIZATIONS have no `text` at all (they carry `match` + `effect`;
   * see rule-review.js endorseAuthorization), and they used to be dropped outright by the merge
   * rather than keyed. Every sync therefore deleted an endorsed act-as-me autoproceed grant, and
   * an `escalate`/`decline` prohibition with it — the latter failing toward LESS caution.
   *
   * They now key on the fields that define them, with the volatile ones removed. The key is a
   * tagged JSON array so the two key spaces cannot alias — a rule whose text happened to look
   * like a serialized shape must not collide with the shape it resembles.
   *
   * ⚠️ THE FORMAT IS FROZEN AT v1. §5.2 revocation TOMBSTONES persist this string and travel
   * between devices and across versions, so a format change silently stops every existing
   * tombstone matching its rule — every revocation reverts, with nothing to report it. That is
   * the same silent class the tombstones exist to close. A new shape needs a NEW tag alongside
   * this one and a migration, never an edit here.
   */
  function instructionKey(r) {
    const dim = r && r.decision && r.decision.dimension ? String(r.decision.dimension) : '';
    const text = r && r.text ? String(r.text).trim().toLowerCase() : '';
    if (text) return JSON.stringify(['text', dim, text]);
    if (!r || typeof r !== 'object') return JSON.stringify(['text', dim, '']);
    const shape = {};
    for (const k of Object.keys(r)) if (!RULE_VOLATILE.has(k)) shape[k] = r[k];
    return JSON.stringify(['shape', dim, stableIdentity(shape)]);
  }

  /**
   * Is this entry a RULE at all? The old merge used `!r.text` for this, which is what dropped
   * every authorization. A non-text rule still has to look like one — otherwise `{}` and other
   * junk would now propagate where it used to be filtered out.
   */
  function isMergeableRule(r) {
    if (!r || typeof r !== 'object') return false;
    if (r.text) return true;
    // No text: an AUTHORIZATION is the only §5.2 shape that is well-formed without one — it
    // carries `match` + `effect` instead. A textless `instruction` is malformed (the §5
    // validator rejects it too) and keeps being dropped, exactly as before.
    return r.kind === 'authorization' && !!r.effect;
  }

  // When the same rule exists on both sides, keep the richer copy — the one carrying
  // a structured decision value or an exception (e.g. a template-sourced rule beats a
  // plain re-typed one).
  function richness(r) {
    return (r && r.decision && r.decision.value != null ? 2 : 0) + (r && r.exception ? 1 : 0);
  }

  // `opts.preferredIsNewer` — the caller has compared the two AUTHORED CLOCKS and knows the first
  // list is strictly newer. Then a rule present on both sides is settled by the clock, not by
  // content: the newer copy wins even when it is POORER.
  //
  // That last word is the whole fix (D8). `richness` prefers the copy carrying an exception or a
  // structured decision value, which is right for a genuine concurrent edit — but a subject who
  // re-types a rule to REMOVE its exception produces a newer copy that scores lower, so their own
  // older copy beat it and the exception kept narrowing the rule. A content heuristic must not be
  // able to revert an authored deletion.
  //
  // On a TIE (equal or unknown clocks) the heuristics still run. Under genuine uncertainty about
  // which side is newer, preserving content is the safe direction; that is the concurrent-edit
  // case the heuristics were written for, and it is unchanged.
  function mergeStandingRules(localRules, phoneRules, opts) {
    const preferredIsNewer = !!(opts && opts.preferredIsNewer);
    const out = [];
    const from = [];                     // parallel: did out[i] come from the PREFERRED list?
    const idx = new Map();
    const first = Array.isArray(localRules) ? localRules : [];
    const all = [...first, ...(Array.isArray(phoneRules) ? phoneRules : [])];
    for (let n = 0; n < all.length; n++) {
      const r = all[n];
      const preferred = n < first.length;
      if (!isMergeableRule(r)) continue;
      const k = instructionKey(r);
      if (idx.has(k)) {
        const i = idx.get(k);
        if (!preferredIsNewer && richness(r) > richness(out[i])) from[i] = preferred;
        // Same rule from both sides. With a decided clock the first list is the newer one and
        // its copy stands. Otherwise keep the richer copy; two authorizations that key the same
        // both score 0, so the first still wins, which is what makes a renewed `expires_at` win
        // over the stale one it replaces.
        if (!preferredIsNewer && richness(r) > richness(out[i])) out[i] = r;
      } else {
        idx.set(k, out.length);
        out.push(r);
        from.push(preferred);
      }
    }
    return narrowedAgentScopes(out, from, preferredIsNewer);
  }

  /** Identity for a TEXTLESS authorization ignoring `agents` — see narrowedAgentScopes. */
  function scopeBlindIdentity(r) {
    if (!r || typeof r !== 'object' || r.text) return null;
    const shape = {};
    for (const k of Object.keys(r)) if (!RULE_VOLATILE.has(k) && k !== 'agents') shape[k] = r[k];
    return stableIdentity(shape);
  }

  /**
   * NARROWING AN AUTHORIZATION'S `agents` LIST IS AN EDIT, NOT A NEW RULE (D4).
   *
   * `instructionKey` keys a textless authorization by its whole shape minus RULE_VOLATILE, and
   * `agents` is in that shape — so removing a client from the list minted a DIFFERENT rule and
   * the union kept both. The denied client still matched the wide copy and kept getting
   * `proceed` at confidence 1.0. The subject revoked an agent and nothing changed.
   *
   * A rule WITH text never had this problem: its key is ['text', dimension, text], so `agents`
   * was already outside its identity. The two shapes disagreed, and that disagreement was the bug.
   *
   * WHY NOT JUST ADD `agents` TO RULE_VOLATILE: `instructionKey`'s output is FROZEN — §5.2
   * revocation tombstones persist it, so changing what it produces would orphan every tombstone
   * already written for an authorization. This runs after the union instead and leaves the key
   * untouched.
   *
   * Only applies when the CLOCK decided, and only drops copies from the older side. On a tie
   * neither side is known to be newer, so both survive — the same fail direction as D5/D8: an
   * authored narrowing is honoured when it can be proven newer, never guessed at.
   */
  function narrowedAgentScopes(out, from, preferredIsNewer) {
    if (!preferredIsNewer) return out;
    const preferredIds = new Set();
    for (let i = 0; i < out.length; i++) {
      if (!from[i]) continue;
      const id = scopeBlindIdentity(out[i]);
      if (id != null) preferredIds.add(id);
    }
    if (!preferredIds.size) return out;
    return out.filter((r, i) => {
      if (from[i]) return true;                       // the newer side's own copy always stays
      const id = scopeBlindIdentity(r);
      return id == null || !preferredIds.has(id);     // an older copy of the same grant goes
    });
  }

  // A rule_elicitation answer is recognizable by its boolean `endorsed` field — so the
  // merge needs no schema, just the answers maps.
  function isRuleAnswer(v) {
    return v && typeof v === 'object' && typeof v.endorsed === 'boolean';
  }

  // Same `opts.preferredIsNewer` contract as mergeStandingRules, for the same reason (D5).
  // Endorsed-beats-un-endorsed is the right call between two copies of unknown age — but
  // UN-ENDORSING is a first-class action in the UI, and it produces a copy that always loses to
  // the stale endorsed one. The subject withdrew an answer and watched it come back.
  function mergeRuleAnswers(localAnswers, phoneAnswers, opts) {
    const preferredIsNewer = !!(opts && opts.preferredIsNewer);
    const la = localAnswers || {};
    const pa = phoneAnswers || {};
    const ids = new Set([
      ...Object.keys(la).filter(id => isRuleAnswer(la[id])),
      ...Object.keys(pa).filter(id => isRuleAnswer(pa[id])),
    ]);
    const merged = {};
    for (const id of ids) {
      const l = la[id], p = pa[id];
      if (isRuleAnswer(l) && isRuleAnswer(p)) {
        if (preferredIsNewer) merged[id] = l;                 // clock decided; a withdrawal stands
        else if (l.endorsed && !p.endorsed) merged[id] = l;
        else if (p.endorsed && !l.endorsed) merged[id] = p;
        else {
          // both endorsed (or both not): prefer the more-edited (longer) text; tie → local
          const lt = String(l.text || '').trim(), pt = String(p.text || '').trim();
          merged[id] = pt.length > lt.length ? p : l;
        }
      } else {
        merged[id] = isRuleAnswer(l) ? l : p;
      }
    }
    return merged;
  }

  function ruleAnswersOf(answers) {
    const out = {};
    const a = answers || {};
    for (const id of Object.keys(a)) if (isRuleAnswer(a[id])) out[id] = a[id];
    return out;
  }

  // Compare authored content by CONTENT, ignoring per-device volatile fields (each
  // device mints its own instruction_id/timestamps), so the same rule on both sides
  // doesn't read as a change and trigger an endless push on every sync.
  function ruleContent(r) {
    if (!r || typeof r !== 'object') return r;
    const { instruction_id, created_at, updated_at, ...rest } = r;
    return rest;
  }
  function authoredSig(standingRules, ruleAnswers) {
    const rules = (Array.isArray(standingRules) ? standingRules : []).map(ruleContent).map(stable).sort();
    return '[' + rules.join(',') + ']::' + stable(ruleAnswers || {});
  }

  // Reconcile the authored content of two fingerprints. Returns the merged
  // standing_rules + rule answers, and whether each side needs the merged result
  // written back (so the caller can skip redundant writes/pushes when nothing diverged).
  // Identity of a guardrail for merge purposes. Real rules carry an `id`; the fallback
  // keys legacy id-less rules by their content so they still dedupe. A TOMBSTONE stores
  // this same key, so the two can never disagree about which rule is which.
  function consultPolicyKey(r) {
    if (!r || typeof r !== 'object') return null;
    return r.id != null ? String(r.id) : JSON.stringify([r.match, r.effect]);
  }

  // Tombstones are the only thing that can express a DELETE across a union merge, so they
  // must not be dropped casually — pruning by age would let a device that synced before the
  // prune resurrect the rule. Cap by count instead (newest kept). 200 is far above any real
  // revocation history against a 50-rule cap.
  const MAX_REVOKED = 200;

  // Union two §10.5 consult_policies blocks by rule id. `preferred` wins a same-id conflict
  // and leads the order. ONE definition, shared by every merge path, so the mailbox drain and
  // the live-profile reconcile can never disagree about what a guardrail set is.
  //
  // REVOCATION: a union cannot express a delete — the other device's copy just puts the rule
  // back on the next sync. So a removal writes a TOMBSTONE into `revoked` and the union drops
  // any rule whose key is tombstoned on EITHER side. This is deliberately fail-closed: a
  // tombstoned id stays dead even if a rule with that id reappears (e.g. from a restored
  // backup). For an authorization that is the safe direction — a revoked "auto-approve $500"
  // must never come back to life, and rule ids are unique-by-construction so a genuine new
  // rule never collides with one.
  function mergeConsultPolicies(preferred, other) {
    const pr = Array.isArray(preferred?.rules) ? preferred.rules : [];
    const or = Array.isArray(other?.rules) ? other.rules : [];
    const pRev = Array.isArray(preferred?.revoked) ? preferred.revoked : [];
    const oRev = Array.isArray(other?.revoked) ? other.revoked : [];

    // Tombstones union across BOTH sides — a revocation the other device hasn't seen yet
    // still has to take effect here, which is the whole point.
    const revokedByKey = new Map();
    for (const t of [...pRev, ...oRev]) {
      const key = consultPolicyKey(t);
      if (key == null || revokedByKey.has(key)) continue;
      revokedByKey.set(key, t);
    }

    if (!pr.length && !or.length && !revokedByKey.size) return null;

    const byId = new Map();
    for (const r of [...pr, ...or]) {
      const key = consultPolicyKey(r);
      if (key == null) continue;
      if (revokedByKey.has(key)) continue;      // tombstoned → stays dead, from either side
      if (!byId.has(key)) byId.set(key, r);     // preferred iterated first → preferred wins
    }

    const rules = Array.from(byId.values());
    let revoked = Array.from(revokedByKey.values());
    if (revoked.length > MAX_REVOKED) {
      revoked = revoked
        .slice()
        .sort((a, b) => String(a?.at || '').localeCompare(String(b?.at || '')))
        .slice(-MAX_REVOKED);
    }

    // Nothing live AND nothing revoked → the key is absent, not empty scaffolding. A block
    // holding only tombstones must still be carried, or the revocation is forgotten.
    if (!rules.length && !revoked.length) return null;
    const out = { version: preferred?.version || other?.version || '0.1', rules };
    if (revoked.length) out.revoked = revoked;
    return out;
  }

  // §5.7 commitments — AUTHORED decision state ("I already told Acme no", "away until the
  // 4th"). They were riding the INFERRED base by omission, exactly like consult_policies
  // before #240: absent from EVERY merge module, so a sync from a device with a newer
  // `updated_at` silently deleted them. Third instance of that class, hence the structural
  // guard in scripts/test_authored_fields_survive_sync.mjs.
  //
  // UNION by commitment_id, NOT authored-winner-replaces — and the reason is specific. The
  // authored clock (`rules_updated_at`) is SHARED by standing_rules, consult_policies and
  // commitments, so a phone-side RULE edit bumps the same clock that would decide the
  // commitments. Winner-replaces would therefore let an unrelated rule edit on a device that
  // has never authored a commitment delete every commitment the subject recorded. Union
  // cannot do that.
  //
  // The cost of union is that a REMOVAL may not propagate until the entry expires if the
  // other device is stale — accepted, because it fails in the safe direction here: §5.7
  // forbids `autoproceed`, so a commitment can only ever make an agent MORE deferential, and
  // every commitment carries a required `expires_at`. That is the opposite of a §10.5 grant,
  // where a resurrected rule hands back autonomy — which is why THAT one needed tombstones.
  function mergeCommitments(preferred, other) {
    const p = Array.isArray(preferred) ? preferred : [];
    const o = Array.isArray(other) ? other : [];
    if (!p.length && !o.length) return null;
    const byId = new Map();
    for (const c of [...p, ...o]) {
      if (!c || typeof c !== 'object') continue;
      const key = c.commitment_id != null ? String(c.commitment_id) : JSON.stringify([c.statement, c.effect]);
      if (!byId.has(key)) byId.set(key, c);   // preferred iterated first → preferred wins
    }
    const out = Array.from(byId.values());
    return out.length ? out : null;
  }

  function reconcileAuthored(localFp, phoneFp) {
    const local = localFp || {};
    const phone = phoneFp || {};
    // WHICH SIDE IS NEWER, decided before either merge runs. This used to pass `local` first
    // unconditionally, and mergeStandingRules' own comment justified its tie-break by claiming
    // "the side with the newer authored clock" was always first — which nothing checked. So a
    // phone-authored removal lost to the extension's older copy on content grounds alone.
    //
    // A tie leaves `decided` false and both merges fall back to their content heuristics, which
    // is the concurrent-edit case they were written for.
    const lr = authoredClock(local);
    const pr = authoredClock(phone);
    const decided = lr !== pr;
    const newer = pr > lr ? phone : local;
    const older = pr > lr ? local : phone;
    const standingRules = mergeStandingRules(newer.standing_rules, older.standing_rules, { preferredIsNewer: decided });
    const ruleAnswers   = mergeRuleAnswers(newer.answers, older.answers, { preferredIsNewer: decided });
    // Guardrails are authored authority too — union them here so the live /v1/profile
    // reconcile (reconcile-decision.js applyAuthored) can carry them onto whichever
    // fingerprint wins the inferred race, instead of dropping the subject's decisions.
    // Local leads: the extension is the only surface that authors guardrails today.
    const consultPolicies = mergeConsultPolicies(local.consult_policies, phone.consult_policies);
    // §5.7 commitments ride the same authored axis — see mergeCommitments above.
    const commitments = mergeCommitments(local.commitments, phone.commitments);
    // Tombstones ride the signature too: a sync whose ONLY change is a revocation still has
    // to be written back, or the side that hasn't seen the tombstone keeps the dead rule.
    // The REVIEW QUEUES ride the signature too, or the union above is computed and then thrown
    // away: `changedLocal` / `changedPhone` are what decide whether anything is written at all, so
    // a sync whose only change is "the subject dismissed this card on the phone" looked like a
    // no-op and the dismissal never reached the extension.
    //
    // Only the ID and the ANSWER go in — never `last_seen` or `detected_at`. Those churn on every
    // detection pass, and putting them in the signature would make every sync report a change and
    // push forever. Same discipline as RULE_VOLATILE.
    const queueSig = (q) => JSON.stringify([
      (Array.isArray(q?.conflict_records) ? q.conflict_records : [])
        .map(r => [r?.conflict_id, _isConflictActed(r)]).sort(),
      (Array.isArray(q?.suggested_rules) ? q.suggested_rules : [])
        .map(r => [r?.suggestion_id, r?.status || 'suggested']).sort(),
    ]);
    const sigOf = (sr, ans, cp, cm, q) =>
      authoredSig(sr, ans) + '|' + JSON.stringify(cp?.rules || []) +
      '|' + JSON.stringify((cp?.revoked || []).map(t => consultPolicyKey(t)).sort()) +
      '|' + JSON.stringify((cm || []).map(c => c?.commitment_id).sort()) +
      '|' + queueSig(q);
    // REVIEW QUEUES ride the authored axis too (D3). The mailbox path already unions them via
    // `preserveReviewQueues`; the LIVE /v1/profile path (reconcile-decision.js applyAuthored)
    // rebuilt the fingerprint carrying only the fields it knew about, so on the phone-newer
    // branch the extension's `conflict_records` and `suggested_rules` were replaced by the
    // phone's — usually absent. Dismissed suggestions and acknowledged overrides came back as
    // unanswered cards. This is the same defect guardrails and commitments each had, and the
    // same fix: return the union so the live path can carry it. One implementation — the two
    // consumers call the same `_unionById`.
    const reviewQueues = mergeReviewQueues(local, phone);
    const mergedSig = sigOf(standingRules, ruleAnswers, consultPolicies, commitments, reviewQueues);
    return {
      standingRules,
      ruleAnswers,
      consultPolicies,
      commitments,
      reviewQueues,
      changedLocal: mergedSig !== sigOf(local.standing_rules || [], ruleAnswersOf(local.answers), local.consult_policies, local.commitments, local),
      changedPhone: mergedSig !== sigOf(phone.standing_rules || [], ruleAnswersOf(phone.answers), phone.consult_policies, phone.commitments, phone),
    };
  }

  // Merge a drained phone fingerprint into the local one for the store-and-forward
  // mailbox path (Proposal 0008). Two independent last-write-wins axes:
  //   - INFERRED content (signals/summary/layers/closed-form answers): by `updated_at`.
  //   - AUTHORED content (standing_rules + rule_elicitation answers): by
  //     `rules_updated_at` (falling back to `updated_at` for legacy fingerprints).
  // Splitting them is the durable fix for the masking edge: an extraction bumps only
  // `updated_at`, so it can win the inferred content WITHOUT overriding a rule that was
  // authored more recently (newer `rules_updated_at`). Ties go to the PHONE on both
  // axes — it is the authoring surface. Guards: an endorsed rule the authored-loser has
  // but the winner lacks is preserved; the loser's delta_promotion rules are kept.
  // Returns the merged fingerprint (or null if there's nothing to do).
  // Does this fingerprint carry any AUTHORED content at all?
  function hasAuthoredContent(fp) {
    if (!fp || typeof fp !== 'object') return false;
    if (Array.isArray(fp.standing_rules) && fp.standing_rules.length) return true;
    if (Array.isArray(fp.consult_policies?.rules) && fp.consult_policies.rules.length) return true;
    if (Array.isArray(fp.consult_policies?.revoked) && fp.consult_policies.revoked.length) return true;
    if (Array.isArray(fp.commitments) && fp.commitments.length) return true;
    const a = fp.answers || {};
    for (const id of Object.keys(a)) if (isRuleAnswer(a[id])) return true;
    return false;
  }

  // The AUTHORED clock, which decides whose authored content wins.
  //
  // This used to be `rules_updated_at || updated_at`, and that fallback quietly reintroduced
  // the very masking the authored/inferred split exists to prevent — in the opposite
  // direction. A device that has NEVER authored anything has no `rules_updated_at`, so it
  // fell back to `updated_at` and won the authored race simply by having extracted (or saved
  // a non-rule layer) more recently. Its empty `standing_rules` then replaced the subject's.
  // Reachable: author a rule in the extension, close the popup before it syncs, edit a
  // non-rule layer on the phone (LayerScreen bumps `updated_at` but only sets
  // `rules_updated_at` when the layer has rule questions) — the rule is gone.
  //
  // So the fallback now applies ONLY to a side that actually carries authored content, which
  // is the case it was added for (legacy fingerprints predating `rules_updated_at`). A side
  // with nothing authored scores 0 and cannot win.
  //
  // This does NOT break deletion. Every authored write path — `_mutateGuardrailRules`,
  // `addCommitment`/`removeCommitment`, the phone's LayerScreen rule save — stamps
  // `rules_updated_at` explicitly, so a device that just deleted its last authored item has
  // an explicit clock and still wins. The fallback is only ever reached by a device that has
  // never performed an authored write at all.
  function authoredClock(fp) {
    const explicit = Date.parse(fp?.rules_updated_at) || 0;
    if (explicit) return explicit;
    return hasAuthoredContent(fp) ? (Date.parse(fp?.updated_at) || 0) : 0;
  }

  function mergeFingerprintForLocal(localFp, phoneFp) {
    if (!phoneFp) return null;
    if (!localFp) return phoneFp;

    const lt = Date.parse(localFp.updated_at) || 0;
    const pt = Date.parse(phoneFp.updated_at) || 0;
    const inferredBase = pt >= lt ? phoneFp : localFp;     // tie → phone

    const lr = authoredClock(localFp);
    const pr = authoredClock(phoneFp);
    const authoredWinner = pr >= lr ? phoneFp : localFp;   // tie → phone
    const authoredLoser  = pr >= lr ? localFp : phoneFp;

    return assembleMerged(inferredBase, authoredWinner, authoredLoser, localFp, phoneFp);
  }

  // conflict_records + suggested_rules are PRODUCER review queues staged by the extension
  // — but each side can ACT on them (acknowledge / revert / endorse / dismiss). The old
  // "local wins wholesale" lost both directions on a round trip:
  //   - phone-staged acks were dropped when the extension drained (popup re-surfaced the
  //     already-acted record)
  //   - extension-staged NEW records were dropped on the phone drain once the phone had
  //     any local record (the §4.7 review surface stopped seeing new overrides)
  // The fix is per-id UNION with collision resolution that prefers the subject-acted copy:
  //   - new id seen on only one side → keep it
  //   - same id on both sides       → prefer the side that's been acted on; if both, the
  //                                    more-recent timestamp wins
  // For conflict_records, "acted" = resolution.by === 'user' || status === 'dismissed'.
  // For suggested_rules,  "acted" = status !== 'suggested' (so 'endorsed' / 'dismissed' wins).
  function _isConflictActed(r) {
    return !!(r && (r.status === 'dismissed' || (r.resolution && r.resolution.by === 'user')));
  }
  function _isSuggestionActed(r) {
    return !!(r && r.status && r.status !== 'suggested');
  }
  function _conflictTs(r) {
    const t = (r && r.resolution && r.resolution.ack_at) || (r && r.resolved_at) || (r && r.last_seen) || (r && r.detected_at);
    const n = t ? Date.parse(t) : NaN;
    return Number.isFinite(n) ? n : 0;
  }
  function _suggestionTs(r) {
    const t = (r && (r.reviewed_at || r.endorsed_at || r.dismissed_at || r.last_seen || r.detected_at || r.created_at));
    const n = t ? Date.parse(t) : NaN;
    return Number.isFinite(n) ? n : 0;
  }
  function _unionById(local, phone, idField, isActed, tsOf) {
    const byId = new Map();
    for (const r of local) if (r && r[idField]) byId.set(r[idField], r);
    for (const r of phone) {
      if (!r || !r[idField]) continue;
      const id = r[idField];
      const existing = byId.get(id);
      if (!existing) { byId.set(id, r); continue; }
      const eAct = isActed(existing), rAct = isActed(r);
      if (rAct && !eAct) { byId.set(id, r); continue; }
      if (eAct && !rAct) { /* keep existing */ continue; }
      // both acted or neither acted → prefer the more-recent
      if (tsOf(r) > tsOf(existing)) byId.set(id, r);
    }
    return Array.from(byId.values());
  }
  /** The unioned queues, as data. Both consumers (the mailbox merge and the live reconcile) go
   *  through this, so they cannot drift the way they had. */
  function mergeReviewQueues(localFp, phoneFp) {
    const arr = (fp, k) => (Array.isArray(fp && fp[k]) ? fp[k] : []);
    return {
      conflict_records: _unionById(arr(localFp, 'conflict_records'), arr(phoneFp, 'conflict_records'),
        'conflict_id', _isConflictActed, _conflictTs),
      suggested_rules: _unionById(arr(localFp, 'suggested_rules'), arr(phoneFp, 'suggested_rules'),
        'suggestion_id', _isSuggestionActed, _suggestionTs),
    };
  }
  function preserveReviewQueues(out, localFp, phoneFp) {
    const q = mergeReviewQueues(localFp, phoneFp);
    if (q.conflict_records.length) out.conflict_records = q.conflict_records; else delete out.conflict_records;
    if (q.suggested_rules.length) out.suggested_rules = q.suggested_rules; else delete out.suggested_rules;
  }

  // Combine an inferred base with the authored content from authoredWinner (preserving
  // an endorsed rule only the authoredLoser has, and the loser's delta_promotion /
  // conflict_resolution rules), then carry the extension-local review queues.
  function assembleMerged(inferredBase, authoredWinner, authoredLoser, localFp, phoneFp) {
    const out = { ...inferredBase };

    // non-rule answers follow the inferred base; rule answers follow the authored winner
    const answers = {};
    for (const id of Object.keys(inferredBase.answers || {})) {
      if (!isRuleAnswer(inferredBase.answers[id])) answers[id] = inferredBase.answers[id];
    }
    for (const id of Object.keys(authoredWinner.answers || {})) {
      if (isRuleAnswer(authoredWinner.answers[id])) answers[id] = authoredWinner.answers[id];
    }
    for (const id of Object.keys(authoredLoser.answers || {})) {
      const la = authoredLoser.answers[id];
      if (isRuleAnswer(la) && la.endorsed && !(isRuleAnswer(answers[id]) && answers[id].endorsed)) {
        answers[id] = la;
      }
    }
    out.answers = answers;

    const winnerSR = Array.isArray(authoredWinner.standing_rules) ? authoredWinner.standing_rules : [];
    const loserKept = (Array.isArray(authoredLoser.standing_rules) ? authoredLoser.standing_rules : [])
      .filter(r => r && (r.source === 'delta_promotion' || r.source === 'conflict_resolution' || r.source === 'delegation_promotion'));
    const sr = mergeStandingRules(winnerSR, loserKept);
    if (sr.length) out.standing_rules = sr;
    else delete out.standing_rules;

    // keep the authored winner's rules_updated_at so the authored clock keeps advancing
    const wr = authoredWinner.rules_updated_at || inferredBase.rules_updated_at;
    if (wr) out.rules_updated_at = wr;

    // §10.5 consult_policies are AUTHORED authority — the subject said "auto-approve this"
    // or "never that" — so they follow the authored winner, exactly like standing_rules.
    // They previously rode the INFERRED base by omission, which meant a routine sync from a
    // device with a newer updated_at silently DELETED the subject's guardrails. Union by
    // rule id (winner's version wins a conflict, winner's order first) so a guardrail
    // authored on either device survives: losing an explicit decision is never acceptable,
    // and only the extension authors these today, so in practice one side simply has them.
    const pol = mergeConsultPolicies(authoredWinner.consult_policies, authoredLoser.consult_policies);
    if (pol) out.consult_policies = pol;
    else delete out.consult_policies;   // absent on both sides → key absent, never empty scaffolding

    // §5.7 commitments — same authored treatment, union by id (see mergeCommitments).
    const cm = mergeCommitments(authoredWinner.commitments, authoredLoser.commitments);
    if (cm) out.commitments = cm;
    else delete out.commitments;

    // carry the extension-local review queues (conflict_records / suggested_rules)
    preserveReviewQueues(out, localFp, phoneFp);

    preserveLocalStamps(out, localFp);

    return out;
  }

  // ARTIFACT METADATA THE PHONE DOES NOT CARRY — kept from the local copy (2026-09-19).
  //
  // `out` starts from whichever side is newer, and when that is the phone every field the phone's
  // copy lacks is dropped. For authored content that is the point (absence can mean deletion, and
  // the sections above each decide it deliberately). For these five it is not: they describe the
  // ARTIFACT, are deterministic or set once, and the phone simply never stamps them.
  //
  // Dropping them was not merely untidy, it FLASHED: the extension re-stamps on write (migration
  // stampProtocolFields / projectFingerprintToV02), so every popup open re-merged the same phone
  // deposit, saw the stamps missing, wrote "a change", and the popup reloaded itself — a blank
  // flicker on every single open. Measured in a real browser, three opens out of three.
  //
  // Only filled when absent from `out`: a phone that does carry one still wins.
  const LOCAL_STAMP_FIELDS = [
    'phaedo_protocol_version', 'schema_revision', 'fingerprint_envelope_version',
    'fingerprint_version', 'created_at',
  ];
  function preserveLocalStamps(out, localFp) {
    if (!out || !localFp) return;
    for (const k of LOCAL_STAMP_FIELDS) {
      if (out[k] === undefined && localFp[k] !== undefined) out[k] = localFp[k];
    }
  }

  // Merge agent-deposited delegation suggestions (MCP → relay → extension — the act-as-me
  // promotion transport) into the local fingerprint's suggested_rules. UNLIKE the
  // phone↔extension full-fingerprint sync, the agent contributes only suggested_rules
  // ADDITIONS, so this is a targeted UNION (not last-write-wins): append a deposited
  // suggestion unless its (dimension, domain) is already authored as a delegation rule or
  // already staged/dismissed here. Dedup is by the decision BINDING, not suggestion_id,
  // because the producer mints a fresh id on every deposit. Pure — returns a new fingerprint
  // (or the input unchanged when there is nothing new to add).
  function delegationKey(d) {
    return d && d.dimension ? `${d.dimension}|${d.domain || ''}` : null;
  }
  // §10.7 autonomy suggestions are keyed by the domains their §10.5 match covers,
  // not by a decision dimension — they are gates, not dispositions.
  function autonomyKey(s) {
    const d = s && s.match && Array.isArray(s.match.domains) ? s.match.domains : [];
    return d.length ? d.map(x => String(x).toLowerCase()).sort().join(',') : null;
  }
  function mergeAgentSuggestions(localFp, deposited) {
    const adds = Array.isArray(deposited) ? deposited : [];
    if (!adds.length || !localFp) return localFp;
    const existing = Array.isArray(localFp.suggested_rules) ? localFp.suggested_rules : [];
    const rules = Array.isArray(localFp.standing_rules) ? localFp.standing_rules : [];
    const authored = new Set(rules
      .filter(r => r && r.decision && r.decision.origin === 'delegation')
      .map(r => delegationKey(r.decision)).filter(Boolean));
    // An already-authored autoproceed for the same domains means the subject has
    // settled this — re-proposing it would be nagging for autonomy they already gave.
    const authoredAuto = new Set(rules
      .filter(r => r && r.kind === 'authorization' && r.effect === 'autoproceed')
      .map(r => autonomyKey(r)).filter(Boolean));
    const seen = new Set(existing
      .filter(s => s && s.source === 'delegation_promotion')
      .map(s => delegationKey(s.decision)).filter(Boolean));
    const seenAuto = new Set(existing
      .filter(s => s && s.source === 'autonomy_promotion')
      .map(s => autonomyKey(s)).filter(Boolean));
    const fresh = [];
    for (const s of adds) {
      if (!s) continue;
      if (s.source === 'autonomy_promotion') {
        // Structural guard at the merge boundary: a staged relaxation that arrived
        // without its binding requirement or its expiry is not merged at all. The
        // producer sets both; anything else came from a tampered or stale deposit,
        // and a permanent unbound autoproceed is exactly what must never be staged.
        if (s.kind !== 'authorization' || s.effect !== 'autoproceed') continue;
        if (s.require_binding !== true || !s.expires_at) continue;
        const k = autonomyKey(s);
        if (!k || authoredAuto.has(k) || seenAuto.has(k)) continue;
        seenAuto.add(k);
        fresh.push(s);
        continue;
      }
      if (s.source !== 'delegation_promotion' || !s.decision) continue;       // only agent delegation suggestions
      const k = delegationKey(s.decision);
      if (!k || authored.has(k) || seen.has(k)) continue;                     // no-nag + dedup (incl. within batch)
      seen.add(k);
      fresh.push(s);
    }
    if (!fresh.length) return localFp;
    // Backstop against a runaway "Rules to review" card: even with the dedupe above, a
    // producer bug or a stale relay slot could deposit faster than the subject clears
    // cards. A hard cap keeps the newest and drops the oldest, so the popup can never be
    // flooded into a refresh loop by an unbounded list. 200 is far above any real backlog
    // of pending suggestions — hitting it means something upstream is misbehaving, not that
    // the subject has 200 genuine decisions to make.
    const MAX_SUGGESTED = 200;
    const merged = [...existing, ...fresh];
    const capped = merged.length > MAX_SUGGESTED ? merged.slice(-MAX_SUGGESTED) : merged;
    return { ...localFp, suggested_rules: capped };
  }

  // `richness` is exported for one reason: context-block.js collapses duplicate rules at the
  // INJECTION seam and must make the same choice this merge does, or the merge keeps the copy
  // carrying an authored exception and the block then discards it. Exported so
  // scripts/test_injection_integrity.mjs can assert that coupling instead of asserting it in prose.
  const api = { instructionKey, richness, mergeStandingRules, mergeRuleAnswers, reconcileAuthored, mergeFingerprintForLocal, mergeAgentSuggestions, mergeConsultPolicies, consultPolicyKey, mergeCommitments, authoredClock, hasAuthoredContent };
  if (typeof globalThis !== 'undefined') globalThis.PhaedoSyncMerge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
