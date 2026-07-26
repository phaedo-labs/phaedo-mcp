#!/usr/bin/env node
// §10.2 action_binding — parse/validate, and its three consumers.
// Run: node test-action-binding.mjs   (from mcp/)
//
// The property under test is narrow and important: a binding is either wholly
// valid or it is an error. There is no "partly bound" state, because a caller
// that believes it is bound while the resolver treats it as unbound would think a
// require_binding authorization is protecting it when nothing is.

import assert from 'node:assert';
import { normalizeActionBinding, isBound, PREVIEW_MAX, TOOL_NAME_MAX } from './action-binding.js';
import { normalizeRequest } from './consult-core.js';
import { buildReceipt } from './receipts.js';
import { buildEscalationPayload } from './escalation.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const throwsMalformed = (fn, m) => {
  try { fn(); } catch (e) { ok(e.code === 'request_malformed', `${m} (code=${e.code})`); return; }
  ok(false, `${m} — expected a throw, got none`);
};

const HASH = 'a'.repeat(64);
const GOOD = { tool_name: 'issue_payment', arguments_hash: HASH, arguments_preview: 'payee=ACME, amount=12000' };

// ── absent is fine; present-but-broken is an error ────────────────────────────
console.log('\nnormalizeActionBinding');
ok(normalizeActionBinding(undefined) === null, 'absent binding → null (unbound requests stay valid)');
ok(normalizeActionBinding(null) === null, 'null binding → null');

for (const bad of [42, 'tool', true, []]) {
  throwsMalformed(() => normalizeActionBinding(bad), `non-object binding ${JSON.stringify(bad)} rejected`);
}
throwsMalformed(() => normalizeActionBinding({ arguments_hash: HASH }), 'missing tool_name rejected');
throwsMalformed(() => normalizeActionBinding({ tool_name: '  ', arguments_hash: HASH }), 'blank tool_name rejected');
throwsMalformed(() => normalizeActionBinding({ tool_name: 'x'.repeat(TOOL_NAME_MAX + 1), arguments_hash: HASH }), 'oversized tool_name rejected');
throwsMalformed(() => normalizeActionBinding({ tool_name: 'pay' }), 'missing arguments_hash rejected');
throwsMalformed(() => normalizeActionBinding({ tool_name: 'pay', arguments_hash: 'short' }), 'too-short hash rejected');
throwsMalformed(() => normalizeActionBinding({ tool_name: 'pay', arguments_hash: 'a'.repeat(129) }), 'too-long hash rejected');
throwsMalformed(() => normalizeActionBinding({ tool_name: 'pay', arguments_hash: 'not a valid hash!!' }), 'non-digest hash rejected');
for (const bad of [123456789012345678, true, {}, ['a'.repeat(64)]]) {
  throwsMalformed(() => normalizeActionBinding({ tool_name: 'pay', arguments_hash: bad }), `non-string hash ${JSON.stringify(bad)} rejected`);
}

const okB = normalizeActionBinding(GOOD);
ok(okB.tool_name === 'issue_payment' && okB.arguments_hash === HASH, 'valid binding normalizes');
ok(okB.arguments_preview === 'payee=ACME, amount=12000', 'preview carried');
ok(isBound(okB) && !isBound(null) && !isBound({ tool_name: 'x' }), 'isBound requires BOTH tool_name and hash');

// Bounded, whitespace-collapsed — this text reaches a phone sheet and an audit store.
const longPrev = normalizeActionBinding({ tool_name: 'pay', arguments_hash: HASH, arguments_preview: 'x '.repeat(400) });
ok(longPrev.arguments_preview.length <= PREVIEW_MAX, 'preview clipped to the bound');
ok(!/\n|\s{2,}/.test(normalizeActionBinding({ tool_name: 'pay', arguments_hash: HASH, arguments_preview: 'a\n\n  b' }).arguments_preview),
   'preview whitespace collapsed (no multiline injection into the card)');
ok(!('arguments_preview' in normalizeActionBinding({ tool_name: 'pay', arguments_hash: HASH, arguments_preview: '   ' })),
   'blank preview omitted rather than stored empty');
ok(normalizeActionBinding({ tool_name: '  pay  ', arguments_hash: `  ${HASH}  ` }).tool_name === 'pay', 'fields trimmed');

// A base64url digest is as valid as hex — agents differ, both are unambiguous.
ok(normalizeActionBinding({ tool_name: 'pay', arguments_hash: 'aB3-_xyz'.repeat(2) }).arguments_hash.length === 16,
   'base64url digests accepted');

// ── the resolver marks the request bound ──────────────────────────────────────
console.log('\nnormalizeRequest → bound flag');
{
  const unbound = normalizeRequest({ consultation_type: 'action_approval', action_descriptor: { domain: 'writing' } });
  ok(unbound.bound === false && unbound.binding === null, 'no binding → bound:false');
  const bound = normalizeRequest({ consultation_type: 'action_approval', action_descriptor: { domain: 'writing' }, action_binding: GOOD });
  ok(bound.bound === true && bound.binding.tool_name === 'issue_payment', 'binding present → bound:true');
  throwsMalformed(
    () => normalizeRequest({ consultation_type: 'action_approval', action_binding: { tool_name: 'pay' } }),
    'a structurally invalid binding fails the whole request',
  );
}

// ── the receipt records it (this is what makes a mismatch provable) ───────────
console.log('\nreceipt carriage');
{
  const req = { consultation_type: 'action_approval', action_descriptor: { domain: 'financial', summary: 'pay the invoice' }, action_binding: GOOD };
  const r = buildReceipt({ via: 'phaedo_consult', agentId: 'a', request: req, response: { signal: 'escalate', confidence: 0.8, deference_level: 'high' } });
  ok(r.request.action_binding?.tool_name === 'issue_payment', 'receipt records the tool actually claimed');
  ok(r.request.action_binding?.arguments_hash === HASH, 'receipt records the argument digest');
  ok(r.request.action_descriptor.summary === 'pay the invoice', 'the agent PROSE is kept beside it — the two are what gets compared');

  const plain = buildReceipt({ via: 'phaedo_consult', request: { consultation_type: 'action_approval' }, response: { signal: 'proceed' } });
  ok(!('action_binding' in plain.request), 'unbound consultation records no binding key at all');

  // A receipt write must never fail the consultation (§10.6) — so a caller that
  // bypassed the resolver and passed junk gets NO binding, not an exception.
  const junk = buildReceipt({ via: 'phaedo_consult', request: { consultation_type: 'action_approval', action_binding: { tool_name: 'pay' } }, response: { signal: 'proceed' } });
  ok(!('action_binding' in junk.request), 'a malformed binding records nothing rather than throwing in the receipt writer');
}

// ── the escalation card shows the subject the real call ───────────────────────
console.log('\nescalation carriage');
{
  const payload = buildEscalationPayload(
    { consultation_type: 'action_approval', agent_id: 'agent-A', action_descriptor: { domain: 'financial', summary: 'Routine vendor payment', magnitude: 'high', reversible: false, amount: 12000 }, action_binding: GOOD },
    { signal: 'escalate', rationale_hint: 'money goes to a human' },
  );
  ok(payload.action.tool_name === 'issue_payment', 'escalation carries the tool name');
  ok(payload.action.arguments_preview === 'payee=ACME, amount=12000', 'escalation carries the argument preview');
  ok(payload.action.arguments_hash === HASH, 'escalation carries the digest');
  // The distinction the subject needs to be able to see.
  ok(payload.action.summary === 'Routine vendor payment' && payload.action.tool_name === 'issue_payment',
     'the agent PROSE and the real call are both present and separate');

  const un = buildEscalationPayload({ consultation_type: 'action_approval', action_descriptor: { domain: 'writing' } }, { signal: 'escalate' });
  ok(!('tool_name' in un.action), 'unbound escalation carries no binding fields');
  const bad = buildEscalationPayload({ consultation_type: 'action_approval', action_descriptor: {}, action_binding: { tool_name: 'x' } }, { signal: 'escalate' });
  ok(!('tool_name' in bad.action), 'a malformed binding never half-populates the card');
}

console.log(`\n✓ action binding: ${pass} checks passed`);
