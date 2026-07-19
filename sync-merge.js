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
  function reconcileAuthored(localFp, phoneFp) {
    const local = localFp || {};
    const phone = phoneFp || {};
    const standingRules = mergeStandingRules(local.standing_rules, phone.standing_rules);
    const ruleAnswers   = mergeRuleAnswers(local.answers, phone.answers);
    const mergedSig = authoredSig(standingRules, ruleAnswers);
    return {
      standingRules,
      ruleAnswers,
      changedLocal: mergedSig !== authoredSig(local.standing_rules || [], ruleAnswersOf(local.answers)),
      changedPhone: mergedSig !== authoredSig(phone.standing_rules || [], ruleAnswersOf(phone.answers)),
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
  function mergeFingerprintForLocal(localFp, phoneFp) {
    if (!phoneFp) return null;
    if (!localFp) return phoneFp;

    const lt = Date.parse(localFp.updated_at) || 0;
    const pt = Date.parse(phoneFp.updated_at) || 0;
    const inferredBase = pt >= lt ? phoneFp : localFp;     // tie → phone

    const lr = Date.parse(localFp.rules_updated_at || localFp.updated_at) || 0;
    const pr = Date.parse(phoneFp.rules_updated_at || phoneFp.updated_at) || 0;
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
  function mergeAgentSuggestions(localFp, deposited) {
    const adds = Array.isArray(deposited) ? deposited : [];
    if (!adds.length || !localFp) return localFp;
    const existing = Array.isArray(localFp.suggested_rules) ? localFp.suggested_rules : [];
    const authored = new Set((Array.isArray(localFp.standing_rules) ? localFp.standing_rules : [])
      .filter(r => r && r.decision && r.decision.origin === 'delegation')
      .map(r => delegationKey(r.decision)).filter(Boolean));
    const seen = new Set(existing
      .filter(s => s && s.source === 'delegation_promotion')
      .map(s => delegationKey(s.decision)).filter(Boolean));
    const fresh = [];
    for (const s of adds) {
      if (!s || s.source !== 'delegation_promotion' || !s.decision) continue; // only agent delegation suggestions
      const k = delegationKey(s.decision);
      if (!k || authored.has(k) || seen.has(k)) continue;                     // no-nag + dedup (incl. within batch)
      seen.add(k);
      fresh.push(s);
    }
    if (!fresh.length) return localFp;
    return { ...localFp, suggested_rules: [...existing, ...fresh] };
  }

  const api = { mergeStandingRules, mergeRuleAnswers, reconcileAuthored, mergeFingerprintForLocal, mergeAgentSuggestions };
  if (typeof globalThis !== 'undefined') globalThis.PhaedoSyncMerge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
