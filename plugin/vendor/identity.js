// Long-term X25519 identity keypair for this Phaedo extension instance.
//
// The private key is the extension's persistent cryptographic identity.
// Used at pair time to derive a shared pair_key with a paired vault device,
// and at session start to authenticate the extension's ephemeral session pubkey.
//
// Persistence: stored INSIDE the vault (encrypted under the vault's AES-GCM
// session key, see vault.js). This means using the identity requires the
// vault to be unlocked. Acceptable because pairing and authorize flows are
// only meaningful when the user is actively present.
//
// Loaded as a plain script after vault.js. Exposes globalThis.Phaedo.Identity.

(function () {
  const VAULT_FIELD = 'identity_v0.1'  // sub-key inside the vault object

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

  async function generate() {
    const kp = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
    const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
    const privateKeyJwk = await crypto.subtle.exportKey('jwk', kp.privateKey)
    return { publicKey: publicKeyRaw, privateKey: kp.privateKey, privateKeyJwk }
  }

  async function importStored(stored) {
    const publicKey  = b64uDecode(stored.publicKey)
    const privateKey = await crypto.subtle.importKey(
      'jwk', stored.privateKeyJwk, { name: 'X25519' }, false, ['deriveBits']
    )
    return { publicKey, privateKey }
  }

  /**
   * Return the extension's identity, generating one on first call.
   * Throws if the vault is locked — caller must unlock first.
   *
   * @returns {Promise<{ publicKey: Uint8Array, privateKey: CryptoKey }>}
   */
  async function getOrCreate() {
    const vault = await globalThis.phaedoVault.read()
    if (!vault) throw new Error('Phaedo.Identity: vault is locked')

    if (vault[VAULT_FIELD]) {
      return importStored(vault[VAULT_FIELD])
    }

    const fresh = await generate()
    await globalThis.phaedoVault.update({
      [VAULT_FIELD]: {
        publicKey:     b64uEncode(fresh.publicKey),
        privateKeyJwk: fresh.privateKeyJwk,
      },
    })
    return { publicKey: fresh.publicKey, privateKey: fresh.privateKey }
  }

  /**
   * Compute the long-term ECDH shared secret with a peer's identity pubkey.
   * @param {Uint8Array} peerPublicKey — 32 raw X25519 public key bytes
   * @returns {Promise<Uint8Array>} 32-byte shared secret (NOT a session key — feed through HKDF)
   */
  async function deriveSharedWithPeer(peerPublicKey) {
    if (peerPublicKey.length !== 32) {
      throw new Error(`Phaedo.Identity.deriveSharedWithPeer: peer pubkey must be 32 bytes, got ${peerPublicKey.length}`)
    }
    const { privateKey } = await getOrCreate()
    const peerKey = await crypto.subtle.importKey(
      'raw', peerPublicKey, { name: 'X25519' }, false, []
    )
    const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: peerKey }, privateKey, 256)
    return new Uint8Array(shared)
  }

  /** Just the public key. Convenience for QR display / pairing. */
  async function getPublicKey() {
    const { publicKey } = await getOrCreate()
    return publicKey
  }

  /**
   * Generate a fresh ephemeral X25519 keypair. Used per-session in the
   * authorize handshake. The returned privateKey CryptoKey will be GC'd
   * when its references drop — keep the closure scope tight.
   */
  async function generateEphemeral() {
    const kp = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
    return { publicKey, privateKey: kp.privateKey }
  }

  /** ECDH between an ephemeral private key and a peer's ephemeral pubkey bytes. */
  async function deriveEphemeralShared(selfEphPrivate, peerEphPublicBytes) {
    if (peerEphPublicBytes.length !== 32) {
      throw new Error(`Phaedo.Identity.deriveEphemeralShared: peer eph pubkey must be 32 bytes, got ${peerEphPublicBytes.length}`)
    }
    const peerKey = await crypto.subtle.importKey(
      'raw', peerEphPublicBytes, { name: 'X25519' }, false, []
    )
    const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: peerKey }, selfEphPrivate, 256)
    return new Uint8Array(shared)
  }

  globalThis.Phaedo = globalThis.Phaedo || {}
  globalThis.Phaedo.Identity = {
    getOrCreate, deriveSharedWithPeer, getPublicKey,
    generateEphemeral, deriveEphemeralShared,
  }
})()
