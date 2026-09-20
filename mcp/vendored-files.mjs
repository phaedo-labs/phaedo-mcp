// The single source of truth for WHICH monorepo modules the published MCP server carries.
//
// Two consumers have to agree on this list and previously each kept its own copy:
//   - mcp/build-package.mjs      copies them into mcp/vendor/ at pack time
//   - scripts/export-public-repo.mjs  ships them into the public open-core repo
//
// They drifted, and the drift was invisible because each list is correct in isolation.
// `commitments.js` was added to the vendor set when §5.7 shipped (v0.1.49) and never added
// to the export, and the export never carried `capture/` or the extraction modules at all —
// so the public repo could not run `npm run build` or `npm test`, because `mcp/vendor/` is
// gitignored there and rebuilt at pack time. Nobody noticed because nothing exercised the
// public tree end to end.
//
// Same shape as the other "two lists that must agree" bugs in this codebase: make it ONE
// list, and assert the tie. scripts/test_public_export.mjs is the assertion.
//
// NOTE ON WHAT IS PUBLIC: every file named here already ships publicly, verbatim, inside the
// `phaedo-mcp` npm tarball. Listing them for the open-core git repo discloses nothing new.
// The proprietary parts — the trained models, the corpus generation, the extension and mobile
// surfaces — are not here and must not be added.

/** Root-level modules vendored into mcp/vendor/. */
export const ROOT_FILES = [
  'authored-source.js',
  'capabilities.js',
  'context-block.js',
  'protocol.js',
  'envelope.js',
  'kdf.js',
  'identity.js',
  'commitments.js',
];

/** capture/ — the capture hook + tier-3 fold closure, vendored to mcp/vendor/capture/. */
export const CAPTURE_FILES = [
  'transcript.js',
  'exchanges.js',
  'capture-core.js',
  'detectors.js',
  'model-detect.js',
  'source-id.js',
  'state.js',
  'owner.js',
  'package.json',
];

/** extraction/ — vendored to mcp/vendor/extraction/. */
export const EXTRACTION_FILES = [
  'delta-lift.js',
  'persist.js',
  'reconcile.js',
  'rule-promotion.js',
  'capture-combine.js',
  'fingerprint-update.js',
  'resolve.js',
  'catalog.js',
  'package.json',
];

/**
 * Extra root modules the PUBLIC repo needs that are NOT vendored into the npm package.
 *
 * These exist so the public tree's own test suites can actually run. Shipping a repo whose
 * tests are present but unrunnable is worse than not shipping them: it reads as coverage
 * that does not exist.
 *
 * - `sync-merge.js`  — mcp/test-delegation-sync.mjs locks the extension-side merge round-trip
 *                      through `../sync-merge.js`.
 * - `migration.js`   — spec/test-schemas.mjs imports it (§4.2 envelope + §4.7 layer-key
 *                      migration; the producer↔schema tie asserts against it).
 * - `export.js`      — spec/test-vectors.mjs needs it for the §8.2 bootstrap-export vectors.
 * - `user-config.js` — spec/test-schemas.mjs imports it (§5 User Configuration sibling
 *                      artifact; the schema tie asserts the producer against it).
 *
 * Unlike ROOT_FILES these are NOT already public via the npm tarball, so adding to this list
 * is a real disclosure decision. `migration.js`, `export.js` and `user-config.js` were
 * owner-approved 2026-07-25 on a stated test: each is a reference implementation of a
 * PUBLISHED spec section (§4.2/§4.7, §8.2, §5) containing no model, no corpus and no key
 * material — which is precisely what an open-core spec repo is for. Each was read before
 * being added, not assumed. Apply the same test before adding anything else here.
 */
export const EXPORT_ONLY_ROOT_FILES = ['sync-merge.js', 'migration.js', 'export.js', 'user-config.js'];
