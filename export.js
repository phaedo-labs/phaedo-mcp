// Phaedo portable export — bootstrap mode. Spec §8.2.
//
// Builds the cleartext bootstrap export object for the pre-pairing QR handoff
// to a vault device. The artifact travels in cleartext because no shared key
// exists yet; a keyless SHA-256 digest gives tamper-evidence over the wire.
//
// Loaded as a plain script after vault.js. Exposes globalThis.Phaedo.Export.

(function () {
  // phaedo_export_version field, spec §8.2. The export wrapper format version,
  // distinct from the protocol version.
  const EXPORT_VERSION = '0.1'

  function b64uEncode(bytes) {
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  // Sorted-key serialization. MUST match envelope.js canonicalStringify and the
  // mobile side (fingerprint.ts), or the digest will not verify.
  function canonicalStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']'
    const keys = Object.keys(value).sort()
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}'
  }

  /**
   * Build a bootstrap-mode portable export object (spec §8.2).
   *
   * @param artifact      cleartext artifact document (a fingerprint)
   * @param pairingToken  opaque token echoed in the pairing handshake
   * @param extPub        X25519 identity pubkey bytes, or null — the out-of-band
   *                      binding handlePair uses to detect a MITM
   * @returns Promise<object> the full export object, including its digest
   */
  async function buildBootstrapExport({ artifact, pairingToken, extPub }) {
    const obj = {
      phaedo_export_version: EXPORT_VERSION,
      mode:                  'bootstrap',
      artifact,
      pairing_token:         pairingToken,
    }
    if (extPub) obj.ext_pub = b64uEncode(extPub)

    // SHA-256 over the canonical serialization of the object with `digest`
    // omitted — i.e. everything assembled so far.
    const bytes  = new TextEncoder().encode(canonicalStringify(obj))
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    obj.digest   = b64uEncode(new Uint8Array(digest))
    return obj
  }

  /**
   * Build an encrypted seed envelope for QR-free pairing (Direction A; see
   * docs/roadmap/qr-free-pairing-plan.md and spec §8.4).
   *
   * Once the pair handshake establishes an SAS-verified `pair_key`, the
   * producer ships the cleartext artifact wrapped in a §7.2 envelope under
   * that key — replacing the cleartext artifact that bootstrap mode used to
   * carry over the camera channel. The relay sees only ciphertext.
   *
   * The envelope is keyed by seed_key = HKDF(pair_key, info="phaedo-seed-v0.1")
   * (spec §8.4), not pair_key directly — so the GCM key never reuses pair_key's
   * HMAC role in authorize.
   *
   * @param artifact  cleartext artifact document (a fingerprint)
   * @param pairKey   32-byte pair_key (Uint8Array), the SAS-verified ECDH/HKDF key
   * @returns Promise<object> a §7.2 envelope (Phaedo.Envelope.wrap shape)
   */
  async function buildSeedEnvelope({ artifact, pairKey }) {
    const Envelope = globalThis.Phaedo && globalThis.Phaedo.Envelope
    const Kdf      = globalThis.Phaedo && globalThis.Phaedo.Kdf
    if (!Envelope) throw new Error('Phaedo.Export.buildSeedEnvelope: Phaedo.Envelope not loaded')
    if (!Kdf)      throw new Error('Phaedo.Export.buildSeedEnvelope: Phaedo.Kdf not loaded')

    const seedKey   = await Kdf.deriveSeedKey(pairKey)
    const plaintext = new TextEncoder().encode(JSON.stringify(artifact))
    const metadata = {
      artifact_kind: 'fingerprint',
      created_at:    new Date().toISOString(),
    }
    // Carry fingerprint_id when the artifact has one, so the AAD binds it.
    const fpId = artifact && (artifact.fingerprint_id || artifact.id)
    if (fpId) metadata.fingerprint_id = fpId

    return Envelope.wrap(plaintext, seedKey, metadata)
  }

  globalThis.Phaedo = globalThis.Phaedo || {}
  globalThis.Phaedo.Export = { buildBootstrapExport, buildSeedEnvelope, EXPORT_VERSION }
})()
