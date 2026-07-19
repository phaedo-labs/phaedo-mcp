// Phaedo §10 Agent Consultation — MCP-binding wrapper around the pure resolver.
//
// The deterministic resolver lives in consult-core.js (PURE: (vd,request)->response,
// no model/transport/IO). This module adds the OPTIONAL local model judge and the
// env config, and re-exports the core entry. Deterministic shapes in the core +
// model/transport here keeps the open-core line a FILE boundary (brief Invariant 7):
// the core is the publishable reference resolver; the judge is the proprietary-side
// upgrade. Any judge failure/timeout/parse-error falls back to the core, so the
// model can only improve on — never break — the deterministic floor. Honors §10.4
// (response carries only signals, never layer content).

import { buildInjectionResponse } from './projection.js';
import { loadPolicies, applyPolicies } from './consult-policy.js';
import { PhaedoError } from './errors.js';
import {
  resolveConsultationCore, buildConsultationResponse, checkAuthorization, normalizeRequest,
  shape, SIGNALS, CONSULTATION_TYPES, validateVaultShape, consultDrivers,
  deriveDelegationSignals, withDelegationSignals, buildDelegationPromotions, DELEGATION_PROMOTION_FLOOR,
  authoredDelegationSignals,
} from './consult-core.js';

// Re-export the core surface so existing importers (server.js, tests,
// spec/test-schemas.mjs) keep their `from './consult.js'` paths.
export { CONSULTATION_TYPES, buildConsultationResponse, resolveConsultationCore, checkAuthorization, validateVaultShape, consultDrivers, deriveDelegationSignals, withDelegationSignals, buildDelegationPromotions, DELEGATION_PROMOTION_FLOOR, authoredDelegationSignals };

// ── Model resolver (richest fingerprint, LOCAL compute — opt-in) ──────────────
// When a local model is configured (PHAEDO_CONSULT_MODEL + an Ollama/OpenAI-
// compatible endpoint), the judge reasons over the FULL projection — the richest
// on-device context — and returns a §10.3 signal. The model sees the fingerprint
// only on-device (same trust boundary as the WebLLM extraction); the §10.4
// boundary on the OUTPUT is enforced on parse (only the signal fields cross).
const JUDGE_SYSTEM =
  'You are the user’s decision proxy. Given their cognitive fingerprint and a pending action, ' +
  'judge how THEIR pattern bears on it — not your own opinion. Reply with STRICT JSON only:\n' +
  '{"signal": "...", "confidence": 0.0, "rationale_hint": "...", "deference_level": "..."}\n' +
  'signal ∈ proceed | proceed_with_note | clarify | escalate | decline | insufficient_signal ' +
  '(use insufficient_signal only when the fingerprint truly does not speak to this). ' +
  'deference_level ∈ high | medium | low (how strongly to weight this; sparse fingerprint → low). ' +
  'rationale_hint: ONE short sentence describing the user’s PATTERN — never quote or dump their profile text. ' +
  'Output ONLY the JSON object, no prose.';

function parseJudge(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in model output');
  const o = JSON.parse(m[0]);
  if (!SIGNALS.includes(o.signal)) throw new Error(`bad signal: ${o.signal}`);
  if (typeof o.rationale_hint !== 'string' || !o.rationale_hint.trim()) throw new Error('missing rationale_hint');
  return o;
}

async function modelJudge(vd, n, opts) {
  const projection = buildInjectionResponse(vd, { requested_layers: ['all'], mode: 'standard' }).projection;
  const decision = {
    consultation_type: n.type,
    domain: n.domain, reversible: n.reversible, magnitude: n.magnitude,
    evidence_provided: n.evidenceProvided,
    summary: (n.summary || undefined),
  };
  const user = `# The user's cognitive fingerprint\n${projection}\n\n# Pending decision\n${JSON.stringify(decision, null, 2)}`;
  const body = {
    model: opts.model,
    messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: user }],
    temperature: 0.2,
    stream: false,
  };
  const res = await fetch(`${opts.modelUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs || 15000),
  });
  if (!res.ok) throw new Error(`model endpoint ${res.status}`);
  const data = await res.json();
  const out = parseJudge(data?.choices?.[0]?.message?.content || '');
  // §10.4 enforced STRUCTURALLY: the model's free-text rationale_hint is NOT passed
  // through — a misbehaving or prompt-injected judge could otherwise emit verbatim
  // fingerprint/persona text there (the JUDGE_SYSTEM "never quote" line is a request,
  // not enforcement). We keep the model's decision (signal/confidence/deference) and
  // substitute a fixed, persona-free hint keyed to the signal. parseJudge still
  // requires a non-empty rationale_hint so the model must emit well-formed JSON.
  return shape(n.type, out.signal, out.confidence ?? 0.6, MODEL_SAFE_HINT[out.signal] || 'Your decision pattern bears on this action.', out.deference_level);
}

// Persona-free, signal-keyed hints for the model path (see §10.4 note above).
const MODEL_SAFE_HINT = {
  proceed:             'Your decision pattern supports proceeding here.',
  proceed_with_note:   'Your decision pattern supports proceeding, with a light note.',
  clarify:             'Your decision pattern suggests clarifying before acting.',
  escalate:            'Your decision pattern suggests holding for your explicit go-ahead.',
  decline:             'Your decision pattern leans against this action.',
  insufficient_signal: 'Your fingerprint does not clearly speak to this action.',
};

// ── Config + orchestrator ─────────────────────────────────────────────────────
// Local-only by default. `PHAEDO_CONSULT_MODEL` opts INTO the model judge (point
// it at a general chat model in Ollama, e.g. `llama3.1:8b` — NOT the extraction
// fine-tune, which is trained to emit signals, not to reason about decisions).
export function consultOptsFromEnv(env = process.env) {
  return {
    model: env.PHAEDO_CONSULT_MODEL || null,
    modelUrl: env.PHAEDO_CONSULT_MODEL_URL || 'http://localhost:11434',
    apiKey: env.PHAEDO_CONSULT_API_KEY || null, // for an OpenAI-compatible endpoint
    timeoutMs: Number(env.PHAEDO_CONSULT_TIMEOUT_MS) || 15000,
    policies: null, // a loaded policy doc; the server fills this from the policy file
  };
}

// Public async entry: model judge when configured, else the deterministic core.
// voice_draft always takes the (redirect) core path. Authored policies (§10.5)
// override either result, so a standing guardrail always wins. Never throws except
// for §10.2 input errors (request_malformed) and a missing fingerprint
// (decryption_failed).
export async function resolveConsultation(vd, request = {}, opts = {}) {
  if (!vd || !vd.phaedo_fingerprint) {
    throw new PhaedoError('decryption_failed', 'No fingerprint available from the configured source.');
  }
  // vd contract guard (M0.4): reject a type-breached payload BEFORE the model judge
  // sees it — same structured error the deterministic core raises.
  const vdErrors = validateVaultShape(vd);
  if (vdErrors.length) {
    throw new PhaedoError('internal_error', `vault data malformed: ${vdErrors.join('; ')}`);
  }
  const n = normalizeRequest(request);
  if (opts.model && opts.modelUrl && n.type !== 'voice_draft') {
    try {
      const judged = await modelJudge(vd, n, opts);
      // Authored guardrails override the model judge too (applied last so they win).
      return applyPolicies(judged, n, loadPolicies(vd, opts));
    } catch (err) {
      process.stderr.write?.(`[phaedo-consult] model judge fell back to rules: ${err.message}\n`);
    }
  }
  // Deterministic path (the core applies policies itself).
  return resolveConsultationCore(vd, request, opts);
}
