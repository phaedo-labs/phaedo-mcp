// Where this install keeps the subject's own config files: pairing.json, identity.json,
// consult-policies.json, escalation-policy.json and fingerprint.json.
//
// A clone or the npm package keeps them beside server.js, as it always has. A packaged install
// can't: a Claude Code plugin's folder is replaced on every update (`${CLAUDE_PLUGIN_ROOT}` is a
// per-version cache directory), and a Claude Desktop bundle's folder belongs to Claude Desktop.
// A pairing written there is lost on the next update. So both packages ship an
// `install-layout.json` marker beside server.js, and keep these files in the state dir
// (~/.phaedo-mcp, or PHAEDO_MCP_STATE_DIR) instead — the same folder for both, so pairing once
// from either covers the other.
//
// A file marker rather than an environment variable, because the plugin's hooks and its
// `pair.js` / `pull.js` run in processes that don't all get the plugin's environment (commands
// Claude runs through its Bash tool see no CLAUDE_PLUGIN_ROOT). The marker travels with the
// files. PHAEDO_CONFIG_DIR still overrides both.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const LAYOUT_MARKER = 'install-layout.json';

const cache = new Map();

/** True when the package at `baseDir` is a packaged install (plugin or Desktop bundle). */
export function isPackagedInstall(baseDir) {
  const key = resolve(baseDir);
  if (!cache.has(key)) {
    let packaged = false;
    try {
      const marker = join(key, LAYOUT_MARKER);
      packaged = existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8'))?.config === 'state-dir';
    } catch { packaged = false; }   // an unreadable marker → the old, beside-the-server layout
    cache.set(key, packaged);
  }
  return cache.get(key);
}

export function configDir(baseDir, env = process.env) {
  if (env.PHAEDO_CONFIG_DIR) return resolve(env.PHAEDO_CONFIG_DIR);
  if (isPackagedInstall(baseDir)) return env.PHAEDO_MCP_STATE_DIR || join(homedir(), '.phaedo-mcp');
  return baseDir;
}
