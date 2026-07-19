// Phaedo §10.6 — consultation RECEIPTS (build brief M4).
//
// An encrypted, append-only, vault-held record of every resolved consultation —
// the subject's audit trail ("which agent asked what, and what did my oracle
// say?") and the data layer the delegation gradient (M5 agreement tracking)
// reads. Receipts NEVER leave the device; Phaedo holds nothing.
//
// Crypto: the same AES-256-GCM envelope machinery as everything else (no new
// crypto). The receipts key is derived from the server's stored root key via
// HKDF-SHA-256 with the DISTINCT domain-separation context
// `phaedo:receipts:enc:v0.1` (mirrors §8.4's seed_key pattern), so the receipt
// store and the fingerprint cache are independent ciphertexts under one root.
//
// Semantics (§10.6): APPEND-ONLY. A receipt is never edited after write except
// its `user_action` field (null at write; later approved|rejected|modified|
// unknown when override data exists), and never deleted individually — only
// cap-evicted (oldest first) or destroyed with the account. This module exposes
// no delete-one API on purpose.
//
// Write path: the MCP tool layer calls appendReceipt AFTER resolution — the
// resolver core stays pure (no I/O). Receipt-write failure must never break the
// consultation itself (the server warns on stderr and still answers).

import { mkdir, readFile, writeFile, chmod, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { Phaedo, b64uEnc, b64uDec } from './lib/phaedo-crypto.js';
import { getOrCreateCacheKey, defaultStateDir } from './cache.js';

const { Envelope } = Phaedo;

export const RECEIPTS_CONTEXT = 'phaedo:receipts:enc:v0.1';
export const USER_ACTIONS = ['approved', 'rejected', 'modified', 'unknown'];
export const DEFAULT_CAP = 5000;

export function receiptsCapFromEnv(env = process.env) {
  const n = Number(env.PHAEDO_RECEIPTS_CAP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CAP;
}

// Derive the receipts key from the stored root key under the receipts context.
// Distinct info string → distinct key: the receipt store is NOT decryptable with
// the cache key (or vice versa), so a leak of one artifact exposes nothing else.
async function deriveReceiptsKey(stateDir) {
  const root = await getOrCreateCacheKey(stateDir);
  const ikm = await crypto.subtle.importKey('raw', root, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(RECEIPTS_CONTEXT) },
    ikm,
    32 * 8,
  );
  return new Uint8Array(bits);
}

const storePath = (stateDir) => join(stateDir, 'receipts.enc');

async function readStore(stateDir) {
  const p = storePath(stateDir);
  if (!existsSync(p)) return { receipts_version: '0.1', receipts: [] };
  // Unlike the cache (recoverable from the phone), receipts are the ONLY copy —
  // a corrupt/undecryptable store throws rather than silently starting over.
  const key = await deriveReceiptsKey(stateDir);
  const { envelope } = JSON.parse(await readFile(p, 'utf8'));
  const plaintext = await Envelope.unwrap(envelope, key);
  const store = JSON.parse(new TextDecoder().decode(plaintext));
  plaintext.fill(0);
  return store;
}

async function writeStore(stateDir, store, now) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const key = await deriveReceiptsKey(stateDir);
  const plaintext = new TextEncoder().encode(JSON.stringify(store));
  const envelope = await Envelope.wrap(plaintext, key, {
    artifact_kind: 'consultation_receipts',
    count: store.receipts.length,
    created_at: new Date(now).toISOString(),
  });
  plaintext.fill(0);
  const p = storePath(stateDir);
  // Atomic replace: write a temp file then rename over the live store. Receipts are
  // the ONLY copy (readStore throws on a corrupt store) — a crash mid-write must not
  // truncate/corrupt receipts.enc and brick the audit trail + every markOutcome.
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify({ envelope }), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, p);   // atomic on POSIX
}

// Serialize store mutations per state dir. MCP tool handlers are async and NOT
// serialized by the SDK, so a concurrent appendReceipt (phaedo_consult) and
// markOutcome (phaedo_record_outcome/escalation_status) both read the same snapshot
// and the second write clobbers the first — a lost receipt or lost outcome mark.
// A per-stateDir promise chain forces read-modify-write to run one at a time.
const _storeLocks = new Map();
function withStoreLock(stateDir, fn) {
  const prev = _storeLocks.get(stateDir) || Promise.resolve();
  const next = prev.then(fn, fn);                 // run regardless of the prior result
  _storeLocks.set(stateDir, next.then(() => {}, () => {}));  // a rejection must not break the chain
  return next;
}

// Build the §10.6 receipt object from a resolved consultation. Pure. Captures the
// request descriptor and the response SIGNAL FIELDS only — never layer content,
// never the projection (§10.4 holds inside the vault too). `via` records which
// tool resolved it (phaedo_consult | phaedo_check_authorization) so M5 can weigh
// full consultations and pre-flight matches separately.
export function buildReceipt({ via, agentId, request, response, drivers, now = Date.now() }) {
  const ad = (request && typeof request.action_descriptor === 'object' && request.action_descriptor) || {};
  // Provenance (optional, §10.4-safe — LOCAL audit only): the Decision&Risk cues that
  // drove an inferred consult, each {cue, lean?/value?, confidence, basis}. No layer
  // text; coerced to the known shape; absent for deterministic pre-flights.
  const drv = Array.isArray(drivers) ? drivers.slice(0, 16).map((d) => ({
    cue: typeof d?.cue === 'string' ? d.cue : null,
    ...(typeof d?.lean === 'number' ? { lean: d.lean } : {}),
    ...(d?.value != null ? { value: String(d.value) } : {}),
    confidence: typeof d?.confidence === 'number' ? d.confidence : null,
    basis: typeof d?.basis === 'string' ? d.basis : null,
  })) : [];
  return {
    receipt_id: crypto.randomUUID(),
    created_at: new Date(now).toISOString(),
    via: via || 'phaedo_consult',
    agent_id: typeof agentId === 'string' ? agentId : null,
    request: {
      consultation_type: request?.consultation_type || 'action_approval',
      action_descriptor: {
        domain: typeof ad.domain === 'string' ? ad.domain : null,
        reversible: typeof ad.reversible === 'boolean' ? ad.reversible : null,
        magnitude: typeof ad.magnitude === 'string' ? ad.magnitude : null,
        amount: typeof ad.amount === 'number' ? ad.amount : null,
        summary: typeof ad.summary === 'string' ? ad.summary.slice(0, 500) : null,
      },
    },
    response: {
      signal: response?.signal ?? null,
      confidence: typeof response?.confidence === 'number' ? response.confidence : null,
      deference_level: response?.deference_level ?? null,
    },
    ...(drv.length ? { drivers: drv } : {}),
    user_action: null,
  };
}

// Append one receipt; evict oldest beyond the cap. Returns the stored receipt.
export async function appendReceipt(stateDir, receipt, { cap = DEFAULT_CAP, now = Date.now() } = {}) {
  return withStoreLock(stateDir, async () => {
    const store = await readStore(stateDir);
    store.receipts.push(receipt);
    if (store.receipts.length > cap) store.receipts.splice(0, store.receipts.length - cap);
    await writeStore(stateDir, store, now);
    return receipt;
  });
}

// The ONE permitted mutation (§10.6): set user_action on an existing receipt.
// Every other field is immutable after write. Returns true if found.
export async function updateUserAction(stateDir, receiptId, action, { now = Date.now() } = {}) {
  if (!USER_ACTIONS.includes(action)) {
    throw new Error(`user_action must be one of: ${USER_ACTIONS.join(', ')}`);
  }
  return withStoreLock(stateDir, async () => {
    const store = await readStore(stateDir);
    const r = store.receipts.find((x) => x.receipt_id === receiptId);
    if (!r) return false;
    r.user_action = action;
    await writeStore(stateDir, store, now);
    return true;
  });
}

// Decrypt and return all receipts (oldest first). The dev/harness read path — and
// M5's input. Throws on a corrupt store (receipts are the only copy).
export async function readReceipts(stateDir) {
  return (await readStore(stateDir)).receipts;
}

// Resolve a user-friendly selector to a full receipt_id. Pure. Accepts:
//   - 'latest' (or empty) → the most recent receipt
//   - a full receipt_id, or any UNIQUE id PREFIX (the short id `list` prints)
// Returns { ok, id } or { ok:false, reason } (none / ambiguous / empty store).
export function resolveReceiptSelector(receipts, selector) {
  const list = Array.isArray(receipts) ? receipts : [];
  if (!list.length) return { ok: false, reason: 'no receipts yet' };
  if (!selector || selector === 'latest') return { ok: true, id: list[list.length - 1].receipt_id };
  const exact = list.find((r) => r.receipt_id === selector);
  if (exact) return { ok: true, id: exact.receipt_id };
  const hits = list.filter((r) => r.receipt_id.startsWith(selector));
  if (hits.length === 1) return { ok: true, id: hits[0].receipt_id };
  if (hits.length === 0) return { ok: false, reason: `no receipt matches "${selector}"` };
  return { ok: false, reason: `"${selector}" matches ${hits.length} receipts — use more characters` };
}

// Mark a receipt's user_action — what the SUBJECT decided about an action they
// consulted on (approved | rejected | modified | unknown). This is what makes the
// agreement metric (agreement.js) live: until receipts carry a user_action, every
// consultation sits in `awaiting_user_action`. Subject-authored by definition — set
// it from what YOU did, not from whether an agent proceeded (that would measure
// agent obedience, not how well the oracle predicts you).
export async function markOutcome(stateDir, selector, action) {
  if (!USER_ACTIONS.includes(action)) {
    throw new Error(`user_action must be one of: ${USER_ACTIONS.join(', ')}`);
  }
  const sel = resolveReceiptSelector(await readReceipts(stateDir), selector);
  if (!sel.ok) return { matched: false, reason: sel.reason };
  await updateUserAction(stateDir, sel.id, action);
  return { matched: true, receipt_id: sel.id, user_action: action };
}

// ── Dev CLI: `node receipts.js [list|mark]` — quick on-device readout/marking ──
// All local: decrypts with the local key, nothing leaves this machine.
//   node receipts.js list                       # list (shows a short id per line)
//   node receipts.js mark <id|prefix|latest> <approved|rejected|modified|unknown>
if (process.argv[1] && process.argv[1].endsWith('receipts.js')) {
  const [cmd, a, b] = process.argv.slice(2);
  const dir = defaultStateDir();
  const run = async () => {
    if (cmd === 'mark') {
      if (!a || !b) { console.error('usage: node receipts.js mark <id|prefix|latest> <approved|rejected|modified|unknown>'); process.exit(2); }
      const res = await markOutcome(dir, a, b);
      if (!res.matched) { console.error(`mark: ${res.reason}`); process.exit(1); }
      console.log(`marked ${res.receipt_id.slice(0, 8)} → user_action: ${res.user_action}`);
      console.log('(run `npm run agreement` to see it counted)');
      return;
    }
    if (cmd === 'list' || cmd === undefined) {
      const rs = await readReceipts(dir);
      console.log(`${rs.length} receipt(s) in ${dir}/receipts.enc`);
      console.log(`(mark one: node receipts.js mark <id> approved|rejected|modified)\n`);
      for (const r of rs.slice(-50)) {
        const ad = r.request.action_descriptor;
        console.log(
          `${r.receipt_id.slice(0, 8)}  ${r.created_at}  ${r.via === 'phaedo_check_authorization' ? '[pre-flight]' : '[consult]  '}` +
          ` ${r.request.consultation_type}  ${ad.domain || '-'}` +
          `  → ${r.response.signal} (conf ${r.response.confidence}, def ${r.response.deference_level})` +
          `  user_action: ${r.user_action ?? '—'}`
        );
      }
      return;
    }
    console.error(`unknown command "${cmd}" — use: list | mark`); process.exit(2);
  };
  run().catch((e) => { console.error(`receipts: ${e.message}`); process.exit(1); });
}
