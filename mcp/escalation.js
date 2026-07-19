// Real-time escalation client (MCP → relay → subject's device → back).
//
// The delivery channel the act-as-me endgame needs once agents act AUTONOMOUSLY for
// the subject (docs/roadmap/escalation-and-push.md). When a consult returns a
// process-BLOCKING signal — `escalate` (or `clarify`) — and the agent is running
// unattended, there is no one at the agent's conversation to answer. This routes the
// decision to the subject's phone in real time, waits within a bounded window, and
// returns approve / deny / modify so the agent can resume — or applies the SAFE
// DEFAULT when the window lapses (an `escalate` means "hold for a human", so the
// no-response default is do-not-proceed, never a guess).
//
// §10.4 boundary on the wire: the escalation payload carries the ACTION under
// question (the agent's own descriptor) + the consult's `signal`/`rationale_hint` —
// NEVER fingerprint layer content. And even that is sealed under fp_sync_key (the
// same HKDF(pair_key) key the delegation deposit uses), so the relay stays
// zero-knowledge: it forwards ciphertext and wakes the device, nothing more.
//
// Honesty rail (roadmap Q7): a real-time approve/deny IS an outcome — the strongest
// possible act-as-me signal. The orchestrator returns a `record_outcome` mapping
// (approve→approved, deny→rejected, modify→modified) so the SAME §10.6 receipt +
// override-learning loop picks it up automatically. A TIMEOUT is "no answer", not an
// override — it maps to `unknown` and teaches nothing.

import { Phaedo, b64uDec } from './lib/phaedo-crypto.js';

const { Kdf, Envelope } = Phaedo;
const DEFAULT_RELAY = 'https://phaedo-relay.fly.dev';

export function relayBaseFromEnv(env = process.env) {
  return env.PHAEDO_RELAY || DEFAULT_RELAY;
}

// The Authorization header for relay HTTP routes (relay/auth.js per-device bearer).
// Without this, deposit/poll return 401. A pairing without a relay_device_secret (e.g.
// from an older mobile build that predates the auth layer) gets no header — relay 401s,
// which surfaces as deposit-failed-401 from the orchestrator.
function relayAuthHeader(pairing) {
  if (!pairing || !pairing.relay_device_id || !pairing.relay_device_secret) return {};
  return { Authorization: `Bearer ${pairing.relay_device_id}:${pairing.relay_device_secret}` };
}

// Which consult signals are BLOCKING enough to WAKE the subject (roadmap Q1). The two
// blocking signals are not equal:
//   - `escalate` = "hold for a live human go/no-go on a consequential call." Blocking by
//     definition → ALWAYS push.
//   - `clarify` = "I need more info before acting." This is the agent's default reflex
//     when uncertain, so it fires often, including on low-stakes calls. Waking the phone
//     for every clarify would cry wolf — so push a clarify ONLY when the action is also
//     CONSEQUENTIAL (irreversible OR high magnitude). Below that bar an autonomous agent
//     should resolve the clarify itself (ask in-flow / state a reasonable assumption) and
//     it surfaces in the deferred review queue — no interruption.
// Unknown stakes (no descriptor) reads as low-stakes for clarify: the agent can always
// raise an explicit `escalate` when it really needs the subject. Ultimately this whole
// policy is subject-configurable via a standing rule; this is the sensible default.
export function isConsequential(actionDescriptor = {}) {
  const ad = actionDescriptor || {};
  return ad.reversible === false || ad.magnitude === 'high';
}

// ── Subject-configurable push policy (the standing knob) ───────────────────────
// The stakes-gated default above is just that — a default. A subject can override how
// `clarify` is pushed, globally and per-domain, via an escalation policy that rides the
// vault (portable: `phaedo_fingerprint.escalation_policy`, syncs across devices) and/or a
// local file (`PHAEDO_ESCALATION_POLICY`, for power users / testing) — the same dual home
// as consult policies (`consult-policy.js`). Shape:
//   { "clarify": { "default": "always" | "consequential" | "never",
//                  "by_domain": { "financial": "always", "writing": "never" } } }
// `escalate` is deliberately NOT configurable: it means "a human is needed", so suppressing
// the wake would strand a blocking decision — it always pushes. Only `clarify` is tunable.
const CLARIFY_MODES = new Set(['always', 'consequential', 'never']);

// Merge policy sources (later wins; `by_domain` deep-merged, `default` shallow-overridden).
// Defensive: ignores malformed entries and unknown modes. Never throws.
export function mergeEscalationPolicy(...sources) {
  const clarify = { default: undefined, by_domain: {} };
  for (const s of sources) {
    const c = s && typeof s === 'object' ? s.clarify : null;
    if (!c || typeof c !== 'object') continue;
    if (typeof c.default === 'string' && CLARIFY_MODES.has(c.default.toLowerCase())) clarify.default = c.default.toLowerCase();
    if (c.by_domain && typeof c.by_domain === 'object') {
      for (const [k, v] of Object.entries(c.by_domain)) {
        if (typeof v === 'string' && CLARIFY_MODES.has(v.toLowerCase())) clarify.by_domain[String(k).toLowerCase()] = v.toLowerCase();
      }
    }
  }
  return { clarify };
}

// Resolve the effective policy for a consult: the vault-embedded policy (portable) merged
// under the local-file override (`opts.escalationPolicy`). Pure; defensive.
export function loadEscalationPolicy(vd, opts = {}) {
  return mergeEscalationPolicy(vd?.phaedo_fingerprint?.escalation_policy, opts.escalationPolicy);
}

// The clarify push mode for an action under a policy: a per-domain override (substring
// match, either direction — same convention as consult domains) wins over the default,
// which falls back to the built-in 'consequential'.
export function resolveClarifyMode(actionDescriptor = {}, policy = null) {
  const c = policy && policy.clarify;
  if (!c) return 'consequential';
  const domain = String(actionDescriptor?.domain || '').toLowerCase();
  if (domain && c.by_domain) {
    for (const [k, mode] of Object.entries(c.by_domain)) {
      if (!CLARIFY_MODES.has(mode)) continue;
      if (domain.includes(k) || k.includes(domain)) return mode;
    }
  }
  return CLARIFY_MODES.has(c.default) ? c.default : 'consequential';
}

// Does this signal WAKE the subject? `escalate` always; `clarify` per the policy
// (`always` | `never` | `consequential` = irreversible/high-magnitude). Backward
// compatible: with no policy, clarify falls back to the stakes-gated default.
export function shouldEscalate(signal, actionDescriptor = {}, policy = null) {
  const s = String(signal);
  if (s === 'escalate') return true;
  if (s === 'clarify') {
    const mode = resolveClarifyMode(actionDescriptor, policy);
    return mode === 'always' ? true : mode === 'never' ? false : isConsequential(actionDescriptor);
  }
  return false;
}

// The decision vocabulary the phone returns, mapped to the §10.6 receipt user_action.
const DECISION_OUTCOME = { approve: 'approved', deny: 'rejected', modify: 'modified' };

// Build the §10.4-safe escalation payload from the consult request + its response.
// PURE. Pulls ONLY the agent's own action descriptor + the constrained consult
// signal/rationale — no vault data is in scope here at all. Truncates free text so a
// runaway descriptor can't bloat the (encrypted) wire payload.
export function buildEscalationPayload(consultRequest = {}, consultResponse = {}) {
  const ad = (consultRequest.action_descriptor && typeof consultRequest.action_descriptor === 'object') ? consultRequest.action_descriptor : {};
  const clip = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : undefined);
  return {
    consultation_type: typeof consultRequest.consultation_type === 'string' ? consultRequest.consultation_type : undefined,
    agent_id: clip(consultRequest.agent_id, 120),
    action: {
      domain: clip(ad.domain, 80),
      summary: clip(ad.summary, 280),
      magnitude: ['low', 'medium', 'high'].includes(ad.magnitude) ? ad.magnitude : undefined,
      reversible: typeof ad.reversible === 'boolean' ? ad.reversible : undefined,
      amount: typeof ad.amount === 'number' && isFinite(ad.amount) ? ad.amount : undefined,
    },
    signal: clip(consultResponse.signal, 40),
    rationale_hint: clip(consultResponse.rationale_hint, 280),
  };
}

// Seal the payload under fp_sync_key into the deposit body { request_id, envelope,
// window_ms }. PURE crypto (no network) so the round-trip is testable in isolation,
// mirroring delegation-sync.js buildDelegationDeposit.
export async function buildEscalationDeposit(pairKeyB64u, requestId, payload, { windowMs, now = () => new Date().toISOString() } = {}) {
  const pairKey = b64uDec(pairKeyB64u);
  let fpSyncKey;
  try {
    fpSyncKey = await Kdf.deriveFpSyncKey(pairKey);
  } finally {
    pairKey.fill(0);
  }
  try {
    const inner = { kind: 'escalation_request', request_id: requestId, data: payload };
    const plaintext = new TextEncoder().encode(JSON.stringify(inner));
    const envelope = await Envelope.wrap(plaintext, fpSyncKey, { artifact_kind: 'escalation_request', created_at: now() });
    plaintext.fill(0);
    return { request_id: requestId, envelope, ...(windowMs ? { window_ms: windowMs } : {}) };
  } finally {
    if (fpSyncKey && fpSyncKey.fill) fpSyncKey.fill(0);
  }
}

// Decrypt the subject's decision (the phone's response body { envelope }) under
// fp_sync_key. Returns the inner { decision, note?, modified? } or null on any
// failure (a malformed/forged response must never crash the agent's resume path).
export async function unwrapEscalationResponse(pairKeyB64u, body) {
  if (!body || !body.envelope) return null;
  const pairKey = b64uDec(pairKeyB64u);
  let fpSyncKey;
  try {
    fpSyncKey = await Kdf.deriveFpSyncKey(pairKey);
  } catch { pairKey.fill(0); return null; }
  pairKey.fill(0);
  try {
    const plaintext = await Envelope.unwrap(body.envelope, fpSyncKey);
    const inner = JSON.parse(new TextDecoder().decode(plaintext));
    if (inner && inner.kind === 'escalation_response' && inner.data) return inner.data;
    return null;
  } catch {
    return null;
  } finally {
    if (fpSyncKey && fpSyncKey.fill) fpSyncKey.fill(0);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function genRequestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `esc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── Non-blocking deposit + single-poll (for the MCP tools) ─────────────────────
// A multi-minute BLOCKING tool call is hostile to MCP clients (many time out), so the
// agent-facing tools use a two-call shape: phaedo_escalate deposits + wakes the device
// and returns immediately; phaedo_escalation_status polls once. The agent decides when
// to stop waiting; the safe default once it gives up is HOLD (do-not-proceed).

// Deposit the (encrypted) decision request and wake the device. Returns
// { deposited, request_id, window_ms, expires_at } or { deposited:false, reason }.
// Never throws.
export async function depositEscalation(pairing, consultRequest, consultResponse, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const signal = consultResponse && consultResponse.signal;
  if (!pairing || !pairing.pair_key) return { deposited: false, reason: 'unpaired', signal };
  if (!pairing.relay_device_id) return { deposited: false, reason: 'no-relay-device-id', signal };
  const windowMs = Math.max(1000, Number(deps.windowMs) || 3 * 60 * 1000);
  const relayBase = deps.relayBase || relayBaseFromEnv();
  const requestId = deps.requestId || genRequestId();
  try {
    const body = await buildEscalationDeposit(pairing.pair_key, requestId, buildEscalationPayload(consultRequest, consultResponse), { windowMs });
    const res = await fetchFn(`${relayBase}/escalation/${encodeURIComponent(pairing.relay_device_id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...relayAuthHeader(pairing) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.depositTimeoutMs || 8000),
    });
    if (!res || !res.ok) return { deposited: false, reason: `deposit-failed-${res && res.status}`, request_id: requestId, signal };
    let info = {};
    try { info = await res.json(); } catch { /* body optional */ }
    return { deposited: true, request_id: requestId, window_ms: windowMs, expires_at: info.expires_at, woke: info.woke, signal };
  } catch (e) {
    return { deposited: false, reason: `deposit-error:${String(e && e.message || e)}`, request_id: requestId, signal };
  }
}

// Poll ONCE for a decision. Returns { resolved:true, decision, proceed, outcome, note?,
// modified? } when answered, { resolved:false, status:'pending' } while waiting, or
// { resolved:false, status:'expired' } once the agent's deadline has passed (the caller
// then applies the safe-default hold). Never throws.
export async function pollEscalationOnce(pairing, requestId, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  if (!pairing || !pairing.pair_key || !requestId) return { resolved: false, status: 'expired', reason: 'bad-args' };
  if (deps.expiresAt && (deps.now ? deps.now() : Date.now()) > deps.expiresAt) return { resolved: false, status: 'expired' };
  const relayBase = deps.relayBase || relayBaseFromEnv();
  let body = null;
  try {
    const res = await fetchFn(`${relayBase}/escalation/response/${encodeURIComponent(requestId)}`, {
      headers: relayAuthHeader(pairing),
      signal: AbortSignal.timeout(deps.pollTimeoutMs || 8000),
    });
    if (res && res.ok) body = await res.json();
  } catch { /* transient */ }
  if (!body) return { resolved: false, status: 'pending' };
  const data = await unwrapEscalationResponse(pairing.pair_key, body);
  if (!data || !DECISION_OUTCOME[data.decision]) return { resolved: false, status: 'pending' };
  return {
    resolved: true,
    decision: data.decision,
    proceed: data.decision !== 'deny',
    note: typeof data.note === 'string' ? data.note : undefined,
    modified: data.decision === 'modify' ? (data.modified ?? null) : undefined,
    outcome: DECISION_OUTCOME[data.decision],
    request_id: requestId,
  };
}

// The SAFE DEFAULT applied when the window lapses with no answer (roadmap §crux).
// `escalate` already means "hold for a human", so absent a decision the agent must
// NOT proceed — it holds. A timeout is not an override, so it teaches nothing
// (outcome 'unknown'). Returned in the same shape as a real decision so the caller
// has one code path.
function safeDefault(signal) {
  return {
    decision: 'hold',
    resolved: false,
    reason: 'timeout',
    proceed: false,                 // do-not-proceed is the safe default for a blocking escalate/clarify
    outcome: 'unknown',             // no answer ⇒ no act-as-me signal
    signal,
  };
}

// Orchestrate one real-time escalation: deposit → poll within the window → decision
// or safe-default. Best-effort and self-contained — every failure path resolves to a
// safe-default rather than throwing into the agent. `deps.fetch`, `deps.sleep`,
// `deps.now`, `deps.pollMs`, `deps.windowMs`, `deps.relayBase` are injectable for tests.
//
//   pairing            : { pair_key, relay_device_id } (loadPairingRecord)
//   consultRequest     : the args passed to phaedo_consult
//   consultResponse    : the §10.3 response it returned (must be escalate/clarify)
// Returns:
//   { resolved, decision, proceed, note?, outcome, request_id, signal, reason? }
export async function requestEscalationDecision(pairing, consultRequest, consultResponse, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const wait = deps.sleep || sleep;
  const now = deps.now || (() => Date.now());
  const signal = consultResponse && consultResponse.signal;

  if (!pairing || !pairing.pair_key) return { ...safeDefault(signal), reason: 'unpaired' };
  if (!pairing.relay_device_id) return { ...safeDefault(signal), reason: 'no-relay-device-id' };

  const windowMs = Math.max(1000, Number(deps.windowMs) || 3 * 60 * 1000);
  const pollMs = Math.max(250, Number(deps.pollMs) || 3000);
  const relayBase = deps.relayBase || relayBaseFromEnv();
  const requestId = deps.requestId || genRequestId();

  // 1. Deposit the (encrypted) decision request; the relay wakes the device.
  try {
    const body = await buildEscalationDeposit(pairing.pair_key, requestId, buildEscalationPayload(consultRequest, consultResponse), { windowMs });
    const res = await fetchFn(`${relayBase}/escalation/${encodeURIComponent(pairing.relay_device_id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...relayAuthHeader(pairing) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.depositTimeoutMs || 8000),
    });
    if (!res || !res.ok) return { ...safeDefault(signal), reason: `deposit-failed-${res && res.status}`, request_id: requestId };
  } catch (e) {
    return { ...safeDefault(signal), reason: `deposit-error:${String(e && e.message || e)}`, request_id: requestId };
  }

  // 2. Poll for the decision until the window lapses.
  const deadline = now() + windowMs;
  const pollUrl = `${relayBase}/escalation/response/${encodeURIComponent(requestId)}`;
  while (now() < deadline) {
    await wait(pollMs);
    let body = null;
    try {
      const res = await fetchFn(pollUrl, { headers: relayAuthHeader(pairing), signal: AbortSignal.timeout(deps.pollTimeoutMs || 8000) });
      if (res && res.ok) body = await res.json();
    } catch { /* transient — keep polling */ }
    if (!body) continue;
    const data = await unwrapEscalationResponse(pairing.pair_key, body);
    if (!data || !DECISION_OUTCOME[data.decision]) continue;   // ignore unparseable/unknown decisions; keep waiting
    return {
      resolved: true,
      decision: data.decision,
      proceed: data.decision !== 'deny',
      note: typeof data.note === 'string' ? data.note : undefined,
      modified: data.decision === 'modify' ? (data.modified ?? null) : undefined,
      outcome: DECISION_OUTCOME[data.decision],
      request_id: requestId,
      signal,
    };
  }
  // 3. Window lapsed — safe default (hold; no learning).
  return { ...safeDefault(signal), request_id: requestId };
}
