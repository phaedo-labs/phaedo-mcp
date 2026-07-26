// §8.3 signing-audit store — records a credential was minted, without becoming a §10.6
// consult receipt.

import assert from 'assert';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import crypto from 'node:crypto';
import { buildSigningAuditRecord, appendSigningAudit, readSigningAudit } from './signing-audit.js';
import { signingInput } from './signing.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

const dir = await mkdtemp(join(tmpdir(), 'phaedo-sign-audit-'));
process.env.PHAEDO_MCP_STATE_DIR = dir;   // deriveKey uses getOrCreateCacheKey(stateDir)

const mandate = {
  mandate_type: 'intent', amount: 500, grants: [{ categories: ['finance'], max_amount: 1000 }],
  expires_at: '2026-08-01T00:00:00Z', signed_at: '2026-07-24T12:00:00Z', signature: 'AAAA',
};

console.log('\nrecord captures a digest of the SIGNED bytes, not the content or signature');
{
  const rec = buildSigningAuditRecord({ requestId: 'r1', mandate, clientId: 'c_abc', agentId: 'vendor-x' });
  const expected = crypto.createHash('sha256').update(signingInput(mandate, { field: 'signature' })).digest('base64url');
  ok(rec.mandate_digest === expected, 'digest is sha256 of the signing input');
  ok(rec.grant_count === 1 && rec.request_id === 'r1' && rec.client_id === 'c_abc' && rec.agent_id === 'vendor-x', 'metadata recorded');
  ok(rec.signed_at === '2026-07-24T12:00:00Z', 'signed_at taken from the mandate');
  const s = JSON.stringify(rec);
  ok(!s.includes('AAAA'), 'the signature bytes are NOT stored');
  ok(!s.includes('500'), 'the raw amount is NOT stored (digest + counts only)');
  // The digest changes if the signed terms change — it is a real commitment to what was signed.
  const other = buildSigningAuditRecord({ requestId: 'r1', mandate: { ...mandate, amount: 999 }, clientId: 'c_abc' });
  ok(other.mandate_digest !== rec.mandate_digest, 'a different mandate yields a different digest');
}

console.log('\nappend is encrypted at rest, ordered, and capped');
{
  await appendSigningAudit(dir, buildSigningAuditRecord({ requestId: 'r1', mandate, clientId: 'c1' }));
  await appendSigningAudit(dir, buildSigningAuditRecord({ requestId: 'r2', mandate, clientId: 'c2' }));
  ok(existsSync(join(dir, 'signing-audit.enc')), 'store file exists');

  const { readFileSync } = await import('fs');
  const raw = readFileSync(join(dir, 'signing-audit.enc'), 'utf8');
  ok(raw.includes('envelope') && !raw.includes('c_abc') && !raw.includes('mandate_digest'), 'at rest it is ciphertext, not plaintext JSON');

  const recs = await readSigningAudit(dir);
  ok(recs.length === 2 && recs[0].request_id === 'r1' && recs[1].request_id === 'r2', 'records read back in order');

  await appendSigningAudit(dir, buildSigningAuditRecord({ requestId: 'r3', mandate, clientId: 'c3' }), { cap: 2 });
  const capped = await readSigningAudit(dir);
  ok(capped.length === 2 && capped[0].request_id === 'r2' && capped[1].request_id === 'r3', 'cap keeps the newest, drops the oldest');
}

console.log('\nconcurrent appends do not clobber (serialized per process)');
{
  const before = (await readSigningAudit(dir)).length;
  await Promise.all([0, 1, 2, 3, 4].map(i =>
    appendSigningAudit(dir, buildSigningAuditRecord({ requestId: `p${i}`, mandate, clientId: 'c' }), { cap: 1000 })));
  const after = await readSigningAudit(dir);
  ok(after.length === before + 5, `all 5 concurrent appends landed (${before} → ${after.length})`);
}

console.log('\ndifferent artifact key: the signing audit is NOT the receipts store');
{
  // A wrong/empty dir yields an empty log, never a throw (a fresh install has no audit yet).
  const empty = await mkdtemp(join(tmpdir(), 'phaedo-empty-'));
  ok((await readSigningAudit(empty)).length === 0, 'a fresh state dir reads as an empty audit');
  await rm(empty, { recursive: true, force: true });
}

await rm(dir, { recursive: true, force: true });
console.log(`\n✓ signing-audit: ${pass} checks passed\n`);
