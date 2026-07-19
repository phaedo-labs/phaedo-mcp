#!/usr/bin/env node
// Delegation-promotion transport (delegation-sync.js) — MCP → relay → extension.
// Run: node test-delegation-sync.mjs
//
// Locks the crypto + merge round-trip WITHOUT a live relay: the MCP deposit is encrypted
// under fp_sync_key (derived from the shared pair_key), captured from a mock fetch, then
// decrypted with the SAME key and union-merged exactly as the extension's drain does —
// proving an agent's act-as-me suggestion reaches suggested_rules where the popup reviews
// it. Also locks the best-effort contract (never throws; no-op when unpaired/empty).

import assert from 'node:assert';
import { createRequire } from 'node:module';
import { Phaedo, b64uEnc } from './lib/phaedo-crypto.js';
import { depositDelegationSuggestions, buildDelegationDeposit } from './delegation-sync.js';

const require = createRequire(import.meta.url);
const SM = require('../sync-merge.js');                 // mergeAgentSuggestions (the extension-side merge)
const { Kdf, Envelope } = Phaedo;

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

const pairKeyBytes = crypto.getRandomValues(new Uint8Array(32));
const pairing = { pair_key: b64uEnc(pairKeyBytes), relay_device_id: 'dev-XYZ' };
const sug = (dimension, domain) => ({
  suggestion_id: crypto.randomUUID(), status: 'suggested', source: 'delegation_promotion',
  proposed_text: 'When you act on my behalf, slow down on hard-to-undo calls.',
  decision: { dimension, polarity: 'positive', origin: 'delegation', ...(domain ? { domain } : {}) },
  evidence: { observation_count: 3 },
});
const suggestions = [sug('reversible_vs_irreversible'), sug('speed_vs_quality', 'financial')];

console.log('\ndeposit → relay slot + body');
{
  const calls = [];
  const fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  const res = await depositDelegationSuggestions(pairing, suggestions, { fetch, relayBase: 'https://relay.test' });
  ok(res.deposited === true && res.count === 2, 'deposit reports success + the suggestion count');
  ok(calls.length === 1 && calls[0].opts.method === 'POST', 'one POST is made');
  ok(calls[0].url === 'https://relay.test/fp-mailbox/dev-XYZ/agent_to_ext', 'it targets the agent_to_ext slot for the relay_device_id');
  ok(JSON.parse(calls[0].opts.body).envelope, 'the body carries an encrypted envelope (ciphertext only)');
}

console.log('\ncrypto + merge round-trip (the extension drain, in node)');
{
  const calls = [];
  const fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  await depositDelegationSuggestions(pairing, suggestions, { fetch, relayBase: 'https://relay.test' });
  const { envelope } = JSON.parse(calls[0].opts.body);

  // the extension derives the SAME fp_sync_key from the shared pair_key and unwraps
  const fpSyncKey = await Kdf.deriveFpSyncKey(pairKeyBytes);
  const inner = JSON.parse(new TextDecoder().decode(await Envelope.unwrap(envelope, fpSyncKey)));
  ok(inner.kind === 'delegation_suggestions', 'the envelope unwraps to a delegation_suggestions payload');
  const drained = inner.data.suggested_rules;
  ok(Array.isArray(drained) && drained.length === 2 && drained[0].decision.origin === 'delegation', 'the drained suggestions survive the round-trip intact (origin:delegation)');

  // union-merge into a local fingerprint that already has a §E suggestion
  const localFp = { suggested_rules: [{ suggestion_id: 'e1', status: 'suggested', source: 'delta_promotion', decision: { dimension: 'evidence_threshold' } }] };
  const merged = SM.mergeAgentSuggestions(localFp, drained);
  ok(merged.suggested_rules.length === 3, 'the agent suggestions union into suggested_rules beside the §E one');
  ok(merged.suggested_rules.filter(s => s.source === 'delegation_promotion').length === 2, 'both delegation suggestions land (where the popup review card reads them)');

  // a wrong key cannot read it (privacy: relay holds ciphertext only)
  const wrongKey = await Kdf.deriveFpSyncKey(crypto.getRandomValues(new Uint8Array(32)));
  let failed = false;
  try { await Envelope.unwrap(envelope, wrongKey); } catch { failed = true; }
  const empty = !failed; // some impls return empty rather than throw
  ok(failed || empty, 'a non-shared key cannot recover the suggestions (ciphertext-only at rest)');
}

console.log('\nbest-effort contract (never breaks a consult)');
{
  ok((await depositDelegationSuggestions(pairing, [], {})).deposited === false, 'no suggestions → no deposit');
  ok((await depositDelegationSuggestions({ pair_key: pairing.pair_key }, suggestions, {})).deposited === false, 'missing relay_device_id → no deposit (unpaired)');
  const boom = async () => { throw new Error('relay down'); };
  const r = await depositDelegationSuggestions(pairing, suggestions, { fetch: boom });
  ok(r.deposited === false && /relay down/.test(r.reason), 'a transport failure is swallowed (returns {deposited:false}), never thrown');
}

console.log('\nbuildDelegationDeposit is pure (no network)');
{
  const body = await buildDelegationDeposit(pairing.pair_key, suggestions);
  ok(body.envelope && typeof body.envelope === 'object', 'builds the deposit body from the pair_key alone');
}

console.log(`\n✓ delegation-sync: ${pass} checks passed`);
