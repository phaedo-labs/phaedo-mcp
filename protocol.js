// Phaedo Protocol constants. Single source of truth on the extension side.
// Matches mobile/src/lib/protocol.ts — keep both in sync.
// See docs/protocol/v0.1.md for the authoritative spec.
//
// Loaded as a plain script before vault.js and popup.js. Exposes globalThis.Phaedo.Protocol.

(function () {
  const Protocol = {
    /** Phaedo Protocol version. Sent on the wire in pairing payloads. */
    VERSION: '0.1.1',

    /** Envelope format version. Goes into phaedo_envelope_version field per spec §7.2. */
    ENVELOPE_VERSION: '0.1',

    /** Portable export wrapper version. Goes into phaedo_export_version per spec §8.2. */
    EXPORT_VERSION: '0.1',

    /** Encryption algorithm. v0.1 normative: AES-256-GCM only. Spec §7.1. */
    ALG: 'AES-256-GCM',

    /**
     * HKDF info labels. Domain separation between key derivation contexts.
     * MUST be byte-identical on mobile and extension or keys will diverge.
     */
    HKDF_INFO: {
      PAIR_KEY:        'phaedo-pair-key-v0.1',
      SESSION_KEY:     'phaedo-session-v0.1',
      SAS_FINGERPRINT: 'phaedo-sas-v0.1',
      // Seed-transfer key for QR-free pairing (spec §8.4). A sub-key of
      // pair_key so the GCM seed envelope never reuses pair_key's HMAC role.
      SEED_KEY:        'phaedo-seed-v0.1',
      // Fingerprint-sync mailbox key (Proposal 0008). A distinct sub-key of
      // pair_key so the store-and-forward fingerprint envelope is decryptable by
      // either device with no live session — and never reuses any other role's key.
      FP_SYNC_KEY:     'phaedo-fp-sync-v0.1',
    },

    /** Sizes in bytes — fixed by spec §7.2. */
    SIZES: {
      X25519_PUBKEY:  32,
      X25519_PRIVKEY: 32,
      AES_KEY:        32,
      AES_IV:         12,
      AES_TAG:        16,
      HKDF_SALT:      16,
      SAS_BYTES:      4,
    },

    /** Artifact kind tags in envelope metadata. Spec §7.2. */
    ARTIFACT_KIND: {
      FINGERPRINT:        'fingerprint',
      USER_CONFIGURATION: 'user_configuration',
      EXCHANGE_BATCH:     'exchange_batch',     // Loop 2 qualifying-session batch (the local-pass payload shape)
    },
  }

  // Attach to globalThis so content scripts, popup, and interview adapters all see it.
  globalThis.Phaedo = globalThis.Phaedo || {}
  globalThis.Phaedo.Protocol = Protocol
})()
