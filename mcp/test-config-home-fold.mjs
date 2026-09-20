// §5 canonical on read, folded at the vd boundary — the agent's step-3 read path.
//
// The agent's authored-content readers (ap2.js buildIntentMandatePayload, autonomy-promotion.js,
// consult-core.js delegation authoring) all take a FINGERPRINT, not a vault. Threading the §5
// configuration into each would mean four signatures, four callers, and four places that must
// each remember §5.4. Folding once at the boundary makes them all correct by construction — and
// means step 3 (deleting fp.standing_rules) changes nothing about what any of them see.
//
// That is the whole claim behind the agent advertising config_home_v0.2, so it is checked here
// rather than declared in a constant.
//
//   node mcp/test-config-home-fold.mjs

import assert from 'assert';
import { createRequire } from 'module';
import { foldConfigHome } from './fingerprint-source.js';
import { loadPolicies } from './consult-policy.js';
import { buildIntentMandatePayload } from './ap2.js';

const require = createRequire(import.meta.url);
const Caps = require('../capabilities.js');

let pass = 0, fail = 0;
const ok = (c, m) => { try { assert.ok(c, m); console.log('  ✓', m); pass++; } catch (e) { console.log('  ✗', m); fail++; } };

const FP_ID = 'fp-1';
const grant = (id, domain) => ({
  instruction_id: id, kind: 'authorization', match: { domains: [domain] }, effect: 'autoproceed',
});
const cfgWith = (instructions, over = {}) => ({
  configuration_id: 'c-1', fingerprint_id: FP_ID, subject_id: 's-1',
  standing_instructions: instructions, ...over,
});

console.log('\n§5 replaces the A-home at the boundary');
{
  const vd = foldConfigHome({
    phaedo_fingerprint: { fingerprint_id: FP_ID, subject_id: 's-1', standing_rules: [grant('a-home', 'legal')] },
    phaedo_user_configuration: cfgWith([grant('cfg', 'writing')]),
  });
  const ids = (vd.phaedo_fingerprint.standing_rules || []).map((r) => r.instruction_id);
  ok(ids.includes('cfg') && !ids.includes('a-home'),
    'the fingerprint handed downstream carries the §5 rules, not the A-home\'s');
}

console.log('\nthe cutover changes nothing — A-home DELETED, same result');
{
  // This is step 3, simulated: the fingerprint no longer has standing_rules at all.
  const postCutover = foldConfigHome({
    phaedo_fingerprint: { fingerprint_id: FP_ID, subject_id: 's-1' },
    phaedo_user_configuration: cfgWith([grant('cfg', 'writing')]),
  });
  const rules = postCutover.phaedo_fingerprint.standing_rules || [];
  ok(rules.length === 1 && rules[0].instruction_id === 'cfg',
    'with the A-home gone the agent still sees the subject\'s authored rules');

  // And the highest-stakes downstream reader agrees: a payment mandate is minted against these.
  const mandate = buildIntentMandatePayload(postCutover.phaedo_fingerprint, { agentId: 'a1' });
  ok(!!mandate, 'buildIntentMandatePayload still produces a mandate post-cutover');
}

console.log('\n§5.4 — a configuration that is not this subject\'s does NOT govern');
{
  const misPaired = foldConfigHome({
    phaedo_fingerprint: { fingerprint_id: FP_ID, subject_id: 's-1', standing_rules: [grant('a-home', 'legal')] },
    phaedo_user_configuration: cfgWith([grant('cfg', 'writing')], { fingerprint_id: 'fp-OTHER' }),
  });
  const ids = (misPaired.phaedo_fingerprint.standing_rules || []).map((r) => r.instruction_id);
  ok(ids.includes('a-home') && !ids.includes('cfg'),
    'a mis-paired configuration cannot supply the agent\'s authorizations');

  const wrongSubject = foldConfigHome({
    phaedo_fingerprint: { fingerprint_id: FP_ID, subject_id: 's-1', standing_rules: [grant('a-home', 'legal')] },
    phaedo_user_configuration: cfgWith([grant('cfg', 'writing')], { subject_id: 's-OTHER' }),
  });
  ok(!(wrongSubject.phaedo_fingerprint.standing_rules || []).map((r) => r.instruction_id).includes('cfg'),
    'a contradicting subject_id is rejected too');
}

console.log('\nEMPTY means empty — a deleted rule set is not an absent one');
{
  const emptied = foldConfigHome({
    phaedo_fingerprint: { fingerprint_id: FP_ID, subject_id: 's-1', standing_rules: [grant('a-home', 'legal')] },
    phaedo_user_configuration: cfgWith([]),
  });
  ok(!emptied.phaedo_fingerprint.standing_rules,
    'an empty §5 rule set REMOVES the A-home rules rather than falling back to them — otherwise '
    + 'the agent would keep acting on grants the subject had just revoked');
}

console.log('\nthe fold never crashes and never invents rules');
{
  for (const [label, vd] of [
    ['null', null],
    ['garbage', 'nope'],
    ['no config', { phaedo_fingerprint: { fingerprint_id: FP_ID, standing_rules: [grant('a', 'x')] } }],
    ['no fingerprint', { phaedo_user_configuration: cfgWith([grant('c', 'x')]) }],
    ['config without instructions', { phaedo_fingerprint: { fingerprint_id: FP_ID, subject_id: 's-1' }, phaedo_user_configuration: cfgWith(undefined) }],
  ]) {
    let threw = false;
    let out;
    try { out = foldConfigHome(vd); } catch { threw = true; }
    ok(!threw, `${label}: does not throw`);
    if (label === 'no config') {
      ok((out.phaedo_fingerprint.standing_rules || []).length === 1,
        '…and with no configuration the A-home is left exactly as it was');
    }
  }
}

console.log('\nloadPolicies agrees with the boundary fold — duplicated rule, so pin it');
{
  // consult-policy.js keeps its own §5 handling as defence in depth (a caller that builds vd by
  // hand never passes the boundary). Two implementations of one rule is this codebase's recurring
  // bug, so require that they reach the same verdict.
  const cases = [
    ['governs', { phaedo_fingerprint: { fingerprint_id: FP_ID, subject_id: 's-1', standing_rules: [grant('a-home', 'legal')] },
                  phaedo_user_configuration: cfgWith([grant('cfg', 'writing')]) }],
    ['mis-paired', { phaedo_fingerprint: { fingerprint_id: FP_ID, subject_id: 's-1', standing_rules: [grant('a-home', 'legal')] },
                     phaedo_user_configuration: cfgWith([grant('cfg', 'writing')], { fingerprint_id: 'fp-OTHER' }) }],
    ['empty governs', { phaedo_fingerprint: { fingerprint_id: FP_ID, subject_id: 's-1', standing_rules: [grant('a-home', 'legal')] },
                        phaedo_user_configuration: cfgWith([]) }],
  ];
  for (const [label, vd] of cases) {
    const viaFold = loadPolicies(foldConfigHome(vd)).map((r) => r.id).sort();
    const direct = loadPolicies(vd).map((r) => r.id).sort();
    ok(JSON.stringify(viaFold) === JSON.stringify(direct),
      `${label}: folding first changes nothing — both give ${JSON.stringify(direct)}`);
  }
}

console.log('\nthe agent may now claim the capability, and does');
{
  ok(Caps.CAPABILITIES_BY_SURFACE.agent.includes(Caps.CONFIG_HOME),
    'the agent advertises config_home_v0.2');
  ok(Caps.advertise('agent').capabilities.includes(Caps.CONFIG_HOME),
    '…and advertise() reflects it');
}

console.log(`\n${fail ? '✗' : '✓'} §5 config-home fold: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
