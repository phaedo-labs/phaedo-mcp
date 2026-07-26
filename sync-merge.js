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

  // A standing rule's identity is its content, not its instruction_id (each device
  // mints its own id, so ids never match across a sync). Dedup by dimension + text.
  function ruleKey(r) {
    const dim = r && r.decision && r.decision.dimension ? String(r.decision.dimension) : '';
    const text = r && r.text ? String(r.text).trim().toLowerCase() : '';
    return dim + ' ' + text;
  }

  // When the same rule exists on both sides, keep the richer copy — the one carrying
  // a structured decision value or an exception (e.g. a template-sourced rule beats a
  // plain re-typed one).
  function richness(r) {
    return (r && r.decision && r.decision.value != null ? 2 : 0) + (r && r.exception ? 1 : 0);
  }

  function mergeStandingRules(localRules, phoneRules) {
    const out = [];
    const idx = new Map();
    const all = [
      ...(Array.isArray(localRules) ? localRules : []),
      ...(Array.isArray(phoneRules) ? phoneRules : []),
    ];
    for (const r of all) {
      if (!r || typeof r !== 'object' || !r.text) continue;
      const k = ruleKey(r);
      if (idx.has(k)) {
        const i = idx.get(k);
        if (richness(r) > richness(out[i])) out[i] = r;
      } else {
        idx.set(k, out.length);
        out.push(r);
      }
    }
    return out;
  }

  // A rule_elicitation answer is recognizable by its boolean `endorsed` field — so the
  // merge needs no schema, just the answers maps.
  function isRuleAnswer(v) {
    return v && typeof v === 'object' && typeof v.endorsed === 'boolean';
  }

  function mergeRuleAnswers(localAnswers, phoneAnswers) {
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
        if (l.endorsed && !p.endorsed) merged[id] = l;
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
    const standingRules = mergeStandingRules(local.standing_rules, phone.standing_rules);
    const ruleAnswers   = mergeRuleAnswers(local.answers, phone.answers);
    // Guardrails are authored authority too — union them here so the live /v1/profile
    // reconcile (reconcile-decision.js applyAuthored) can carry them onto whichever
    // fingerprint wins the inferred race, instead of dropping the subject's decisions.
    // Local leads: the extension is the only surface that authors guardrails today.
    const consultPolicies = mergeConsultPolicies(local.consult_policies, phone.consult_policies);
    // §5.7 commitments ride the same authored axis — see mergeCommitments above.
    const commitments = mergeCommitments(local.commitments, phone.commitments);
    // Tombstones ride the signature too: a sync whose ONLY change is a revocation still has
    // to be written back, or the side that hasn't seen the tombstone keeps the dead rule.
    const sigOf = (sr, ans, cp, cm) =>
      authoredSig(sr, ans) + '|' + JSON.stringify(cp?.rules || []) +
      '|' + JSON.stringify((cp?.revoked || []).map(t => consultPolicyKey(t)).sort()) +
      '|' + JSON.stringify((cm || []).map(c => c?.commitment_id).sort());
    const mergedSig = sigOf(standingRules, ruleAnswers, consultPolicies, commitments);
    return {
      standingRules,
      ruleAnswers,
      consultPolicies,
      commitments,
      changedLocal: mergedSig !== sigOf(local.standing_rules || [], ruleAnswersOf(local.answers), local.consult_policies, local.commitments),
      changedPhone: mergedSig !== sigOf(phone.standing_rules || [], ruleAnswersOf(phone.answers), phone.consult_policies, phone.commitments),
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
  function preserveReviewQueues(out, localFp, phoneFp) {
    const cl = Array.isArray(localFp && localFp.conflict_records) ? localFp.conflict_records : [];
    const cp = Array.isArray(phoneFp && phoneFp.conflict_records) ? phoneFp.conflict_records : [];
    const conflicts = _unionById(cl, cp, 'conflict_id', _isConflictActed, _conflictTs);
    if (conflicts.length) out.conflict_records = conflicts; else delete out.conflict_records;

    const sl = Array.isArray(localFp && localFp.suggested_rules) ? localFp.suggested_rules : [];
    const sp = Array.isArray(phoneFp && phoneFp.suggested_rules) ? phoneFp.suggested_rules : [];
    const suggestions = _unionById(sl, sp, 'suggestion_id', _isSuggestionActed, _suggestionTs);
    if (suggestions.length) out.suggested_rules = suggestions; else delete out.suggested_rules;
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

    return out;
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

  const api = { mergeStandingRules, mergeRuleAnswers, reconcileAuthored, mergeFingerprintForLocal, mergeAgentSuggestions, mergeConsultPolicies, consultPolicyKey, mergeCommitments };
  if (typeof globalThis !== 'undefined') globalThis.PhaedoSyncMerge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
