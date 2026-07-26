// §10.2 `action_descriptor.domain` — normalization and the published vocabulary.
//
// WHY ANY OF THIS EXISTS. `domain` is a bare `{"type":"string"}` the AGENT picks, and
// everything downstream keys on it verbatim: §10.5 rule matching, the §10.6 receipt,
// the delegation tally, §10.7's per-class approval counts. Observed live on the dev
// machine: `financial` ×16, `finance` ×26, `finance.crypto_trading` ×1 — one concept,
// three keys, and 7 approvals split 3/4 so neither class reached §10.7's
// `MIN_APPROVALS = 5`. Analysis: `docs/roadmap/domain-identity-2026-07-22.md`.
//
// TWO FUNCTIONS, DELIBERATELY DISTINCT. Conflating them is how an alias table starts
// granting authority nobody authored.
//
//   normalizeDomain()  lowercase + trim + collapse whitespace. Pure presentation;
//                      `"Finance"` and `" finance"` cannot mean different things, so
//                      merging them can lose no distinction anyone intended.
//
//   canonicalDomain()  normalizeDomain, then map a published ALIAS onto its canonical
//                      term (`financial` → `finance`). This is a SEMANTIC claim, and
//                      it is only safe where a wrong merge cannot expand authority.
//
// THE SAFETY PROPERTY, stated once and enforced at every call site: a vocabulary alias
// may widen a GUARDRAIL's reach, never a GRANT's. `canonicalDomain` is therefore used
// for evidence classification and for matching RESTRICTIVE rules; relaxing rules
// (`autoproceed`, `bias_bold`) keep matching on `normalizeDomain` alone, exactly as
// before. So adopting this vocabulary cannot hand any client more autonomy than it
// already had — it can only make an existing guardrail cover more. If the table below
// is wrong, the failure is "an agent asks when it needn't", never the reverse.
//
// ALIASES ARE SYNONYMS, NEVER GENERALIZATIONS. `financial` → `finance` is a synonym.
// `crypto_trading` → `finance` would be a child→parent generalization, and it is
// forbidden: a grant authored for the general class would silently cover a narrower,
// riskier one the subject never demonstrated. Same defect that made dotted-suffix
// stripping unsafe (v0.1.55), which is why `investing` is its own term here rather
// than a `finance` alias, and why `crypto_trading` is absent entirely — an
// unrecognized domain still works, it just does not merge.
//
// PUBLISHED, not private. The vocabulary below is a copy of `spec/domains.json` so the
// npm package (whose `files` whitelist excludes `spec/`) is self-contained;
// `mcp/test-domain.mjs` asserts the two cannot drift. A private synonym table would
// put decision semantics somewhere the subject cannot read and a third-party
// implementer cannot reproduce.

/** Canonical terms → their aliases. Mirror of spec/domains.json `domains`. */
const VOCABULARY = {
  finance:       ['financial', 'finances', 'money', 'billing', 'invoicing', 'expenses', 'accounting'],
  investing:     ['investment', 'investments', 'trading', 'brokerage', 'portfolio'],
  legal:         ['contracts', 'compliance', 'regulatory'],
  health:        ['medical', 'healthcare', 'wellness', 'clinical'],
  scheduling:    ['calendar', 'meetings', 'appointments', 'availability', 'booking'],
  communication: ['email', 'outbound email', 'messaging', 'messages', 'comms', 'correspondence'],
  writing:       ['drafting', 'editing', 'content', 'copywriting', 'documentation'],
  research:      ['analysis', 'reading', 'summarization', 'search'],
  shopping:      ['purchasing', 'purchase', 'procurement', 'orders', 'commerce', 'ecommerce'],
  travel:        ['trips', 'flights', 'lodging', 'itinerary', 'transportation'],
  engineering:   ['code', 'coding', 'software', 'development', 'dev', 'devops', 'infrastructure', 'deployment'],
  data:          ['files', 'records', 'storage', 'database', 'export'],
  security:      ['access', 'permissions', 'credentials', 'authentication', 'authorization'],
  people:        ['hr', 'human resources', 'hiring', 'recruiting', 'personnel', 'staffing'],
  social:        ['social media', 'posting', 'publishing', 'community'],
  support:       ['customer support', 'customer service', 'helpdesk', 'tickets'],
  admin:         ['administration', 'settings', 'accounts', 'subscriptions', 'operations', 'ops'],
};

/** alias → canonical, plus every canonical term mapping to itself. */
const ALIAS_TO_CANONICAL = (() => {
  const m = new Map();
  for (const [term, aliases] of Object.entries(VOCABULARY)) {
    m.set(term, term);
    for (const a of aliases) m.set(a, term);
  }
  return m;
})();

export const VOCABULARY_TERMS = Object.freeze(Object.keys(VOCABULARY).sort());
export const VOCABULARY_MAP = VOCABULARY;

/**
 * Presentation-only normalization. Returns '' for anything unusable, which every
 * caller already treats as "no domain".
 */
export function normalizeDomain(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Normalize, then resolve a published alias to its canonical term. An unrecognized
 * domain is returned normalized but otherwise untouched — free text stays legal and
 * behaves exactly as it does today. Never throws.
 */
export function canonicalDomain(raw) {
  const n = normalizeDomain(raw);
  if (!n) return '';
  return ALIAS_TO_CANONICAL.get(n) || n;
}

/** True iff this domain resolves to a published vocabulary term. */
export function isVocabularyTerm(raw) {
  const n = normalizeDomain(raw);
  return !!n && ALIAS_TO_CANONICAL.has(n);
}
