// Phaedo §9 Injection projection for the MCP binding.
//
// Reuses context-block.js (PhaedoContext) — the SAME renderer the Chrome
// extension injects — so MCP injection is byte-identical to web injection.
// Wraps the rendered block in the §9.3 Injection Response shape.

import { createRequire } from 'module';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
// context-block.js is the shared renderer; in the dev repo it lives at the root
// (one source of truth with the extension). For a self-contained npm package,
// `npm run build` / prepack copies it next to this file — prefer the local copy
// when present, else fall back to the repo root.
const HERE = dirname(fileURLToPath(import.meta.url));
const vendored = join(HERE, 'vendor', 'context-block.js');
require(existsSync(vendored) ? vendored : '../context-block.js');
const PhaedoContext = globalThis.PhaedoContext;
if (!PhaedoContext || !PhaedoContext.renderContextBlock) {
  throw new Error('context-block.js did not expose PhaedoContext.renderContextBlock');
}

// §9.5 error codes (the six v0.1 codes) + PhaedoError now live in errors.js so the
// pure consultation core can share the class without importing this renderer.
// Re-exported here so existing `import { … } from './projection.js'` sites are
// unchanged and `instanceof PhaedoError` holds across the package.
import { ERROR_CODES, PhaedoError } from './errors.js';
export { ERROR_CODES, PhaedoError };

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h, mirrors the session-scoped boundary

// persona_strength [0,1]: prefer a stored value; otherwise a bounded, monotone
// v0.1 estimate from the same axes the fingerprint sharpens along (NOT claimed
// calibrated — placeholder pending the calibration track).
function estimatePersonaStrength(vd) {
  const fp = vd.phaedo_fingerprint || {};
  if (typeof fp.persona_strength === 'number') return Math.max(0, Math.min(1, fp.persona_strength));
  const layers = fp.layers || {};
  let answered = 0, total = 0;
  for (const layer of Object.values(layers)) {
    const resp = layer.responses || [];
    total += resp.length;
    answered += resp.filter(r => (r.answer || '').trim()).length;
  }
  const ling = vd.phaedo_linguistic_profile || {};
  const answeredRatio = total ? answered / total : 0;
  const msgFactor = 1 - Math.exp(-((ling.messageCount || 0) / 200));
  return Math.round((0.5 * answeredRatio + 0.5 * msgFactor) * 100) / 100;
}

// Filter the vault payload's fingerprint to a requested layer subset (canonical
// layer ids). Returns { vd, included }. ["all"] (or empty) → full passthrough.
function selectLayers(vd, requestedLayers) {
  const wantAll = !requestedLayers || requestedLayers.length === 0 || requestedLayers.includes('all');
  const layers = (vd.phaedo_fingerprint && vd.phaedo_fingerprint.layers) || {};
  if (wantAll) return { vd, included: Object.keys(layers) };

  const included = requestedLayers.filter(id => layers[id]);
  if (!included.length) {
    throw new PhaedoError('layer_not_available', `None of the requested layers exist: ${requestedLayers.join(', ')}`);
  }
  const filteredLayers = {};
  for (const id of included) filteredLayers[id] = layers[id];
  const filteredVd = {
    ...vd,
    phaedo_fingerprint: { ...vd.phaedo_fingerprint, layers: filteredLayers },
  };
  return { vd: filteredVd, included };
}

// Build a §9.3 Injection Response from a vault payload + a §9.2-shaped request.
// `now` is injectable for deterministic tests. Throws PhaedoError on §9.5 cases.
export function buildInjectionResponse(vd, request = {}, now = Date.now()) {
  if (!vd || !vd.phaedo_fingerprint) {
    throw new PhaedoError('decryption_failed', 'No fingerprint available from the configured source.');
  }
  const mode = request.mode || 'standard';
  if (mode === 'enhanced_privacy') {
    throw new PhaedoError('mode_not_supported', 'Enhanced privacy mode is not available in this build.');
  }
  if (mode !== 'standard') {
    throw new PhaedoError('request_malformed', `Unknown mode: ${mode}`);
  }
  if (request.requested_layers != null && !Array.isArray(request.requested_layers)) {
    throw new PhaedoError('request_malformed', 'requested_layers must be an array or ["all"].');
  }

  const { vd: selectedVd, included } = selectLayers(vd, request.requested_layers);
  const projection = PhaedoContext.renderContextBlock(selectedVd);
  if (!projection) {
    throw new PhaedoError('decryption_failed', 'Fingerprint produced no projection (empty or missing layers).');
  }

  const fp = vd.phaedo_fingerprint;
  return {
    phaedo_response_version: '0.1',
    request_type: 'injection',
    fingerprint_id: fp.fingerprint_id || fp.id || null,
    mode: 'standard',
    projection,
    layers_included: included,
    persona_strength: estimatePersonaStrength(vd),
    expires_at: new Date(now + DEFAULT_TTL_MS).toISOString(),
  };
}

export function errorResponse(err, requestType = 'injection') {
  const code = err instanceof PhaedoError ? err.code : 'internal_error';
  return {
    phaedo_response_version: '0.1',
    request_type: requestType,
    error: { code, message: err.message || code },
  };
}
