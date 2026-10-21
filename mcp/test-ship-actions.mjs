#!/usr/bin/env node
// Ship-action classifier (ship-actions.js): which Bash commands the PreToolUse hook consults
// on. The failure that matters in each direction: a ship action missed is a decision with no
// receipt (the starvation this exists to end); a non-ship command matched is a consult — and
// possibly a prompt — on every `git status`.
// Run: node test-ship-actions.mjs   (from mcp/)

import assert from 'assert';
import { classifyShipCommand, splitCommands, words } from './ship-actions.js';
import { normalizeActionBinding } from './action-binding.js';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const cls = (cmd) => classifyShipCommand(cmd)?.class ?? null;

// ── The five classes, as they are actually typed in this repo's sessions ──────
ok(cls('gh pr merge 372 --squash --delete-branch') === 'merge_pr', 'gh pr merge');
ok(cls('cd ~/phaedo && gh pr merge --squash') === 'merge_pr', 'merge after cd &&');
ok(cls('fly deploy') === 'deploy', 'fly deploy');
ok(cls('cd relay && flyctl deploy -a phaedo-relay') === 'deploy', 'flyctl deploy -a');
ok(cls('npx eas build --platform ios --profile production') === 'app_build', 'npx eas build');
ok(cls('npx --yes eas-cli build -p ios') === 'app_build', 'npx --yes eas-cli build');
ok(cls('eas build --platform ios --auto-submit') === 'app_submit', '--auto-submit is a submit, not a build');
ok(cls('npx eas submit -p ios --latest') === 'app_submit', 'eas submit');
ok(cls('git push origin main') === 'push_main', 'push to main');
ok(cls('git push origin HEAD:main') === 'push_main', 'push HEAD:main');
ok(cls('/opt/homebrew/bin/gh pr merge 5') === 'merge_pr', 'absolute binary path');
ok(cls('CI=1 fly deploy') === 'deploy', 'leading env assignment');

// ── Not ship actions ───────────────────────────────────────────────────────────
for (const cmd of [
  'git status', 'gh pr view 372', 'gh pr create --fill', 'gh pr list --state merged',
  'git push -u origin claude/consult-before-ship', 'git push origin feature-main-fix',
  'fly status', 'fly logs -a phaedo-relay', 'eas build:list', 'npx eas whoami',
  'echo "fly deploy"', 'grep -rn "gh pr merge" docs', 'git commit -m "after fly deploy && gh pr merge"',
  '', '   ',
]) ok(cls(cmd) === null, `not a ship action: ${JSON.stringify(cmd)}`);
ok(classifyShipCommand(undefined) === null && classifyShipCommand(42) === null, 'non-string → null');

// ── Descriptors: stakes and reversibility per class ────────────────────────────
const m = classifyShipCommand('gh pr merge 372 --squash');
ok(m.action_descriptor.domain === 'engineering', 'domain is the canonical `engineering`');
ok(m.action_descriptor.magnitude === 'medium' && m.action_descriptor.reversible === true, 'merge: medium, reversible');
ok(m.summary === 'merge PR #372', 'merge summary names the PR');
ok(classifyShipCommand('gh pr merge').summary === "merge this branch's PR", 'unnumbered merge summary');
ok(classifyShipCommand('gh pr merge 9 --admin').action_descriptor.magnitude === 'high', '--admin merge is high');
ok(classifyShipCommand('fly deploy').action_descriptor.magnitude === 'high', 'deploy is high');
ok(classifyShipCommand('fly deploy -a phaedo-relay').summary === 'deploy phaedo-relay to Fly', 'deploy names the app');
ok(classifyShipCommand('eas build -p ios').action_descriptor.magnitude === 'low', 'build is low');
ok(classifyShipCommand('eas build --platform=ios').summary === 'phone build (ios)', '--platform= form');
const fp = classifyShipCommand('git push --force origin main');
ok(fp.action_descriptor.magnitude === 'high' && fp.action_descriptor.reversible === false, 'force-push to main: high, irreversible');
ok(classifyShipCommand('git push origin +main').action_descriptor.reversible === false, '+refspec is a force push');

// ── merge_pr carries its target, for the CI-state lookup (B6) ──────────────────
{
  const a = classifyShipCommand('gh pr merge 372 --squash');
  ok(a.pr === '372' && a.repo === null, 'merge: PR number, no repo');
  const b = classifyShipCommand('gh pr merge #12 -R phaedo-labs/phaedo');
  ok(b.pr === '12' && b.repo === 'phaedo-labs/phaedo', 'merge: #number and -R repo');
  ok(classifyShipCommand('gh pr merge --repo=o/r 3').repo === 'o/r', '--repo= form');
  ok(classifyShipCommand('gh pr merge --squash').pr === null, "unnumbered merge → the branch's PR (null)");
  ok(!('pr' in classifyShipCommand('fly deploy')), 'other classes carry no pr field');
}

// ── Compound lines: the highest-stakes action wins, and the chain is flagged ───
const both = classifyShipCommand('gh pr merge 5 --squash && cd relay && fly deploy');
ok(both.class === 'deploy' && both.multiple === true, 'merge-then-deploy: consulted on the deploy, flagged multiple');
ok(both.action_binding.arguments_preview === 'fly deploy', 'preview is the consulted segment');
ok(classifyShipCommand('git push --force origin main && fly deploy').class === 'push_main', 'irreversible outranks high');
ok(classifyShipCommand('eas build -p ios && gh pr merge 3').class === 'merge_pr', 'medium outranks low');
ok(classifyShipCommand('gh pr merge 1 && gh pr merge 2').summary === 'merge PR #1', 'tie → first');
ok(classifyShipCommand('gh pr merge 5').multiple === false, 'single action not flagged');

// ── The binding is one the resolver accepts, and never the whole command ───────
const b = normalizeActionBinding(m.action_binding);
ok(b.tool_name === 'Bash' && /^[0-9a-f]{64}$/.test(b.arguments_hash), 'binding: Bash + sha256 hex');
ok(classifyShipCommand('gh pr merge 1').action_binding.arguments_hash !== classifyShipCommand('gh pr merge 2').action_binding.arguments_hash,
  'distinct commands → distinct digests');
const long = classifyShipCommand('fly deploy ' + '--build-arg X=1 '.repeat(40));
ok(long.action_binding.arguments_preview.length <= 120, 'preview clipped');

// ── Splitter/words edges ───────────────────────────────────────────────────────
ok(splitCommands('a && b || c; d | e\nf').length === 6, 'splits on && || ; | newline');
ok(splitCommands('git commit -m "x && y"').length === 1, 'quoted && does not split');
ok(words('FOO=1 BAR=2 npx -y eas build')[0] === 'eas', 'env + npx flags stripped');

console.log(`✓ test-ship-actions: ${pass} checks passed`);
