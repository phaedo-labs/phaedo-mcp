// Phaedo — per-source signal ledgers: learning from several browsers adds up (multi-browser, 2026-09-24).
//
// THE PROBLEM. A learned (extraction) signal accumulates INSIDE the fingerprint: every pass adds
// to `observation_count` and pushes `confidence` up by noisy-OR (extraction/reconcile.js). There is
// no raw store behind it — the fingerprint is the only accumulator. Sync then merged the inferred
// layers LAST-WRITE-WINS, whole: with one browser that was fine, with two it meant whichever browser
// extracted last replaced every layer, and the other browser's learning vanished.
//
// Neither obvious fix works. SUM double-counts the history both copies share (a work browser that
// pulled the personal fingerprint and learned 3 more observations would count the first 5 twice).
// MAX loses one side's new observations.
//
// THE FIX: each signal carries a small ledger saying where its evidence came from.
//
//   signal.ledger = {
//     legacy:    { observation_count, confidence, value, last_observed } | null,
//     by_source: { <source_id>: { observation_count, confidence, value, last_observed, context? } },
//   }
//
// - A browser only ever ADDS to its own `by_source` entry, so each entry only grows. Merging two
//   copies keeps, per source, the entry with more observations — a grow-only counter per source,
//   which is commutative, idempotent and order-free: every copy converges to the same ledger no
//   matter how many times, or in what order, deposits cross.
// - `legacy` is everything a signal held before it had a ledger — history the copies SHARE. Two
//   copies' legacy entries are reconciled by max, never summed.
// - The signal's own `observation_count` / `confidence` / `value` / `last_observed` are DERIVED
//   from the ledger (aggregate), so every reader that ignores the ledger — injection, consult, the
//   phone, the MCP — sees correct totals without changing.
//
// `context` ('personal' | 'work') tags which side of the subject's life a browser serves, chosen
// on the phone when it paired. Recorded now so a later context-aware projection has the data; it
// does not change any total.
//
// Only EXTRACTION evidence is ledgered. `source: 'delta'` signals are snapshots rebuilt from raw
// counters every pass, and cross-browser they combine as capture sources (capture-combine.js);
// `questionnaire` self-report is identical on every copy. Both keep last-write-wins, as before.
//
// Pure + dependency-free. UMD: a classic script in popup.html (globalThis.PhaedoSignalLedger),
// a side-effect import in extraction/reconcile.js and background.js, and `require` in Node.
// MIRRORED by mobile/src/lib/signalLedger.js (Metro cannot import this file); the parity test
// scripts/test_signal_ledger_parity.mjs RUNS both over the same inputs, so drift fails CI.

(function (factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.PhaedoSignalLedger = api;
})(function () {
  'use strict';

  const CONFIDENCE_CAP = 0.95;
  const round3 = (n) => Number((n || 0).toFixed(3));

  // Noisy-OR, capped — the same curve extraction/reconcile.js combineConfidence uses.
  function combineConfidence(a, b) {
    return Math.min(CONFIDENCE_CAP, 1 - (1 - (a || 0)) * (1 - (b || 0)));
  }

  function unionArrays(a, b) {
    return Array.from(new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]));
  }

  function maxIso(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return a > b ? a : b;
  }

  // Stable serialization (sorted keys) — the deterministic last-resort tie-break.
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }

  /** Same dedupe key as extraction/reconcile.js sigKey. */
  function sigKey(s) {
    return `${s.field}::${s.polarity}${typeof s.domain === 'string' ? `::${s.domain}` : ''}`;
  }

  /** Is this signal the kind whose evidence is ledgered? */
  function isLedgered(s) {
    return !!s && s.source !== 'delta' && s.source !== 'questionnaire';
  }

  function entryOf(s) {
    const e = {
      observation_count: s.observation_count || 1,
      confidence: round3(s.confidence),
      value: s.value,
      last_observed: s.last_observed || null,
    };
    if (s.context) e.context = s.context;
    return e;
  }

  // A scalar entry's per-value observation counts, `{ stable(value): n }`. Entries written before
  // this existed (and `legacy`, which snapshots a whole signal) count wholly toward their one value.
  function valueCountsOf(e) {
    if (!e || Array.isArray(e.value)) return {};
    if (e.value_counts && typeof e.value_counts === 'object') return e.value_counts;
    return { [stable(e.value)]: e.observation_count || 1 };
  }

  // Add one increment to a source's entry: counts sum, confidence noisy-ORs, arrays union.
  // A SCALAR keeps a per-value tally and shows the value with the most observations — a single
  // current value, set by whichever observation first carried the most confidence, pinned the
  // first answer seen: 1 "long" then 30 "short" still read "long" (review, 2026-09-30).
  function accumulate(entry, inc, now) {
    const n = inc.observation_count || 1;
    if (!entry) {
      const out = {
        observation_count: n,
        confidence: round3(inc.confidence),
        value: inc.value,
        last_observed: inc.last_observed || now || null,
      };
      if (!Array.isArray(inc.value)) out.value_counts = { [stable(inc.value)]: n };
      return out;
    }
    let value = entry.value;
    let value_counts = null;
    if (Array.isArray(entry.value) && Array.isArray(inc.value)) {
      value = unionArrays(entry.value, inc.value);
    } else {
      value_counts = { ...valueCountsOf(entry) };
      const k = stable(inc.value);
      value_counts[k] = (value_counts[k] || 0) + n;
      // Most observations wins; on a tie the entry keeps what it showed unless the new observation
      // is the better-supported one — the pre-tally rule, now only a tie-break.
      let bestK = stable(entry.value), bestN = value_counts[bestK] || 0;
      for (const [key, cnt] of Object.entries(value_counts)) {
        if (cnt > bestN || (cnt === bestN && key === k && (inc.confidence || 0) > (entry.confidence || 0))) {
          bestK = key; bestN = cnt;
        }
      }
      value = bestK === k ? inc.value : (bestK === stable(entry.value) ? entry.value : JSON.parse(bestK));
    }
    const out = {
      observation_count: (entry.observation_count || 1) + n,
      confidence: round3(combineConfidence(entry.confidence, inc.confidence)),
      value,
      last_observed: maxIso(entry.last_observed, inc.last_observed) || now || null,
    };
    if (value_counts) out.value_counts = value_counts;
    if (entry.context) out.context = entry.context;
    return out;
  }

  // Two copies of ONE source's entry: the one with more observations is the newer (entries only
  // grow). Ties fall to the later observation, then to a deterministic compare, so merge(a, b)
  // and merge(b, a) pick the same entry.
  function pickEntry(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    const ca = a.observation_count || 0, cb = b.observation_count || 0;
    if (ca !== cb) return ca > cb ? a : b;
    const la = a.last_observed || '', lb = b.last_observed || '';
    if (la !== lb) return la > lb ? a : b;
    return stable(a) >= stable(b) ? a : b;
  }

  /** The ledger's entries in a fixed order: legacy first, then sources sorted by id. */
  function orderedEntries(ledger) {
    const out = [];
    if (ledger && ledger.legacy) out.push(ledger.legacy);
    const bs = (ledger && ledger.by_source) || {};
    for (const id of Object.keys(bs).sort()) if (bs[id]) out.push(bs[id]);
    return out;
  }

  /**
   * Recompute a signal's visible totals from its ledger. Returns a new signal.
   *
   * A SCALAR value is the one with the most observations behind it, summed across every entry that
   * holds it — not the highest-confidence entry. Confidence caps at 0.95 after a handful of
   * observations, so "highest confidence" degenerated into "most recent to reach the cap": after 50
   * observations of "short" and 4 of "long" a browser's own entry could pin "long" for good
   * (review, 2026-09-30). Ties fall to confidence, then recency, then entry order (legacy first).
   */
  function aggregate(signal) {
    const entries = orderedEntries(signal.ledger);
    if (!entries.length) return signal;
    let count = 0, conf = 0, last = null;
    let arrayValue = null;
    const tally = new Map();          // stable(value) → { value, n, conf, last, order }
    entries.forEach((e, i) => {
      count += e.observation_count || 0;
      conf = combineConfidence(conf, e.confidence);
      last = maxIso(last, e.last_observed);
      if (Array.isArray(e.value)) { arrayValue = unionArrays(arrayValue, e.value); return; }
      // Each entry's own per-value tally, so a browser that saw both values contributes both.
      for (const [k, cnt] of Object.entries(valueCountsOf(e))) {
        const t = tally.get(k) || { value: k === stable(e.value) ? e.value : JSON.parse(k), n: 0, conf: 0, last: '', order: i };
        t.n += cnt || 0;
        t.conf = Math.max(t.conf, e.confidence || 0);
        t.last = (e.last_observed || '') > t.last ? (e.last_observed || '') : t.last;
        tally.set(k, t);
      }
    });
    let best = null;
    for (const t of tally.values()) {
      if (!best || t.n > best.n || (t.n === best.n && (t.conf > best.conf ||
          (t.conf === best.conf && (t.last > best.last || (t.last === best.last && t.order < best.order)))))) best = t;
    }
    const out = { ...signal, observation_count: count, confidence: round3(conf), value: arrayValue || (best ? best.value : signal.value) };
    if (last) out.last_observed = last;
    return out;
  }

  /**
   * Evidence a build WITHOUT ledgers added to a ledgered signal. Such a build (a browser profile
   * not yet reloaded) accumulates the visible totals and carries the ledger through untouched, so
   * the next aggregate anywhere would recompute from the ledger and silently drop those
   * observations (review, 2026-09-30). The excess of the visible count over the ledger's sum is
   * that unattributed evidence; it is folded into `legacy`, whose copies merge by max — so the same
   * excess on two copies still counts once.
   */
  function normalize(signal) {
    if (!signal || !signal.ledger) return signal;
    const sum = orderedEntries(signal.ledger).reduce((a, e) => a + (e.observation_count || 0), 0);
    const excess = (signal.observation_count || 0) - sum;
    if (excess <= 0) return signal;
    const prev = signal.ledger.legacy;
    const legacy = prev
      ? { ...prev, observation_count: (prev.observation_count || 0) + excess,
          confidence: round3(Math.max(prev.confidence || 0, signal.confidence || 0)) }
      : { observation_count: excess, confidence: round3(signal.confidence), value: signal.value, last_observed: signal.last_observed || null };
    return { ...signal, ledger: { ...signal.ledger, legacy } };
  }

  /**
   * Record one extraction increment against `sourceId`. `existing` may be null (a new signal) or a
   * signal without a ledger yet, whose whole current evidence becomes `legacy`. Returns the new
   * signal with its totals re-derived.
   */
  function attribute(existing, incoming, sourceId, opts) {
    const now = (opts && opts.now) || null;
    const context = opts && opts.context;
    existing = normalize(existing);
    const base = existing ? { ...existing } : { ...incoming };
    const ledger = existing && existing.ledger
      ? { legacy: existing.ledger.legacy || null, by_source: { ...(existing.ledger.by_source || {}) } }
      : { legacy: existing ? entryOf(existing) : null, by_source: {} };
    const entry = accumulate(ledger.by_source[sourceId] || null, incoming, now);
    if (context) entry.context = context;
    ledger.by_source[sourceId] = entry;
    if (existing) {
      base.source = incoming.source || existing.source;
      base.session_refs = unionArrays(existing.session_refs, incoming.session_refs);
    }
    base.ledger = ledger;
    return aggregate(base);
  }

  /**
   * Merge two copies of the same signal (same sigKey). `base` supplies every non-ledger field.
   * A copy without a ledger contributes its totals as `legacy`. If NEITHER copy has a ledger, or the
   * signal is not ledgered, `base` wins unchanged — exactly the behaviour before ledgers existed.
   */
  function mergeSignalCopies(base, other) {
    if (!other) return base;
    if (!base) return other;
    // A delta snapshot is rebuilt from raw counters and REPLACES whatever held its key
    // (reconcile.js mergeSignal) — nothing to add from either side.
    if (base.source === 'delta' || other.source === 'delta') return base;
    // A self-report that the OTHER copy has since seen corroborated: that copy carries the
    // self-report as its `legacy` entry plus the observations on top, so it is the fuller one.
    if (!isLedgered(base)) return (isLedgered(other) && other.ledger) ? other : base;
    if (!isLedgered(other)) return base;
    if (!base.ledger && !other.ledger) return base;
    base = normalize(base);
    other = normalize(other);
    const lb = base.ledger || { legacy: entryOf(base), by_source: {} };
    const lo = other.ledger || { legacy: entryOf(other), by_source: {} };
    const by_source = {};
    for (const id of new Set([...Object.keys(lb.by_source || {}), ...Object.keys(lo.by_source || {})])) {
      const e = pickEntry((lb.by_source || {})[id] || null, (lo.by_source || {})[id] || null);
      if (e) by_source[id] = e;
    }
    const merged = {
      ...base,
      session_refs: unionArrays(base.session_refs, other.session_refs),
      ledger: { legacy: pickEntry(lb.legacy || null, lo.legacy || null), by_source },
    };
    return aggregate(merged);
  }

  /** Average signal confidence — reconcile.js reconcileLayer's layer-level `confidence`. */
  function layerConfidence(signals) {
    return round3(signals.reduce((a, s) => a + ((s && s.confidence) || 0), 0) / (signals.length || 1));
  }

  /**
   * Merge two copies of a layer. `base` keeps every non-signal field (questionnaire responses,
   * label, summary). Signals union by key; a signal on both sides merges through its ledger. Returns
   * `base` itself when nothing changes, so a no-op merge never reads as a write.
   */
  function mergeLayer(base, other) {
    if (!other || !Array.isArray(other.signals) || !other.signals.length) return base;
    if (!base) {
      // A layer only the other copy has: only its ATTRIBUTED evidence crosses, never its
      // non-signal fields (questionnaire responses, label) — last-write-wins decides those, as it
      // always has.
      const carried = other.signals.filter((o) => isLedgered(o) && o.ledger);
      if (!carried.length) return base;
      return { layer_version: other.layer_version || '0.1', signals: carried, confidence: layerConfidence(carried) };
    }
    const bs = Array.isArray(base.signals) ? base.signals : [];
    const byKey = new Map(bs.map((s) => [sigKey(s), s]));
    let changed = false;
    for (const o of other.signals) {
      if (!o) continue;
      const k = sigKey(o);
      const b = byKey.get(k);
      const m = b ? mergeSignalCopies(b, o) : (isLedgered(o) && o.ledger ? o : null);
      // A signal only the OTHER copy has joins when it carries a ledger — i.e. it came from a
      // build that attributes evidence. A ledger-less signal there is the same pre-ledger state
      // last-write-wins always treated as the loser's, and it stays that way.
      if (!m || m === b) continue;
      if (b && stable(m) === stable(b)) continue;
      byKey.set(k, m);
      changed = true;
    }
    if (!changed) return base;
    const signals = Array.from(byKey.values());
    return { ...base, signals, confidence: layerConfidence(signals) };
  }

  /** Merge two `layers` maps. Returns `base` itself when nothing changes. */
  function mergeLayers(base, other) {
    if (!other || typeof other !== 'object') return base;
    if (!base || typeof base !== 'object') return other;
    let out = null;
    for (const id of Object.keys(other)) {
      const m = mergeLayer(base[id], other[id]);
      if (m !== base[id]) { out = out || { ...base }; out[id] = m; }
    }
    return out || base;
  }

  /**
   * Take each layer's `summary` from `from` where the two copies hold the SAME signals.
   *
   * A summary is derived from signals — only the extension renders it (reconcile.js), and it
   * re-renders after a sync merge. So where the signals agree, the rendered copy is the right one
   * and a stale copy is just stale. Without this the copies never converged: the phone kept the
   * summary of an older merge, every popup open saw "a change" in it, wrote, re-rendered and wrote
   * again — the flash loop, and the live sync behind it never ran (review, 2026-09-30).
   *   extension merge: from = its own layers (it rendered them);
   *   phone merge:     from = the browser's deposit (the phone never renders).
   * Returns `layers` itself when nothing is adopted.
   */
  function adoptSummaries(layers, from) {
    if (!layers || !from || typeof layers !== 'object' || typeof from !== 'object') return layers;
    let out = null;
    for (const id of Object.keys(layers)) {
      const a = layers[id], b = from[id];
      if (!a || !b || typeof b.summary !== 'string' || a.summary === b.summary) continue;
      if (stable(a.signals || []) !== stable(b.signals || [])) continue;
      out = out || { ...layers };
      out[id] = { ...a, summary: b.summary };
    }
    return out || layers;
  }

  /**
   * Were two fingerprints' summaries rendered under the same RULES? A summary withholds dimensions
   * that an authored rule governs or an open conflict contests (reconcile.js). Identical signals
   * therefore render DIFFERENT summaries when the rules differ, and adopting one rendered without a
   * rule the other copy holds would leak the dimension that rule governs (review, 2026-09-30). The
   * callers adopt summaries only when this holds.
   */
  function summaryContextMatches(a, b) {
    if (!a || !b) return false;
    return stable(a.standing_rules || []) === stable(b.standing_rules || []) &&
      stable(a.conflict_records || []) === stable(b.conflict_records || []);
  }

  /** Every source id that has contributed evidence anywhere in a fingerprint, with its context. */
  function contributingSources(fp) {
    const out = {};
    const layers = (fp && fp.layers) || {};
    for (const id of Object.keys(layers)) {
      for (const s of (layers[id] && layers[id].signals) || []) {
        const bs = s && s.ledger && s.ledger.by_source;
        if (!bs) continue;
        for (const src of Object.keys(bs)) {
          if (!out[src]) out[src] = { context: null };
          if (bs[src] && bs[src].context) out[src].context = bs[src].context;
        }
      }
    }
    return out;
  }

  return {
    CONFIDENCE_CAP, sigKey, isLedgered, attribute, aggregate, normalize, mergeSignalCopies,
    mergeLayer, mergeLayers, adoptSummaries, summaryContextMatches, contributingSources, stable,
  };
});
