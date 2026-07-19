// Key derivation helpers using native WebCrypto HKDF-SHA-256.
//
// Mirror of mobile/src/lib/kdf.ts. Both sides produce identical bytes for
// identical inputs.
//
// Loaded as a plain script after protocol.js. Exposes globalThis.Phaedo.Kdf.

(function () {
  const P = globalThis.Phaedo.Protocol

  function utf8(s) { return new TextEncoder().encode(s) }

  async function hkdfBytes(ikm, salt, info, outputLen) {
    const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info },
      key,
      outputLen * 8,
    )
    return new Uint8Array(bits)
  }

  async function derivePairKey(sharedSecret, clientId) {
    return hkdfBytes(
      sharedSecret,
      utf8(clientId),
      utf8(P.HKDF_INFO.PAIR_KEY),
      P.SIZES.AES_KEY,
    )
  }

  /**
   * Seed-transfer key for QR-free pairing (spec §8.4). HKDF-Expand of the
   * SAS-verified pair_key under a distinct context, so the AES-GCM seed
   * envelope never reuses pair_key's HMAC-in-authorize role. Re-derivable
   * from the stored pair_key, so the seed ship step holds no extra state.
   */
  async function deriveSeedKey(pairKey) {
    return hkdfBytes(
      pairKey,
      new Uint8Array(0),
      utf8(P.HKDF_INFO.SEED_KEY),
      P.SIZES.AES_KEY,
    )
  }

  /**
   * Fingerprint-sync mailbox key (Proposal 0008). A distinct sub-key of pair_key,
   * so the store-and-forward fingerprint envelope is decryptable by either device
   * with NO live session or biometric — and never reuses pair_key's HMAC role or
   * seed_key's. Re-derivable from the stored pair_key, so neither side holds state.
   */
  async function deriveFpSyncKey(pairKey) {
    return hkdfBytes(
      pairKey,
      new Uint8Array(0),
      utf8(P.HKDF_INFO.FP_SYNC_KEY),
      P.SIZES.AES_KEY,
    )
  }

  async function deriveSessionKey(ephemeralShared, sessionToken) {
    return hkdfBytes(
      ephemeralShared,
      utf8(sessionToken),
      utf8(P.HKDF_INFO.SESSION_KEY),
      P.SIZES.AES_KEY,
    )
  }

  function compareBytes(a, b) {
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) return a[i] - b[i]
    }
    return a.length - b.length
  }

  async function deriveSAS(pubA, pubB) {
    const [first, second] = compareBytes(pubA, pubB) <= 0 ? [pubA, pubB] : [pubB, pubA]
    const combined = new Uint8Array(first.length + second.length)
    combined.set(first, 0)
    combined.set(second, first.length)
    return hkdfBytes(
      combined,
      new Uint8Array(0),
      utf8(P.HKDF_INFO.SAS_FINGERPRINT),
      P.SIZES.SAS_BYTES,
    )
  }

  const EPH_AUTH_LABEL = 'phaedo-eph-auth-v0.1'

  /**
   * HMAC-SHA-256(pair_key, role_label || ephPub).
   * Binds the ephemeral exchange in authorize to the established pair_key.
   * @param role 'ext' or 'vault' — prevents MAC replay across directions.
   */
  async function authEphemeral(pairKey, role, ephPub) {
    const label = utf8(`${EPH_AUTH_LABEL}|${role}|`)
    const msg = new Uint8Array(label.length + ephPub.length)
    msg.set(label, 0)
    msg.set(ephPub, label.length)
    const macKey = await crypto.subtle.importKey(
      'raw', pairKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
    )
    return new Uint8Array(await crypto.subtle.sign('HMAC', macKey, msg))
  }

  /** Constant-time MAC verification. */
  async function verifyAuthEphemeral(pairKey, role, ephPub, expectedMac) {
    const computed = await authEphemeral(pairKey, role, ephPub)
    if (computed.length !== expectedMac.length) return false
    let diff = 0
    for (let i = 0; i < computed.length; i++) diff |= computed[i] ^ expectedMac[i]
    return diff === 0
  }

  /** Format SAS bytes as a human-readable "XX-XX-XX-XX" hex string. */
  function formatSAS(sasBytes) {
    return Array.from(sasBytes, b => b.toString(16).padStart(2, '0').toUpperCase()).join('-')
  }

  globalThis.Phaedo = globalThis.Phaedo || {}
  globalThis.Phaedo.Kdf = {
    derivePairKey, deriveSeedKey, deriveFpSyncKey, deriveSessionKey, deriveSAS, formatSAS,
    authEphemeral, verifyAuthEphemeral,
  }
})()
