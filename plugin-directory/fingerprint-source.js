// Fingerprint source for the Phaedo MCP server. The server depends only on
// loadFingerprint()'s return shape, so the source swaps without touching the
// tool/resource code. Two modes, auto-selected:
//
//   Phase 1b (phone): if a pairing record is configured (PHAEDO_PAIRING or
//     mcp/pairing.json), authorize → pull /v1/profile → unwrap the §7.2 envelope
//     from the paired phone (phone-source.js). Spec-faithful; no plaintext at rest.
//   Phase 1a (local): otherwise read a local vault-payload JSON. With neither, a STARTER
//     profile from this computer's own capture (loadStarterProfile), else no profile — tools
//     say so (NO_PROFILE_MESSAGE). The shipped sample is opt-in only.

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { hasPairingRecord, loadPairingRecord, loadFingerprintFromPhone, PhoneError } from './phone-source.js';
import { defaultStateDir, writeCache, readCache, clearCache } from './cache.js';
import { foldLocalCapture, isLocalCaptureOwner, localCaptureSessionCount } from './capture-local.js';
import { Capabilities, AuthoredSource } from './lib/phaedo-crypto.js';
import { PhaedoError } from './errors.js';
import { configDir, isDirectoryEdition } from './lib/config-dir.js';

// §4.1 protocol-identity normalization (consumer defense-in-depth, 2026-06-16).
// A stored fingerprint from a producer that predates identity stamping (or whose
// phone copy was never re-persisted) can arrive missing the REQUIRED §4.1 fields
// — `npm run health` surfaced exactly this on a live fingerprint. The
// deterministic ones (phaedo_protocol_version, schema_revision) are safe for any
// consumer to ensure; subject_id falls back to the existing, stable, non-PII
// `fingerprint_id` when absent, rather than minting a value that would churn on
// every load. This makes the reference server serve §4.1-conformant fingerprints
// regardless of producer staleness. Source cleanup (re-persisting these on the
// phone) remains the producer's job. SEMANTIC hygiene (episodic/opaque content)
// is deliberately NOT masked here: health keeps surfacing it as an honest
// producer signal, and context-block's render guard protects the AI projection.
const IDENTITY_PROTOCOL_VERSION = '0.1';
const IDENTITY_SCHEMA_REVISION = 1;
function normalizeIdentity(vd) {
  const fp = vd && vd.phaedo_fingerprint;
  if (!fp || typeof fp !== 'object') return vd;
  const patch = {};
  if (fp.phaedo_protocol_version === undefined) patch.phaedo_protocol_version = IDENTITY_PROTOCOL_VERSION;
  if (fp.schema_revision === undefined) patch.schema_revision = IDENTITY_SCHEMA_REVISION;
  if (fp.subject_id === undefined && typeof fp.fingerprint_id === 'string' && fp.fingerprint_id) patch.subject_id = fp.fingerprint_id;
  if (!Object.keys(patch).length) return vd;
  return { ...vd, phaedo_fingerprint: { ...fp, ...patch } };
}


// §5 CANONICAL ON READ — the step-3 read path, applied ONCE at the boundary.
//
// The agent's authored-content readers (ap2.js buildIntentMandatePayload, autonomy-promotion.js,
// consult-core.js delegation authoring) all take a FINGERPRINT, not a vault. Threading the §5
// configuration through every one of them would mean changing four signatures and every caller,
// and would leave four places that must each remember to check §5.4.
//
// Folding here instead makes every downstream reader correct by construction, and means step 3
// (deleting fp.standing_rules) changes nothing about what any of them see. One fold, one §5.4
// check, one place to be wrong.
//
// §5.4 matters more on this path than anywhere else: these entries become AUTHORIZATIONS — what
// the agent may do without asking — so a configuration belonging to another identity, or to a
// fingerprint since replaced by a restore or a cross-device merge, must not govern. Falls back
// to the A-home rather than throwing; an agent that cannot resolve policy must still run the
// safe path.
export function foldConfigHome(vd) {
  if (!vd || typeof vd !== 'object') return vd;
  const fp = vd.phaedo_fingerprint;
  const cfg = vd.phaedo_user_configuration;
  if (!fp || typeof fp !== 'object' || !cfg || typeof cfg !== 'object') return vd;
  if (!Capabilities || !AuthoredSource) return vd;          // vendored module missing → leave as-is
  if (!AuthoredSource.configGoverns(cfg, fp)) return vd;    // §5.4 — not this subject's
  if (!Array.isArray(cfg.standing_instructions)) return vd; // not a statement about rules
  const next = { ...fp };
  // An EMPTY standing_instructions is a statement ("no rules"), not an absence — leaving the
  // A-home in place there would resurrect rules the subject deleted (#247's lesson).
  if (cfg.standing_instructions.length) next.standing_rules = cfg.standing_instructions;
  else delete next.standing_rules;
  return { ...vd, phaedo_fingerprint: next };
}

// Resolution order for the local fixture (1a):
//   1. PHAEDO_FINGERPRINT env var (absolute or cwd-relative path, or `sample`)
//   2. ./fingerprint.json next to the server
//   3. a starter profile folded from this computer's capture state (see loadStarterProfile)
//   — nothing else. There is deliberately NO silent fallback to the shipped sample.
//
// NO PROFILE IS AN ANSWER, NOT A DEMO. Until 2026-10-20 an unpaired install with no file fell
// back to sample-fingerprint.json — so a stranger who ran `npx phaedo-mcp` had a made-up
// person's style injected into their assistant, with nothing anywhere saying so (the response
// carried `fingerprint_id: sample-0000…`, which no human reads). The sample is still one word
// away for anyone who wants to try it — PHAEDO_FINGERPRINT=sample — but it has to be asked for.
const SAMPLE_KEYWORD = 'sample';
// The sample ships beside this module, whatever base dir the caller serves from.
const SAMPLE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'sample-fingerprint.json');
function resolveSourcePath(baseDir) {
  const env = process.env.PHAEDO_FINGERPRINT;
  if (env === SAMPLE_KEYWORD) return SAMPLE_PATH;
  if (env) return resolve(process.cwd(), env);
  return resolve(configDir(baseDir), 'fingerprint.json');
}

// Read by the assistant (a tool error) and, through it, by the person — so plain words, and
// it says what did NOT happen as well as what to do.
export const NO_PROFILE_MESSAGE =
  'No Phaedo profile is set up on this computer, so there is nothing to load and Phaedo has ' +
  'not changed how the assistant responds. A profile comes from the Phaedo phone app, which is ' +
  'not open to the public yet (https://phaedo.so to hear when it is). Without the phone, Phaedo ' +
  'can start one from your own Claude Code sessions on this computer once its Claude Code hook ' +
  'is installed (see the README). To try a made-up example profile instead, set ' +
  'PHAEDO_FINGERPRINT=sample in this server\'s settings.';

// Inside the Claude plugin the Claude Code hook is already installed — the plugin is the hook —
// so telling the person to install it would send them looking for a step that doesn't exist.
// Claude Code exports CLAUDE_PLUGIN_ROOT to a plugin's MCP server and hooks, and to nothing else.
export const PLUGIN_NO_PROFILE_MESSAGE =
  'No Phaedo profile is set up yet, so Phaedo has not changed how the assistant responds. It ' +
  'starts one from your own Claude Code sessions on this computer: after a session or two, it ' +
  'loads at the start of the next one. For your full profile, pair the Phaedo phone app with ' +
  '/phaedo:pair (the app is not open to the public yet; https://phaedo.so to hear when it is).';

// The directory edition learns nothing from sessions, so it can't promise a starter profile.
export const DIRECTORY_NO_PROFILE_MESSAGE =
  'No Phaedo profile is set up yet, so Phaedo has not changed how the assistant responds. Your ' +
  'profile comes from the Phaedo phone app: pair it with /phaedo:pair (the app is not open to the ' +
  'public yet; https://phaedo.so to hear when it is).';

export function noProfileMessage(env = process.env, baseDir = null) {
  if (baseDir && isDirectoryEdition(baseDir)) return DIRECTORY_NO_PROFILE_MESSAGE;
  return env.CLAUDE_PLUGIN_ROOT ? PLUGIN_NO_PROFILE_MESSAGE : NO_PROFILE_MESSAGE;
}

// The same news for the server's log (Claude Desktop's MCP log shows stderr), one line.
const NO_PROFILE_LOG =
  'no profile is set up on this computer, so Phaedo will not change how the assistant responds. ' +
  'Pair the Phaedo phone app, install the Claude Code hook to start one from your own sessions, ' +
  'or set PHAEDO_FINGERPRINT=sample to try the example.';
const DIRECTORY_NO_PROFILE_LOG = 'no profile yet; pair the Phaedo phone app with /phaedo:pair.';
const PLUGIN_NO_PROFILE_LOG =
  'no profile yet; one starts from your Claude Code sessions on this computer, or pair the phone app with /phaedo:pair.';

// STARTER PROFILE — the phone-less path.
//
// Someone without the phone app has no fingerprint to pull, but if they turned on the Claude
// Code capture hook, this computer already holds their own signal counts (capture-local.js, the
// tier-3 owner). Folding those onto an EMPTY fingerprint gives a profile made only of what they
// did — never the sample's invented traits, which is what this branch fell back to until 0.3.0.
// It is thin by construction (persona_strength 0; the projection's confidence section says
// "treat all signals as preliminary"), and that is the honest label for it.
//
// Served only when the fold learned something: zero signals is still "no profile". The id is a
// constant so receipts and the agreement metric stay on one subject across loads; pairing a
// phone later replaces it (the phone inherits the cumulative counts — capture-local.js §5).
export const STARTER_FINGERPRINT_ID = 'starter-local';

async function loadStarterProfile(now = new Date().toISOString(), baseDir = null) {
  if (baseDir && isDirectoryEdition(baseDir)) return null;   // nothing is learned from sessions there
  if (!await isLocalCaptureOwner(false)) return null;
  const base = { phaedo_fingerprint: { fingerprint_id: STARTER_FINGERPRINT_ID, updated_at: now, layers: {} } };
  const vd = await foldLocalCapture(base, { now });
  const layers = (vd && vd.phaedo_fingerprint && vd.phaedo_fingerprint.layers) || {};
  if (!Object.values(layers).some((l) => Array.isArray(l?.signals) && l.signals.length)) return null;
  return markStarter(foldConfigHome(normalizeIdentity(vd)));
}

// HOW FAR ALONG a starter profile is, in words a person can act on. "Learned" counts distinct
// traits (layer + field), not observations: ten corrections about length are one thing learned.
// The stages are about what to do next, which is the point of saying it at all: early on, keep
// working; once it is a solid start, the phone app is what adds the rest (its interview and the
// decisions the subject approves, which sessions cannot show). Cut-offs are deliberately coarse
// and are not a confidence measure — the projection's own confidence section is that.
export const STARTER_STAGES = [
  { min: 8, text: 'a solid start. The Phaedo phone app adds what sessions can\'t show (https://phaedo.so).' },
  { min: 3, text: 'taking shape; it keeps learning as you work.' },
  { min: 0, text: 'just getting started; it fills in as you work.' },
];

export async function summarizeStarter(vd) {
  const layers = (vd && vd.phaedo_fingerprint && vd.phaedo_fingerprint.layers) || {};
  const traits = new Set();
  let areas = 0;
  for (const [id, layer] of Object.entries(layers)) {
    const sigs = (layer && Array.isArray(layer.signals)) ? layer.signals : [];
    if (sigs.length) areas++;
    for (const sg of sigs) if (sg && sg.field) traits.add(`${id}.${sg.field}`);
  }
  const learned = traits.size;
  const sessions = await localCaptureSessionCount();
  const stage = STARTER_STAGES.find((st) => learned >= st.min).text;
  return { learned, areas, sessions, stage };
}

/** One line for the server log describing where the profile will come from, or null when there
 *  is nothing a person needs told. Never touches the phone: a pull at startup would put an
 *  "authorize" card on it with nobody asking. */
export async function profileStatusLine(baseDir) {
  const env = process.env.PHAEDO_FINGERPRINT;
  if (env === SAMPLE_KEYWORD) return 'using the made-up example profile (PHAEDO_FINGERPRINT=sample).';
  if (env) return null;
  if (hasPairingRecord(baseDir)) return null;
  if (existsSync(resolve(configDir(baseDir), 'fingerprint.json'))) return null;
  const starter = await loadStarterProfile(undefined, baseDir);
  if (starter) {
    const { learned, areas, sessions, stage } = await summarizeStarter(starter);
    return `no phone paired; using a starter profile from your own sessions on this computer: ` +
      `${learned} thing${learned === 1 ? '' : 's'} learned across ${areas} area${areas === 1 ? '' : 's'}` +
      `${sessions ? ` from ${sessions} session${sessions === 1 ? '' : 's'}` : ''} — ${stage}`;
  }
  if (isDirectoryEdition(baseDir)) return DIRECTORY_NO_PROFILE_LOG;
  return process.env.CLAUDE_PLUGIN_ROOT ? PLUGIN_NO_PROFILE_LOG : NO_PROFILE_LOG;
}

// Returns the vault payload:
//   { phaedo_fingerprint, phaedo_behavioral_signals, phaedo_linguistic_profile,
//     phaedo_session_metrics }
// Throws on unreadable/invalid source — the tool layer maps that to
// decryption_failed (the §9.5 "couldn't obtain plaintext fingerprint" case).
// PROVENANCE. A cache fallback used to be indistinguishable from a live phone read — same
// object, same shape, no marker anywhere — so an agent answered "yes, you're pre-approved"
// from a 22-hour-old snapshot with total confidence, and `pull.js` printed "Read your
// profile from the phone" either way. There was no signal to notice. Callers that make
// AUTHORITY decisions must be able to tell the difference.
//
// Carried on a SYMBOL deliberately: it never serializes, never reaches a schema, never rides
// a sync, and cannot be mistaken for spec'd fingerprint content. It is a fact about THIS
// read, not about the artifact.
export const SOURCE = Symbol('phaedo.fingerprint.source');

function stamp(vd, cached) {
  if (!vd || typeof vd !== 'object') return vd;
  const cachedAt = Number(cached?.cachedAt) || null;   // readCache returns { vault, cachedAt }
  try {
    Object.defineProperty(vd, SOURCE, {
      value: { live: false, cachedAt, ageMs: cachedAt ? Date.now() - cachedAt : null },
      enumerable: false, configurable: true, writable: true,
    });
  } catch { /* frozen object — provenance is best-effort, never fatal */ }
  return vd;
}

// A starter profile is read fresh every load (live), but it did not come from a phone —
// `pull.js` must not say it did.
function markStarter(vd) {
  try {
    Object.defineProperty(vd, SOURCE, {
      value: { live: true, cachedAt: null, ageMs: 0, starter: true },
      enumerable: false, configurable: true, writable: true,
    });
  } catch { /* frozen object — provenance is best-effort, never fatal */ }
  return vd;
}

/** Provenance of a loaded fingerprint. Absent marker → a live read. */
export function sourceOf(vd) {
  const s = vd && vd[SOURCE];
  return s || { live: true, cachedAt: null, ageMs: 0 };
}

export async function loadFingerprint(baseDir) {
  // Explicit local source wins over phone pairing: if PHAEDO_FINGERPRINT names a
  // file, honor it and skip the phone entirely. Pointing at a concrete fingerprint
  // is an unambiguous "use THIS" — it lets a user force a local file and makes the
  // server hermetic for tests on a phone-paired dev machine (where pairing.json +
  // an isolated state dir would otherwise pull from an unreachable phone with no
  // cache to fall back to).
  if (!process.env.PHAEDO_FINGERPRINT && hasPairingRecord(baseDir)) {
    // Phase 1b: a configured pairing record means pull the live fingerprint from
    // the paired phone over the encrypted boundary (no plaintext at rest). On
    // success, refresh the encrypted at-rest cache; if the phone is unreachable,
    // serve the cache so the server still works phone-absent (frictionless default).
    const rec = await loadPairingRecord(baseDir);
    const stateDir = defaultStateDir();
    try {
      const vd = await loadFingerprintFromPhone(rec);
      await writeCache(stateDir, vd);
      return foldConfigHome(normalizeIdentity(vd));
    } catch (err) {
      // A 4xx means the phone REACHED us and rejected this client (revoked /
      // invalid credentials / failed handshake). Revocation must be effective:
      // purge the at-rest cache and fail, so a revoked agent can't keep serving a
      // cached copy. Only a transient/unreachable failure (network, timeout, 5xx)
      // falls back to the cache — the phone-absent design (1b-iii).
      if (err instanceof PhoneError && err.status >= 400 && err.status < 500) {
        await clearCache(stateDir);
        throw err;
      }
      const cached = await readCache(stateDir);
      if (cached) return stamp(foldConfigHome(normalizeIdentity(cached.vault)), cached); // phone unreachable → encrypted cache (may be stale)
      throw err;                        // no phone + no cache → cannot serve
    }
  }

  const path = resolveSourcePath(baseDir);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    // Only the default location may be absent quietly. A path the user NAMED that doesn't
    // read is their mistake to see, not "no profile".
    if (!process.env.PHAEDO_FINGERPRINT && err?.code === 'ENOENT') {
      const starter = await loadStarterProfile(undefined, baseDir);
      if (starter) return starter;
      throw new PhaedoError('decryption_failed', noProfileMessage(process.env, baseDir));
    }
    throw new PhaedoError('decryption_failed', `Could not read the Phaedo profile at ${path} (${err?.code || err?.message || err}).`);
  }
  const vd = JSON.parse(raw);
  if (!vd || typeof vd !== 'object' || !vd.phaedo_fingerprint) {
    throw new Error(`Fingerprint source at ${path} is missing phaedo_fingerprint.`);
  }
  // mcp-local capture tier (desktop-capture-deposit.md §4 tier 3): unpaired,
  // phone-less serving is the one configuration where NOBODY else drains what the
  // capture hook accumulated on this machine — fold its local state into the
  // served fingerprint at read time (capture-local.js; read-time overlay, no
  // persistence, idempotent). Owner-gated: a paired setup never reaches this
  // branch, and an explicit PHAEDO_FINGERPRINT ("use THIS file") stays verbatim —
  // it is the hermetic-test escape hatch.
  if (!process.env.PHAEDO_FINGERPRINT && !isDirectoryEdition(baseDir) && await isLocalCaptureOwner(hasPairingRecord(baseDir))) {
    return foldConfigHome(normalizeIdentity(await foldLocalCapture(vd)));
  }
  return foldConfigHome(normalizeIdentity(vd));
}

// Like loadFingerprint, but PREFERS the at-rest encrypted cache over a live phone pull.
// Used by the escalation path so reading the fingerprint (to compute the consult signal)
// doesn't trigger a SECOND prompt — the fingerprint-read AUTHORIZE — on top of the
// escalation decision card the subject already answers. One prompt per escalation, not two.
//
// The cache is seeded + refreshed by the normal live-pull consults, so it stays current; a
// consult SIGNAL tolerates a slightly-stale fingerprint (it doesn't change minute to minute).
// Falls back to a live pull only when no cache exists yet (first run on this machine), which
// seeds it. Revocation safety is unaffected: a revoked MCP's escalation can't be decrypted by
// the phone anyway (its client entry is gone), so it never reaches the subject regardless of
// what the MCP read locally.
// Like loadFingerprint, but PREFERS the at-rest encrypted cache over a live phone pull.
// Used by the escalation path so reading the fingerprint (to compute the consult signal)
// NEVER triggers an interactive fingerprint-read AUTHORIZE on top of the escalation
// decision card. One prompt per escalation — the decision — not two, and critically no
// authorize modal racing the decision modal on the phone (that double-present crashed iOS).
//
// Uses ANY decryptable cache regardless of age. Revocation is enforced PHONE-SIDE for the
// escalation path: a revoked agent's escalation can't be decrypted by the phone (its client
// registry entry is gone), so reading a stale cache here yields nothing the agent can
// actually deliver to the subject. (The normal consult path — loadFingerprint — still does
// the live pull with its 4xx-purge revocation, so a revoked agent stops getting fresh reads
// there.) Falls through to a live pull ONLY when no cache exists at all (first run on this
// machine), which seeds it; run one phaedo_consult after pairing to seed without an
// escalation in flight.
export async function loadFingerprintPreferCache(baseDir) {
  if (!process.env.PHAEDO_FINGERPRINT && hasPairingRecord(baseDir)) {
    const cached = await readCache(defaultStateDir());
    if (cached) return stamp(foldConfigHome(normalizeIdentity(cached.vault)), cached);
  }
  return loadFingerprint(baseDir);
}
