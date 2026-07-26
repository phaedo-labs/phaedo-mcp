// ─── Phaedo Fingerprint Migration ─────────────────────────────────────────────
//
// §4.2 fingerprint-envelope migration + §4.7 layer-key rename, as one
// coordinated transform. Projects the questionnaire-shape stored fingerprint
// (`{ layers: { id: { label, responses[] } } }`) into the protocol §4.2 layer
// envelope (`{ layer_version, last_updated, confidence, signals[], summary }`)
// and renames the §4.7 layer keys to canonical form. Idempotent — detected by
// `fingerprint_envelope_version`.
//
// Projection source is the raw `answers` object preserved by
// interview/src/components/Complete.jsx:29 — NOT the formatted response text,
// which would be lossy.
//
// THIS MODULE IS PURE. It does not touch chrome.storage. Activation (calling
// it on vault read and writing the result back) is a separate wiring change
// that must be coordinated with the mobile side (loop2-integration §4.7) so a
// half-migrated extension⇄phone sync cannot corrupt phaedo_behavioral_signals
// under last-write-wins.

(function () {
  const ENVELOPE_VERSION_TARGET = '0.2';
  const LAYER_VERSION = '0.1';
  const QUESTIONNAIRE_CONFIDENCE = 0.7; // per-signal default for self-report

  // §4.1 protocol-identity fields stamped on the fingerprint body. PROTOCOL_VERSION
  // is the spec's MAJOR.MINOR wire value (distinct from protocol.js Protocol.VERSION,
  // the build version); SCHEMA_REVISION is the §4.1 layer-schema revision counter.
  const PHAEDO_PROTOCOL_VERSION = '0.1';
  const PHAEDO_SCHEMA_REVISION = 1;

  // Ensure the §4.1 protocol-identity fields exist on a fingerprint body.
  // Idempotent: fills only an absent field. `phaedo_protocol_version` and
  // `schema_revision` are deterministic constants (safe to stamp on every read);
  // `subject_id` is an opaque, non-PII UUID minted ONCE — so mint it only on the
  // persisting path (mintSubject), never on the in-memory every-read path, or it
  // would churn until persisted. Returns { changed, fp } (fp unchanged if nothing
  // was missing). The same deferral convention as fingerprint_id (§ projection).
  function stampProtocolFields(fp, { mintSubject = false } = {}) {
    if (!fp || typeof fp !== 'object') return { changed: false, fp };
    let out = fp, changed = false;
    const set = (k, v) => {
      if (out[k] === undefined) { if (out === fp) out = { ...fp }; out[k] = v; changed = true; }
    };
    set('phaedo_protocol_version', PHAEDO_PROTOCOL_VERSION);
    set('schema_revision', PHAEDO_SCHEMA_REVISION);
    if (mintSubject) set('subject_id', uuid());
    return { changed, fp: out };
  }

  // §4.7 layer-key renames.
  const LAYER_KEY_RENAMES = {
    'domain':         'domain_and_expertise',
    'temporal':       'temporal_and_context',
    'collaboration':  'collaboration_and_relationship',
    'decision':       'decision_and_risk',
    'decision_risk':  'decision_and_risk',
    'meta':           'big_picture',
  };
  function canonicalLayerId(id) { return LAYER_KEY_RENAMES[id] || id; }

  // Questionnaire-question → §5.4 field projection.
  //
  // Each entry: { field, polarity, type }
  //   type drives how the answer value is read:
  //     'enum'          — single_select / sample_reaction → a.value or a.sampleId
  //     'array'         — multi_select / multi_select_ranked → a.values
  //     'scalar'        — slider → a.value / (stops-1)
  //     'string'        — free_text → a.text
  //     'string_list_split' — free_text split on common delimiters
  //     'struct'        — paired_choice_sequence / dual_* → structured pass-through
  //
  // Questions without a §5.4 field mapping are skipped — the questionnaire-only
  // free-text fields (m1 self_narrative, m2 address_as) are still preserved
  // because §5.4 carries them under `big_picture`.
  const FIELD_MAP = {
    // surface
    s1: { field: 'response_length_pref', polarity: 'positive', type: 'enum' },
    s2: { field: 'tone_register',        polarity: 'positive', type: 'enum' },
    s3: { field: 'formatting_prefs',     polarity: 'positive', type: 'array' },
    s4: { field: 'jargon_tolerance',     polarity: 'positive', type: 'scalar' },
    // s5 (explanation_style) — no §5.4 field, intentionally skipped
    s6: { field: 'pet_peeves',           polarity: 'negative', type: 'string_list_split' },

    // behavioral
    // b1 (decision_threshold) — questionnaire-only, no §5.4 field with this name
    b2: { field: 'iteration_style',      polarity: 'positive', type: 'enum' },
    b3: { field: 'ambiguity_response',   polarity: 'positive', type: 'enum' },
    b4: { field: 'detail_vs_principle',  polarity: 'positive', type: 'enum' },

    // creative
    cr1: { field: 'quality_word',          polarity: 'positive', type: 'enum' },
    cr2: { field: 'problem_solving_move',  polarity: 'positive', type: 'enum' },

    // domain
    d1: { field: 'primary_expertise',      polarity: 'positive', type: 'string' },
    d2: { field: 'domain_depth_pref',      polarity: 'positive', type: 'enum' },
    d3: { field: 'active_learning_areas',  polarity: 'positive', type: 'string_list_split' },
    d4: { field: 'learning_style',         polarity: 'positive', type: 'array' },

    // temporal
    t1: { field: 'early_project_mode',     polarity: 'positive', type: 'enum' },
    t2: { field: 'pressure_response',      polarity: 'positive', type: 'array' },

    // collaboration
    c1: { field: 'audience_adaptation',    polarity: 'positive', type: 'enum' },
    c2: { field: 'feedback_pref',          polarity: 'positive', type: 'enum' },
    c3: { field: 'disagreement_style',     polarity: 'positive', type: 'enum' },
    // c4 has subAnswers (drains/energizes) — split into two signals below

    // decision_and_risk
    r1: { field: 'speed_vs_quality',          polarity: 'positive', type: 'scalar' },
    r2: { field: 'value_tradeoffs',           polarity: 'positive', type: 'struct' },
    r3: { field: 'reversibility_sensitivity', polarity: 'positive', type: 'struct' },

    // big_picture
    m1: { field: 'self_narrative', polarity: 'positive', type: 'string' },
    m2: { field: 'address_as',     polarity: 'positive', type: 'struct' },
  };

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function readAnswerValue(answer, question, type) {
    if (!answer) return null;
    switch (type) {
      case 'enum': {
        const v = answer.value ?? answer.sampleId;
        return v || null;
      }
      case 'array': {
        const arr = answer.values;
        return Array.isArray(arr) && arr.length ? arr : null;
      }
      case 'scalar': {
        const i = answer.value;
        if (i === null || i === undefined) return null;
        const stops = question.stops || 5;
        return Math.max(0, Math.min(1, i / (stops - 1)));
      }
      case 'string': {
        const t = answer.text?.trim();
        return t || null;
      }
      case 'string_list_split': {
        const t = answer.text?.trim();
        if (!t) return null;
        return t.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
      }
      case 'struct': {
        return answer.picks || answer.subAnswers || null;
      }
      default:
        return null;
    }
  }

  // Evidence-basis vocabulary (Proposal 0002): observed | corroborated | self_reported.
  // Match extraction/fingerprint-update.js evidenceBasis() so the two producer paths
  // (questionnaire projection here, extraction signal enrichment there) agree —
  // detectConflicts checks the literal string in provenance, so a missing basis
  // silently disables the §4.7 forward override detector. Keep in sync.
  function evidenceBasisFromSource(source) {
    const s = String(source || '').toLowerCase();
    if (s.includes('corrobor') || s.includes('reconcil')) return 'corroborated';
    if (s.includes('question') || s.includes('self') || s.includes('interview')) return 'self_reported';
    return 'observed';
  }

  function signal(field, polarity, value, source, now) {
    return {
      signal_id: uuid(),
      field,
      polarity,
      value,
      confidence: QUESTIONNAIRE_CONFIDENCE,
      source,
      // Proposal 0002 — stamped so the §4.7 forward detector (reconcile.js
      // detectConflicts) sees a questionnaire candidate as 'self_reported'
      // when an incoming observed/delta signal contradicts it. Without this
      // stamp the override path silently misses (interview answer disappears
      // from the provenance.find check) — see test_reconcile_forward_override.mjs.
      evidence_basis: evidenceBasisFromSource(source),
      observation_count: 1,
      session_refs: [],
      last_observed: now,
    };
  }

  // Project a complete questionnaire fingerprint into the §4.2 envelope.
  // Inputs:
  //   fingerprint — the stored shape from Complete.jsx#buildFingerprint
  //   schema      — the questionnaire schema (questionnaire_schema.json contents)
  // Returns: the §4.2-shaped fingerprint, or the input unchanged if already migrated.
  function projectFingerprintToV02(fingerprint, schema) {
    if (!fingerprint || typeof fingerprint !== 'object') return fingerprint;
    if (fingerprint.fingerprint_envelope_version === ENVELOPE_VERSION_TARGET) {
      return fingerprint;
    }

    const answers = fingerprint.answers || {};
    const oldLayers = fingerprint.layers || {};
    const now = new Date().toISOString();
    const canonicalLayers = {};

    for (const layer of schema.core_flow.layers) {
      const canonId = canonicalLayerId(layer.id);
      const signals = [];
      let answeredCount = 0;
      const totalCount = layer.questions.length;

      for (const q of layer.questions) {
        const a = answers[q.id];
        if (!a) continue;

        // c4 (collaboration_energy) — dual_multi_select with drains/energizes
        if (q.id === 'c4' && q.sub_questions) {
          const drains    = a.subAnswers?.c4_drains    || [];
          const energizes = a.subAnswers?.c4_energizes || [];
          if (drains.length) {
            signals.push(signal('collaboration_drains', 'negative', drains, 'questionnaire', now));
            answeredCount++;
          }
          if (energizes.length) {
            signals.push(signal('collaboration_energizers', 'positive', energizes, 'questionnaire', now));
            if (!drains.length) answeredCount++;
          }
          continue;
        }

        const mapping = FIELD_MAP[q.id];
        if (!mapping) continue;
        const value = readAnswerValue(a, q, mapping.type);
        if (value === null || value === undefined ||
            (Array.isArray(value) && value.length === 0)) continue;
        signals.push(signal(mapping.field, mapping.polarity, value, 'questionnaire', now));
        answeredCount++;
      }

      // Additive envelope: KEEP the questionnaire shape (label/responses) and
      // any existing extraction signals[]/summary in place, and ADD the §4.2
      // envelope fields alongside. This keeps the phone (HomeScreen counts,
      // computeKnowledgeScore, LayerScreen) and the current buildContextBlock
      // "Interview answers" rendering working unchanged — see
      // docs/persona-extraction/loop2-4.2-projection-plan.md.
      const old = oldLayers[layer.id] || oldLayers[canonId] || {};
      const existingSignals = Array.isArray(old.signals) ? old.signals : [];
      canonicalLayers[canonId] = {
        label:     old.label || layer.label || canonId,
        responses: Array.isArray(old.responses) ? old.responses : [],
        layer_version: LAYER_VERSION,
        last_updated: now,
        confidence: totalCount === 0 ? 0 : answeredCount / totalCount,
        // Unify both sources into one array: existing extraction signals first,
        // then the questionnaire-projected ones. Runs once (guarded by the
        // envelope-version short-circuit above), so no double-merge.
        signals: [...existingSignals, ...signals],
        summary: typeof old.summary === 'string' ? old.summary : '',
      };
    }

    // Carry forward any stored layers the schema does not enumerate (defensive —
    // an extraction-only layer key must never be silently dropped).
    for (const [id, layer] of Object.entries(oldLayers)) {
      const canonId = canonicalLayerId(id);
      if (!canonicalLayers[canonId]) canonicalLayers[canonId] = layer;
    }

    const projected = {
      // Preserve any unanticipated top-level fields (and `answers`, which the
      // phone's LayerScreen reads as its source of truth).
      ...fingerprint,
      fingerprint_envelope_version: ENVELOPE_VERSION_TARGET,
      fingerprint_id:     fingerprint.fingerprint_id || uuid(),
      fingerprint_version: fingerprint.fingerprint_version || fingerprint.version || '2.0',
      schema_version:     fingerprint.schema_version,
      created_at:         fingerprint.created_at || fingerprint.generated || now,
      // Do NOT bump updated_at — preserve it so a one-time projection cannot
      // clobber a concurrent newer phone state under last-write-wins sync.
      updated_at:         fingerprint.updated_at || fingerprint.generated || now,
      layers:             canonicalLayers,
      answers,
    };
    // §4.1 protocol-identity fields (phaedo_protocol_version, schema_revision,
    // subject_id) — minted here so a freshly-projected fingerprint is born conformant.
    return stampProtocolFields(projected, { mintSubject: true }).fp;
  }

  // §4.7 — rename the keys of phaedo_behavioral_signals to canonical form.
  // The inner shape (the signal-name → count map per layer) is unchanged.
  function renameBehavioralSignals(signals) {
    if (!signals || typeof signals !== 'object') return signals;
    const renamed = {};
    for (const [oldKey, value] of Object.entries(signals)) {
      const newKey = canonicalLayerId(oldKey);
      if (renamed[newKey]) {
        // Old + canonical both present (e.g. 'decision' and 'decision_risk' → 'decision_and_risk').
        // Sum the per-signal counts.
        for (const [sig, count] of Object.entries(value)) {
          renamed[newKey][sig] = (renamed[newKey][sig] || 0) + count;
        }
      } else {
        renamed[newKey] = { ...value };
      }
    }
    return renamed;
  }

  // ── §4.7 rename-only path (no §4.2 envelope projection) ─────────────────────
  // Renames layer KEYS to canonical form while preserving each layer's existing
  // shape (questionnaire `{ label, responses }` and/or extraction `signals[]`).
  // This is the narrow layer-key migration — distinct from the full §4.2
  // envelope projection above. Applied on every vault read (idempotent) so the
  // extension/phone operate on canonical keys without changing the stored
  // fingerprint format.

  function mergeRenamedLayer(a, b) {
    // Defensive: a fingerprint with BOTH an old and its canonical key (rare).
    // Concatenate response/signal arrays, prefer `a` for scalar fields.
    const out = { ...b, ...a };
    if (Array.isArray(a.responses) || Array.isArray(b.responses)) {
      out.responses = [...(a.responses || []), ...(b.responses || [])];
    }
    if (Array.isArray(a.signals) || Array.isArray(b.signals)) {
      out.signals = [...(a.signals || []), ...(b.signals || [])];
    }
    return out;
  }

  // ── Stored-summary hygiene (stale-data regeneration, §4.6 + Proposal 0006) ─────
  // A vault written by an older producer can hold non-conformant layer summaries:
  // episodic lines (URL/email/domain), opaque enum codes, or duplicate dimensions.
  // context-block.js sanitizes at INJECTION (defense-in-depth), but the STORED
  // value stays dirty — which `npm run health` flags and which a less-careful
  // consumer would read raw. Re-sanitize the stored summary on read/migrate so the
  // vault itself becomes conformant. Full regeneration through the §4.7 producer
  // happens on the next extraction (extraction/resolve.js); this is the string-level
  // cleanup the classic content-script context can do.
  //
  // Regexes copied verbatim from context-block.js sanitizeSummary — they MUST stay
  // in sync with it and with checkSummary() in spec/validate-fingerprint.mjs.
  var SUMMARY_EPISODIC_RE = /(https?:\/\/|\bwww\.)|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|\b[a-z0-9][a-z0-9-]*\.(com|org|net|io|so|co|ai|app|xyz|info)\b/i;
  var SUMMARY_DIM_RE = /^[-*\s]*([^:]{1,60}):\s*(.+)$/;
  var SUMMARY_OPAQUE_RE = /^[a-z]\d(?:[ _][a-z0-9]+)*$/i;
  function sanitizeSummary(text) {
    const out = [];
    const seen = new Set();
    for (const raw of String(text).split('\n')) {
      const t = raw.trim();
      if (!t) { out.push(raw); continue; }
      if (SUMMARY_EPISODIC_RE.test(t)) continue;                 // drop episodic (§4.6)
      const m = t.match(SUMMARY_DIM_RE);
      if (m) {
        const dim = m[1].trim().toLowerCase();
        if (seen.has(dim)) continue;                             // drop duplicate dimension
        if (SUMMARY_OPAQUE_RE.test(m[2].trim())) continue;       // drop opaque value
        seen.add(dim);
      }
      out.push(raw);
    }
    return out.join('\n').trim();
  }

  // Re-sanitize each layer's stored `summary`. Returns the same fp if nothing
  // changed (idempotent) so the read path's change-detection stays cheap.
  function sanitizeStoredSummaries(fp) {
    if (!fp || typeof fp !== 'object' || !fp.layers || typeof fp.layers !== 'object') return fp;
    let changed = false;
    const layers = {};
    for (const [id, layer] of Object.entries(fp.layers)) {
      if (layer && typeof layer.summary === 'string' && layer.summary.trim()) {
        const clean = sanitizeSummary(layer.summary);
        if (clean !== layer.summary) { changed = true; layers[id] = { ...layer, summary: clean }; continue; }
      }
      layers[id] = layer;
    }
    return changed ? { ...fp, layers } : fp;
  }

  function canonicalizeFingerprintLayers(fp) {
    if (!fp || typeof fp !== 'object' || !fp.layers || typeof fp.layers !== 'object') return fp;
    let changed = false;
    const layers = {};
    for (const [id, layer] of Object.entries(fp.layers)) {
      const canon = canonicalLayerId(id);
      if (canon !== id) changed = true;
      layers[canon] = layers[canon] ? mergeRenamedLayer(layers[canon], layer) : layer;
    }
    return changed ? { ...fp, layers } : fp;
  }

  // Backfill hand-authored Operating Rules at priority 50 → priority 5 — matches
  // the post-PR #92 authored-leads default (`popup.js addOperatingRule` now writes
  // priority 5; it previously defaulted to 50, so existing on-disk vaults still
  // carry the legacy number). Priority 5 leads above the questionnaire decision
  // rules (10–40) and delta promotions (36–60) so a deliberately-typed user
  // constraint survives the 16-rule injection budget — the whole point of the #92
  // fix. Pre-fix authored rules don't get that benefit until backfilled.
  //
  // SCOPE: only `source:'interview'` AND `priority >= 50`. The priority filter is
  // load-bearing — the questionnaire's own decision_rules.js writes (priorities
  // 10/30/40, also `source:'interview'` after edit) are LEFT UNTOUCHED. Other
  // sources (delta_promotion, delegation_promotion, conflict_resolution) have
  // their own priority semantics (resolveConflict legitimately defaults to 50;
  // delta promotions use evidence-weighted 36–60) and stay out of scope.
  //
  // Idempotent: a fingerprint where every authored rule already sits below 50
  // returns the same reference. No `updated_at` bump (format cleanup, not user
  // edit — same convention as backfillSignalEvidenceBasis + sanitizeStoredSummaries).
  function backfillAuthoredRulePriority(fp) {
    if (!fp || typeof fp !== 'object' || !Array.isArray(fp.standing_rules)) return fp
    let changed = false
    const rules = fp.standing_rules.map((r) => {
      if (!r || typeof r !== 'object') return r
      if (r.source !== 'interview') return r
      if (typeof r.priority !== 'number' || r.priority < 50) return r
      changed = true
      return { ...r, priority: 5 }
    })
    return changed ? { ...fp, standing_rules: rules } : fp
  }

  // Backfill `evidence_basis` on any layer signal that lacks it (pre-fix
  // producers — questionnaire signals projected before this stamping landed —
  // and any future legacy paths that bypass extraction/fingerprint-update.js).
  // Idempotent: a fingerprint where every signal already carries a basis
  // returns the same reference. The §4.7 forward override detector
  // (reconcile.js detectConflicts) needs the literal 'self_reported' string in
  // provenance to fire; a missing basis silently disables it.
  function backfillSignalEvidenceBasis(fp) {
    if (!fp || typeof fp !== 'object' || !fp.layers || typeof fp.layers !== 'object') return fp;
    let fpChanged = false;
    const layers = {};
    for (const [id, layer] of Object.entries(fp.layers)) {
      const sigs = Array.isArray(layer && layer.signals) ? layer.signals : null;
      if (!sigs) { layers[id] = layer; continue; }
      let layerChanged = false;
      const next = sigs.map((s) => {
        if (!s || typeof s !== 'object') return s;
        if (s.evidence_basis) return s;
        layerChanged = true;
        return { ...s, evidence_basis: evidenceBasisFromSource(s.source) };
      });
      if (layerChanged) { fpChanged = true; layers[id] = { ...layer, signals: next }; }
      else layers[id] = layer;
    }
    return fpChanged ? { ...fp, layers } : fp;
  }

  // Canonicalize the layer keys across a vault payload (fingerprint layers +
  // behavioral-signals). Returns the same object if nothing changed (idempotent).
  function canonicalizeVaultKeys(vault) {
    if (!vault || typeof vault !== 'object') return vault;
    let out = vault;
    const fp = vault.phaedo_fingerprint;
    if (fp) {
      let cfp = canonicalizeFingerprintLayers(fp);
      // Stamp the deterministic §4.1 constants on every read (idempotent) so the
      // fingerprint the extension/MCP operate on always carries them. subject_id
      // is NOT minted here (no persistence) — the migrateVault path mints it.
      const st = stampProtocolFields(cfp, { mintSubject: false });
      if (st.changed) cfp = st.fp;
      cfp = sanitizeStoredSummaries(cfp);   // stored-summary hygiene (idempotent)
      cfp = backfillSignalEvidenceBasis(cfp); // §4.7 forward-detector backfill (idempotent)
      cfp = backfillAuthoredRulePriority(cfp); // PR #92 authored-leads-at-5 backfill (idempotent)
      if (cfp !== fp) out = { ...out, phaedo_fingerprint: cfp };
    }
    const bs = vault.phaedo_behavioral_signals;
    if (bs && Object.keys(bs).some(k => LAYER_KEY_RENAMES[k])) {
      out = { ...out, phaedo_behavioral_signals: renameBehavioralSignals(bs) };
    }
    return out;
  }

  // Apply the full migration to a vault payload. Returns { changed, vault }.
  function migrateVault(vaultPayload, schema) {
    if (!vaultPayload || typeof vaultPayload !== 'object') {
      return { changed: false, vault: vaultPayload };
    }
    let changed = false;
    const out = { ...vaultPayload };
    const fp = vaultPayload.phaedo_fingerprint;
    if (fp && fp.fingerprint_envelope_version !== ENVELOPE_VERSION_TARGET) {
      out.phaedo_fingerprint = projectFingerprintToV02(fp, schema);
      changed = true;
    }
    // Unconditional §4.1 protocol-field stamp (mints + persists subject_id once).
    // Runs even when the §4.2 projection short-circuited above, so an
    // already-projected fingerprint that predates these fields is backfilled and
    // persisted on the next migrateEnvelope (which writes when changed).
    const curFp = out.phaedo_fingerprint;
    if (curFp) {
      const st = stampProtocolFields(curFp, { mintSubject: true });
      if (st.changed) { out.phaedo_fingerprint = st.fp; changed = true; }
    }
    // Stored-summary hygiene: persist conformant summaries so the stored vault
    // (not just the injected projection) is clean. Idempotent; no updated_at bump
    // (a format cleanup, not a user edit — must not churn last-write-wins sync).
    const curFp2 = out.phaedo_fingerprint;
    if (curFp2) {
      const cleaned = sanitizeStoredSummaries(curFp2);
      if (cleaned !== curFp2) { out.phaedo_fingerprint = cleaned; changed = true; }
    }
    // §4.7 forward-detector backfill: stamp evidence_basis on questionnaire/legacy
    // signals that lack it so detectConflicts' provenance.find(self_reported) fires.
    // Idempotent (already-stamped fingerprint returns the same reference).
    const curFp3 = out.phaedo_fingerprint;
    if (curFp3) {
      const stamped = backfillSignalEvidenceBasis(curFp3);
      if (stamped !== curFp3) { out.phaedo_fingerprint = stamped; changed = true; }
    }
    // PR #92 authored-leads-at-5 backfill: bump legacy popup-authored Operating
    // Rules (source:'interview' at priority 50) → priority 5 so they survive the
    // 16-rule injection budget. Idempotent + same-ref shortcut.
    const curFp4 = out.phaedo_fingerprint;
    if (curFp4) {
      const repriced = backfillAuthoredRulePriority(curFp4);
      if (repriced !== curFp4) { out.phaedo_fingerprint = repriced; changed = true; }
    }
    const bs = vaultPayload.phaedo_behavioral_signals;
    if (bs && Object.keys(bs).some(k => LAYER_KEY_RENAMES[k])) {
      out.phaedo_behavioral_signals = renameBehavioralSignals(bs);
      changed = true;
    }
    return { changed, vault: out };
  }

  const api = {
    ENVELOPE_VERSION_TARGET,
    LAYER_KEY_RENAMES,
    FIELD_MAP,
    readAnswerValue,                // exported so the §4.7 retroactive override-rescan can
                                    //  reuse the canonical interview→value mapping (no drift).
    canonicalLayerId,
    projectFingerprintToV02,
    stampProtocolFields,
    renameBehavioralSignals,
    canonicalizeFingerprintLayers,
    sanitizeSummary,
    sanitizeStoredSummaries,
    backfillSignalEvidenceBasis,
    backfillAuthoredRulePriority,
    canonicalizeVaultKeys,
    migrateVault,
  };
  if (typeof globalThis !== 'undefined') globalThis.phaedoMigration = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
