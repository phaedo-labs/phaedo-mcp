// Phaedo — calibration reliability curve (build-now tier, slice 2).
//
// agreement.js answers "how often was the oracle right, per domain." This answers a
// DIFFERENT and (per the design thread) more important question: is the oracle's
// CONFIDENCE honest? When it says 0.8, does that decision actually hold ~80% of the
// time? A well-calibrated 0.6 is worth more to an agent deciding act-vs-escalate than
// an overconfident 0.9. So we bucket decisive consult predictions by confidence band
// and compare the band's MEAN PREDICTED confidence to its REALIZED agreement rate.
//
// PURE: (receipts, opts) -> report. No I/O, no globals — same discipline as
// agreement.js / consult-core.js. Reuses agreement.js's scoring contract (DECISIVE
// signals + agrees()) so "right" means exactly what it means there.
//
// DELIBERATELY NOT WIRED to anything. This is a READOUT (`npm run calibration`).
// Recalibrating confidence or auto-adjusting deference from this curve is a product
// decision for a later session (closing the loop), not an engineering default.
//
// Metric: for each scored receipt (decisive signal + known user_action, in window),
// bucket by response.confidence into equal-width bins. Per bin:
//   predicted_mean = mean(confidence),  realized_rate = agreements / scored,
//   gap = predicted_mean - realized_rate   (positive = OVERconfident).
// Expected Calibration Error (ECE) = sum over bins of (bin_scored/total_scored)·|gap|.
// A low ECE means the numbers can be trusted as probabilities.

import { DECISIVE, DEFAULT_WINDOW_DAYS } from './agreement.js';

function agrees(signal, userAction) {
  if (userAction === 'approved') return signal === 'proceed' || signal === 'proceed_with_note';
  if (userAction === 'rejected') return signal === 'decline';
  return false; // 'modified' — not accepted as-judged
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// (receipts, { windowDays, bins, now }) -> {
//   window: { days, since, now, total_receipts, in_window },
//   scored, ece,
//   bins: [ { lo, hi, scored, agreements, predicted_mean, realized_rate, gap } ],
// }
// ece / a bin's realized_rate are null when nothing was scored (no data ≠ 0%).
export function computeCalibration(receipts, { windowDays = DEFAULT_WINDOW_DAYS, bins = 5, now = Date.now() } = {}) {
  const nBins = Math.max(1, Math.floor(bins));
  const since = now - windowDays * 24 * 60 * 60 * 1000;
  const slot = (conf) => Math.min(nBins - 1, Math.floor(clamp01(conf) * nBins)); // 1.0 → last bin
  const table = Array.from({ length: nBins }, (_, i) => ({
    lo: Math.round((i / nBins) * 100) / 100,
    hi: Math.round(((i + 1) / nBins) * 100) / 100,
    scored: 0, agreements: 0, _confSum: 0, predicted_mean: null, realized_rate: null, gap: null,
  }));
  let inWindow = 0, totalScored = 0;

  for (const r of Array.isArray(receipts) ? receipts : []) {
    const t = Date.parse(r?.created_at);
    if (!Number.isFinite(t) || t < since || t > now) continue;
    inWindow++;
    const signal = r.response?.signal;
    const action = r.user_action;
    const conf = r.response?.confidence;
    if (!DECISIVE.includes(signal)) continue;                 // non-directional: no prediction to calibrate
    if (action == null || action === 'unknown') continue;     // not yet scorable
    if (typeof conf !== 'number' || !Number.isFinite(conf)) continue;
    const b = table[slot(conf)];
    b.scored++; b._confSum += clamp01(conf);
    if (agrees(signal, action)) b.agreements++;
    totalScored++;
  }

  let eceSum = 0;
  for (const b of table) {
    if (b.scored > 0) {
      b.predicted_mean = Math.round((b._confSum / b.scored) * 1000) / 1000;
      b.realized_rate = Math.round((b.agreements / b.scored) * 1000) / 1000;
      b.gap = Math.round((b.predicted_mean - b.realized_rate) * 1000) / 1000;
      eceSum += (b.scored / totalScored) * Math.abs(b.predicted_mean - b.realized_rate);
    }
    delete b._confSum;
  }

  return {
    window: { days: windowDays, since: new Date(since).toISOString(), now: new Date(now).toISOString(), total_receipts: Array.isArray(receipts) ? receipts.length : 0, in_window: inWindow },
    scored: totalScored,
    ece: totalScored > 0 ? Math.round(eceSum * 1000) / 1000 : null,
    bins: table,
  };
}

// ── Dev CLI: `node calibration.js [windowDays] [bins]` / `npm run calibration` ──
// Local readout only — decrypts the local receipt store with the local key; nothing
// leaves the device. NOT product UX, NOT fed back into confidence/deference.
if (process.argv[1] && process.argv[1].endsWith('calibration.js')) {
  const days = Number(process.argv[2]) || DEFAULT_WINDOW_DAYS;
  const nBins = Number(process.argv[3]) || 5;
  Promise.all([import('./receipts.js'), import('./cache.js')]).then(async ([{ readReceipts }, { defaultStateDir }]) => {
    const report = computeCalibration(await readReceipts(defaultStateDir()), { windowDays: days, bins: nBins });
    const { window: w } = report;
    console.log(`Calibration over the last ${w.days}d — ${report.scored} scored of ${w.in_window}/${w.total_receipts} receipts in window`);
    console.log(`ECE (expected calibration error): ${report.ece === null ? '  —  ' : report.ece.toFixed(3)}  (lower = confidence is honest)\n`);
    console.log('band          scored  predicted  realized   gap');
    for (const b of report.bins) {
      const f = (x) => x === null ? '   —  ' : (x * 100).toFixed(0).padStart(4) + '%';
      const gap = b.gap === null ? '   —  ' : (b.gap > 0 ? '+' : '') + (b.gap * 100).toFixed(0) + '%';
      console.log(`${(b.lo.toFixed(1) + '–' + b.hi.toFixed(1)).padEnd(12)}  ${String(b.scored).padStart(5)}   ${f(b.predicted_mean)}     ${f(b.realized_rate)}   ${gap.padStart(6)}`);
    }
    if (report.scored === 0) console.log('\nNo scored decisive receipts yet — set user_action as you accept/reject agent actions.');
    else console.log('\npositive gap = overconfident (predicted > realized); negative = underconfident.');
  }).catch((e) => { console.error(`calibration: ${e.message}`); process.exit(1); });
}
