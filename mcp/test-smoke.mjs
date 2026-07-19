// Smoke test for the Phaedo MCP server (Phase 1a).
//
//   1. Unit: buildInjectionResponse — §9.3 shape, projection reuse, error codes.
//   2. Integration: drive the real server.js over stdio via the MCP SDK client —
//      list tools/resources, call phaedo_request_injection, read the resource.
//
// Run: node test-smoke.mjs   (from mcp/)

import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { readFile, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import assert from 'assert';

import { buildInjectionResponse, errorResponse, PhaedoError } from './projection.js';
import { readReceipts } from './receipts.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BASE_DIR = dirname(fileURLToPath(import.meta.url));
let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; };

async function unit() {
  const vd = JSON.parse(await readFile(resolve(BASE_DIR, 'sample-fingerprint.json'), 'utf8'));

  // §9.3 shape + projection reuse
  const r = buildInjectionResponse(vd, { requested_layers: ['all'], mode: 'standard' }, Date.UTC(2026, 5, 1));
  ok(r.phaedo_response_version === '0.1', 'response_version');
  ok(r.request_type === 'injection', 'request_type');
  ok(r.mode === 'standard', 'mode standard');
  ok(r.projection.startsWith('<phaedo_user_profile>'), 'projection is the phaedo block');
  ok(r.projection.includes('</phaedo_user_profile>'), 'projection closes the block');
  ok(Array.isArray(r.layers_included) && r.layers_included.includes('surface'), 'layers_included');
  ok(typeof r.persona_strength === 'number' && r.persona_strength >= 0 && r.persona_strength <= 1, 'persona_strength in [0,1]');
  ok(r.fingerprint_id === 'sample-0000-0000-0000-000000000000', 'fingerprint_id from source');
  ok(typeof r.expires_at === 'string' && r.expires_at.endsWith('Z'), 'expires_at ISO');

  // layer subset selection
  const sub = buildInjectionResponse(vd, { requested_layers: ['surface'] });
  ok(sub.layers_included.length === 1 && sub.layers_included[0] === 'surface', 'subset selection');
  ok(!sub.projection.includes('Domain and expertise'), 'subset excludes other layers');

  // §9.5 errors
  let threw;
  threw = null; try { buildInjectionResponse(vd, { mode: 'enhanced_privacy' }); } catch (e) { threw = e; }
  ok(threw instanceof PhaedoError && threw.code === 'mode_not_supported', 'enhanced_privacy → mode_not_supported');

  threw = null; try { buildInjectionResponse(vd, { requested_layers: ['no_such_layer'] }); } catch (e) { threw = e; }
  ok(threw instanceof PhaedoError && threw.code === 'layer_not_available', 'unknown layer → layer_not_available');

  threw = null; try { buildInjectionResponse({}, {}); } catch (e) { threw = e; }
  ok(threw instanceof PhaedoError && threw.code === 'decryption_failed', 'no fingerprint → decryption_failed');

  threw = null; try { buildInjectionResponse(vd, { requested_layers: 'all' }); } catch (e) { threw = e; }
  ok(threw instanceof PhaedoError && threw.code === 'request_malformed', 'non-array layers → request_malformed');

  const errBody = errorResponse(new PhaedoError('internal_error', 'boom'));
  ok(errBody.error.code === 'internal_error', 'errorResponse shape');

  console.log(`unit: ${pass} checks passed`);
}

async function integration() {
  const before = pass;
  // Isolated state dir so the §10.6 receipt assertions see ONLY this run's writes
  // (and the dev machine's real receipt store is untouched).
  const stateDir = await mkdtemp(join(tmpdir(), 'phaedo-smoke-state-'));
  // Pin the fingerprint source to the shipped sample so the run is hermetic on ANY
  // machine — including a phone-paired dev box whose pairing.json would otherwise
  // make the server pull from an unreachable phone (with no cache in this fresh
  // state dir). PHAEDO_FINGERPRINT takes precedence over pairing (fingerprint-source.js).
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(BASE_DIR, 'server.js')],
    env: { ...process.env, PHAEDO_MCP_STATE_DIR: stateDir, PHAEDO_FINGERPRINT: resolve(BASE_DIR, 'sample-fingerprint.json') },
  });
  const client = new Client({ name: 'phaedo-smoke', version: '0.0.0' });
  await client.connect(transport);

  const tools = await client.listTools();
  ok(tools.tools.some(t => t.name === 'phaedo_request_injection'), 'tool registered');

  const resources = await client.listResources();
  ok(resources.resources.some(r => r.uri === 'phaedo://fingerprint/projection'), 'resource registered');

  const call = await client.callTool({
    name: 'phaedo_request_injection',
    arguments: { session_context: { platform: 'claude_desktop' }, requested_layers: ['all'], consumer_id: 'phaedo-smoke' },
  });
  ok(!call.isError, 'tool call ok');
  const payload = call.structuredContent || JSON.parse(call.content[0].text);
  ok(payload.projection.startsWith('<phaedo_user_profile>'), 'tool returns projection block');
  ok(payload.request_type === 'injection', 'tool returns §9.3 response');

  const res = await client.readResource({ uri: 'phaedo://fingerprint/projection' });
  ok(res.contents[0].text.startsWith('<phaedo_user_profile>'), 'resource returns projection text');

  // prompt: phaedo (one-click /phaedo) — listed + returns the projection as a message
  const prompts = await client.listPrompts();
  ok(prompts.prompts.some(p => p.name === 'phaedo'), 'prompt registered');
  const got = await client.getPrompt({ name: 'phaedo' });
  ok(got.messages.length >= 1 && got.messages[0].role === 'user', 'prompt returns a user message');
  ok(got.messages[0].content.text.includes('<phaedo_user_profile>'), 'prompt embeds the projection block');

  // consultation: phaedo_consult (§10) — registered, returns a §10.3 signal, no leak
  ok(tools.tools.some(t => t.name === 'phaedo_consult'), 'consult tool registered');
  const consult = await client.callTool({
    name: 'phaedo_consult',
    // agent_credential is RESERVED for v0.3 authenticated identity — send it now to
    // prove the v0.1 server ACCEPTS and IGNORES it (the forward-compat reservation).
    arguments: { consultation_type: 'action_approval', action_descriptor: { reversible: false, magnitude: 'high' }, agent_id: 'phaedo-smoke', agent_credential: 'reserved-v03-token' },
  });
  ok(!consult.isError, 'consult accepts the reserved agent_credential field (forward-compat)');
  const cpayload = consult.structuredContent || JSON.parse(consult.content[0].text);
  ok(cpayload.request_type === 'consultation', 'consult returns §10.3 response');
  ok(['proceed', 'proceed_with_note', 'clarify', 'escalate', 'decline', 'insufficient_signal'].includes(cpayload.signal), 'consult returns a valid signal');
  ok(!/"layers"|persona_strength|"polarity"|phaedo_fingerprint/.test(JSON.stringify(cpayload)), 'consult leaks no layer content (§10.4)');

  // authorization check: phaedo_check_authorization (M3) — registered, deterministic shape, no leak
  ok(tools.tools.some(t => t.name === 'phaedo_check_authorization'), 'check_authorization tool registered');
  const auth = await client.callTool({
    name: 'phaedo_check_authorization',
    arguments: { action_descriptor: { domain: 'financial', reversible: false, amount: 12000 }, agent_id: 'phaedo-smoke' },
  });
  ok(!auth.isError, 'check_authorization call ok');
  const apayload = auth.structuredContent || JSON.parse(auth.content[0].text);
  ok(apayload.request_type === 'authorization_check' && typeof apayload.authorization_matched === 'boolean', 'check_authorization returns its fixed shape');
  ok(!/"layers"|persona_strength|phaedo_fingerprint/.test(JSON.stringify(apayload)), 'check_authorization leaks no layer content (§10.4)');

  // §10.6 receipts (M4): the consult above wrote EXACTLY ONE encrypted receipt;
  // the unmatched pre-flight wrote none. End-to-end over the real server.
  const receipts = await readReceipts(stateDir);
  ok(receipts.length === 1, `exactly one receipt per resolved consultation (got ${receipts.length})`);
  ok(receipts[0].via === 'phaedo_consult' && receipts[0].response.signal === cpayload.signal, 'receipt records the resolved signal');
  ok(receipts[0].agent_id === 'phaedo-smoke' && receipts[0].user_action === null, 'receipt carries agent_id; user_action null at write');
  ok(!('agent_credential' in receipts[0]) && !JSON.stringify(receipts[0]).includes('reserved-v03-token'), 'reserved agent_credential is ignored — never captured into the receipt');
  const rawStore = await readFile(join(stateDir, 'receipts.enc'), 'utf8');
  ok(!rawStore.includes(cpayload.signal) && !rawStore.includes('phaedo-smoke'), 'receipt store on disk is ciphertext-only');

  // outcome marking: phaedo_record_outcome (§10.6) — the act-as-me loop closer.
  // Marks the SUBJECT's decision on the receipt the consult just wrote, over the live server.
  ok(tools.tools.some(t => t.name === 'phaedo_record_outcome'), 'record_outcome tool registered');
  const rec = await client.callTool({ name: 'phaedo_record_outcome', arguments: { outcome: 'rejected' } });
  ok(!rec.isError, 'record_outcome call ok');
  const rpayload = rec.structuredContent || JSON.parse(rec.content[0].text);
  ok(rpayload.request_type === 'outcome_record' && rpayload.recorded === true && rpayload.user_action === 'rejected', 'record_outcome returns its fixed shape (recorded)');
  ok(!/"layers"|persona_strength|phaedo_fingerprint/.test(JSON.stringify(rpayload)), 'record_outcome leaks no layer content (§10.4)');
  const afterMark = await readReceipts(stateDir);
  ok(afterMark.length === 1 && afterMark[0].user_action === 'rejected', 'the outcome persisted onto the receipt (user_action set)');

  // real-time escalation: phaedo_escalate + phaedo_escalation_status register. With no
  // paired relay device in this fixture, a blocking action reports "unreachable" (it
  // never invents a decision) and a non-blocking one reports escalated:false — both
  // §10.4-safe. (The full deposit→answer→poll wire path is in test-escalation.mjs.)
  ok(tools.tools.some(t => t.name === 'phaedo_escalate'), 'escalate tool registered');
  ok(tools.tools.some(t => t.name === 'phaedo_escalation_status'), 'escalation_status tool registered');
  const esc = await client.callTool({ name: 'phaedo_escalate', arguments: {
    action_descriptor: { domain: 'financial', summary: 'wire $40k to a new vendor', magnitude: 'high', reversible: false },
  } });
  ok(!esc.isError, 'escalate call ok');
  const epayload = esc.structuredContent || JSON.parse(esc.content[0].text);
  // With no paired relay device, it can NEVER return a pending escalation: a blocking
  // signal reports status 'unreachable', a non-blocking one reports escalated:false with
  // a "proceed" message. Either way it never invents a decision.
  ok(epayload.request_type === 'escalation' && epayload.escalated === false && epayload.status !== 'pending',
    'an escalate with no relay lane never fabricates a pending decision (unreachable or not-blocking)');
  ok(!/"layers"|persona_strength|phaedo_fingerprint/.test(JSON.stringify(epayload)), 'escalate leaks no layer content (§10.4)');

  // enhanced_privacy → tool error
  const errCall = await client.callTool({
    name: 'phaedo_request_injection',
    arguments: { mode: 'enhanced_privacy' },
  });
  ok(errCall.isError && errCall.content[0].text.includes('mode_not_supported'), 'enhanced_privacy → tool error');

  await client.close();
  console.log(`integration: ${pass - before} checks passed (live stdio server)`);
}

await unit();
await integration();
console.log(`\nALL GREEN — ${pass} checks passed`);
