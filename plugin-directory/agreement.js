// Phaedo — agreement tracking FOUNDATION (build brief M5).
//
// Given the §10.6 receipt store, compute the per-domain AGREEMENT RATE: how often
// the oracle's decisive signal matched what the subject actually did
// (`user_action`), over a sliding time window. This is the minimal data layer for
// the delegation gradient and the seed of the native persona benchmark
// (docs/architecture/agreement-metric.md).
//
// PURE: (receipts, opts) -> report. No I/O, no globals, no side effects — the
// same discipline as consult-core.js. Reading the store happens in the caller
// (CLI below / harness); receipts are data here.
//
// DELIBERATELY NOT WIRED to deference_level. Closing the loop (high agreement →
// auto-raise deference) is a product decision for a later session, not an
// engineering default (brief M5 step 2). Dev-only readout: `npm run agreement`.
//
// Metric definition v0 (full rationale in docs/architecture/agreement-metric.md):
//   - Only receipts with a known user_action count (`approved|rejected|modified`;
//     `unknown`/null are recorded but excluded from the rate).
//   - Only DECISIVE signals are scored: proceed / proceed_with_note / decline.
//     escalate, clarify, and insufficient_signal hand the decision to a human or
//     defer — they make no outcome prediction, so "agreement" is undefined for
//     them; they are counted separately as non_directional.
//   - Agreement: proceed|proceed_with_note ↔ approved; decline ↔ rejected.
//     `modified` counts as DISAGREEMENT for every decisive signal (the subject
//     did not accept the action as-judged). Conservative on purpose: it
//     understates agreement rather than overstating delegation safety.
//   - Domain key: action_descriptor.domain, lowercased; null → "(none)".

export const DECISIVE = ['proceed', 'proceed_with_note', 'decline'];
export const DEFAULT_WINDOW_DAYS = 30;

function agrees(signal, userAction) {
  if (userAction === 'approved') return signal === 'proceed' || signal === 'proceed_with_note';
  if (userAction === 'rejected') return signal === 'decline';
  return false; // 'modified' — the action was not accepted as-judged
}

// (receipts, { windowDays, now }) -> {
//   window: { days, since, now, total_receipts, in_window },
//   overall: { scored, agreements, disagreements, rate, non_directional, awaiting_user_action },
//   domains: { [domain]: same-shape-as-overall },
// }
// `rate` is null when nothing was scored (no data ≠ 0% agreement).
export function computeAgreement(receipts, { windowDays = DEFAULT_WINDOW_DAYS, now = Date.now() } = {}) {
  const since = now - windowDays * 24 * 60 * 60 * 1000;
  const bucket = () => ({ scored: 0, agreements: 0, disagreements: 0, rate: null, non_directional: 0, awaiting_user_action: 0 });
  const overall = bucket();
  const domains = {};
  let inWindow = 0;

  for (const r of Array.isArray(receipts) ? receipts : []) {
    const t = Date.parse(r?.created_at);
    if (!Number.isFinite(t) || t < since || t > now) continue;
    inWindow++;
    const domain = (r.request?.action_descriptor?.domain || '(none)').toLowerCase();
    const d = (domains[domain] ||= bucket());
    const signal = r.response?.signal;
    const action = r.user_action;

    for (const b of [overall, d]) {
      if (!DECISIVE.includes(signal)) { b.non_directional++; continue; }
      if (action == null || action === 'unknown') { b.awaiting_user_action++; continue; }
      b.scored++;
      if (agrees(signal, action)) b.agreements++; else b.disagreements++;
    }
  }

  for (const b of [overall, ...Object.values(domains)]) {
    if (b.scored > 0) b.rate = Math.round((b.agreements / b.scored) * 1000) / 1000;
  }

  return {
    window: { days: windowDays, since: new Date(since).toISOString(), now: new Date(now).toISOString(), total_receipts: Array.isArray(receipts) ? receipts.length : 0, in_window: inWindow },
    overall,
    domains,
  };
}

// ── Split by resolver revision (precedent track Phase 1b) ─────────────────────
// Which engine answered a receipt: the `resolverRevision` driver the consult stamped (the
// rules' RESOLVER_REVISION, or `judge:<model>`). A matched pre-flight is a standing rule
// answering, not the inferred path. Anything else predates the stamp (2026-10-20) or carried
// no inferred prediction (an abstain) — "not recorded", never guessed.
export const NOT_RECORDED = 'not recorded';
export function revisionOf(r) {
  const d = Array.isArray(r?.drivers) ? r.drivers.find((x) => x?.cue === 'resolverRevision') : null;
  if (d && typeof d.value === 'string' && d.value) return d.value;
  if (r?.via === 'phaedo_check_authorization') return 'standing rule (pre-flight)';
  return NOT_RECORDED;
}

/**
 * (receipts, { windowDays, now }) -> { [revision]: overall-bucket }, so a behaviour change
 * shows up as two rates instead of one blurred one. Same scoring as computeAgreement.
 */
export function computeAgreementByRevision(receipts, { windowDays = DEFAULT_WINDOW_DAYS, now = Date.now() } = {}) {
  const groups = new Map();
  for (const r of Array.isArray(receipts) ? receipts : []) {
    const k = revisionOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = {};
  for (const [k, rs] of groups) {
    const rep = computeAgreement(rs, { windowDays, now });
    if (rep.window.in_window > 0) out[k] = rep.overall;
  }
  return out;
}

// ── The transportable summary (receipts digest → phone) ───────────────────────
// `computeAgreement` is the full local report; this is the bounded slice that rides
// the `agent_to_phone` receipts digest so the subject can see how well their oracle
// is tracking them, per domain, without opening a terminal.
//
// It is derived ENTIRELY from the subject's own receipts and only ever travels
// between the subject's own devices (ciphertext over the relay), so it raises no
// §10.4 question — but it still carries no layer content, no rationale, and no
// `drivers`: counts and a rate, nothing else.
//
// Bounded on purpose (the digest is a last-write-wins payload, so it must not grow
// without limit): unscored domains are dropped (a domain with nothing scored says
// nothing), the rest are ranked by `scored` and capped. Ties break by name so the
// payload is DETERMINISTIC — an unstable key order would make every deposit look
// like a change.
export const DIGEST_DOMAIN_CAP = 8;

const slimBucket = (b) => ({
  rate: b.rate,
  scored: b.scored,
  agreements: b.agreements,
  disagreements: b.disagreements,
  non_directional: b.non_directional,
  awaiting_user_action: b.awaiting_user_action,
});

// (receipts, { windowDays, now, domainCap }) -> { window_days, overall, domains }
export function agreementDigest(receipts, { windowDays = DEFAULT_WINDOW_DAYS, now = Date.now(), domainCap = DIGEST_DOMAIN_CAP } = {}) {
  const report = computeAgreement(receipts, { windowDays, now });
  const domains = {};
  Object.entries(report.domains)
    .filter(([, b]) => b.scored > 0)
    .sort((a, b) => (b[1].scored - a[1].scored) || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, domainCap))
    .forEach(([name, b]) => { domains[name] = slimBucket(b); });
  return { window_days: windowDays, overall: slimBucket(report.overall), domains };
}

// ── Dev CLI: `node agreement.js` / `npm run agreement` — local readout only ───
// Decrypts the local receipt store with the local key; nothing leaves the device.
// NOT product UX and NOT fed back into deference (see header).
if (process.argv[1] && process.argv[1].endsWith('agreement.js')) {
  const args = process.argv.slice(2);
  const byRevision = args.includes('--by-revision');
  const days = Number(args.find((a) => /^\d+$/.test(a))) || DEFAULT_WINDOW_DAYS;
  Promise.all([import('./receipts.js'), import('./cache.js')]).then(async ([{ readReceipts }, { defaultStateDir }]) => {
    const receipts = await readReceipts(defaultStateDir());
    if (byRevision) {
      const split = computeAgreementByRevision(receipts, { windowDays: days });
      console.log(`Agreement by rule-engine version — last ${days}d\n`);
      const names = Object.keys(split).sort((a, b) => (a === NOT_RECORDED) - (b === NOT_RECORDED) || a.localeCompare(b));
      if (!names.length) console.log('No receipts in the window.');
      for (const k of names) {
        const b = split[k];
        console.log(`${k.padEnd(34)} rate ${b.rate === null ? '  —  ' : (b.rate * 100).toFixed(1) + '%'}  (${b.agreements}✓ ${b.disagreements}✗ of ${b.scored} scored · ${b.non_directional} non-directional · ${b.awaiting_user_action} awaiting)`);
      }
      return;
    }
    const report = computeAgreement(receipts, { windowDays: days });
    const { overall: o, window: w } = report;
    console.log(`Agreement over the last ${w.days}d — ${w.in_window}/${w.total_receipts} receipts in window\n`);
    const line = (label, b) =>
      console.log(`${label.padEnd(22)} rate ${b.rate === null ? '  —  ' : (b.rate * 100).toFixed(1) + '%'}  (${b.agreements}✓ ${b.disagreements}✗ of ${b.scored} scored · ${b.non_directional} non-directional · ${b.awaiting_user_action} awaiting user_action)`);
    line('OVERALL', o);
    for (const [dom, b] of Object.entries(report.domains).sort()) line(`  ${dom}`, b);
    if (o.scored === 0) console.log('\nNo scored receipts yet — set user_action on receipts as you accept/reject agent actions.');
  }).catch((e) => { console.error(`agreement: ${e.message}`); process.exit(1); });
}
