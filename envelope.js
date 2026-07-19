// Encryption envelope per Phaedo Protocol spec §7.2.
//
// Wraps artifact bytes (fingerprint or user configuration) in AES-256-GCM
// with cleartext metadata bound as Additional Authenticated Data.
//
// Mirror of mobile/src/lib/envelope.ts. The two MUST produce bit-identical
// wire bytes for identical (plaintext, key, metadata) inputs.
//
// Loaded as a plain script after protocol.js. Exposes globalThis.Phaedo.Envelope.

(function () {
  const P = globalThis.Phaedo.Protocol

  // ── Encoding helpers ───────────────────────────────────────────────────────

  function b64uEncode(bytes) {
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  function b64uDecode(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/')
    while (s.length % 4) s += '='
    const bin = atob(s)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  }

  /**
   * Stable-key JSON stringify. Sufficient for the metadata AAD path, which
   * contains only strings. NOT full RFC 8785 — when §8.3 signing lands and we
   * canonicalize artifact bytes with numeric fields, switch to a JCS impl.
   */
  function canonicalStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) {
      return '[' + value.map(canonicalStringify).join(',') + ']'
    }
    const keys = Object.keys(value).sort()
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}'
  }

  function utf8(s) { return new TextEncoder().encode(s) }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Wrap plaintext bytes in an envelope.
   *
   * @param plaintext Uint8Array of canonical artifact bytes
   * @param key       32-byte AES-256 key derived via HKDF from an ECDH shared secret
   * @param metadata  Cleartext metadata; bound via GCM AAD
   * @returns Promise<Envelope>
   */
  async function wrap(plaintext, key, metadata) {
    if (key.length !== P.SIZES.AES_KEY) {
      throw new Error(`envelope.wrap: key must be ${P.SIZES.AES_KEY} bytes, got ${key.length}`)
    }

    const iv  = crypto.getRandomValues(new Uint8Array(P.SIZES.AES_IV))
    const aad = utf8(canonicalStringify(metadata))

    const aesKey = await crypto.subtle.importKey(
      'raw', key, 'AES-GCM', false, ['encrypt']
    )
    const ctAndTagBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: P.SIZES.AES_TAG * 8 },
      aesKey,
      plaintext
    )
    const ctAndTag = new Uint8Array(ctAndTagBuf)
    const tagOffset = ctAndTag.length - P.SIZES.AES_TAG
    const ciphertext = ctAndTag.subarray(0, tagOffset)
    const tag        = ctAndTag.subarray(tagOffset)

    return {
      phaedo_envelope_version: P.ENVELOPE_VERSION,
      alg:                     P.ALG,
      iv:                      b64uEncode(iv),
      ciphertext:              b64uEncode(ciphertext),
      tag:                     b64uEncode(tag),
      metadata,
    }
  }

  /**
   * Unwrap an envelope. Rejects on version mismatch, algorithm mismatch, or
   * authentication tag failure (treated as integrity failure per spec §8.1).
   *
   * @returns Promise<Uint8Array> plaintext bytes
   */
  async function unwrap(envelope, key) {
    if (envelope.phaedo_envelope_version !== P.ENVELOPE_VERSION) {
      throw new Error(`envelope.unwrap: unsupported version ${envelope.phaedo_envelope_version}`)
    }
    if (envelope.alg !== P.ALG) {
      throw new Error(`envelope.unwrap: unsupported alg ${envelope.alg}`)
    }
    if (key.length !== P.SIZES.AES_KEY) {
      throw new Error(`envelope.unwrap: key must be ${P.SIZES.AES_KEY} bytes, got ${key.length}`)
    }

    const iv  = b64uDecode(envelope.iv)
    const ct  = b64uDecode(envelope.ciphertext)
    const tag = b64uDecode(envelope.tag)
    const aad = utf8(canonicalStringify(envelope.metadata))

    if (iv.length  !== P.SIZES.AES_IV)  throw new Error(`envelope.unwrap: iv must be ${P.SIZES.AES_IV} bytes`)
    if (tag.length !== P.SIZES.AES_TAG) throw new Error(`envelope.unwrap: tag must be ${P.SIZES.AES_TAG} bytes`)

    const ctAndTag = new Uint8Array(ct.length + tag.length)
    ctAndTag.set(ct, 0)
    ctAndTag.set(tag, ct.length)

    const aesKey = await crypto.subtle.importKey(
      'raw', key, 'AES-GCM', false, ['decrypt']
    )
    const ptBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: P.SIZES.AES_TAG * 8 },
      aesKey,
      ctAndTag
    )
    return new Uint8Array(ptBuf)
  }

  globalThis.Phaedo = globalThis.Phaedo || {}
  // canonicalStringify is exposed for the conformance test vectors (spec §6 /
  // spec/test-vectors): it is the only canonicalization v0.1 actually performs
  // (the metadata AAD binding). See its doc-comment for the RFC 8785 subset note.
  globalThis.Phaedo.Envelope = { wrap, unwrap, canonicalStringify }
})()
