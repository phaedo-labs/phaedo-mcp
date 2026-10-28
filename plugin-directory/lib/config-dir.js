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

function readLayout(baseDir) {
  const key = resolve(baseDir);
  if (!cache.has(key)) {
    let layout = null;
    try {
      const marker = join(key, LAYOUT_MARKER);
      if (existsSync(marker)) layout = JSON.parse(readFileSync(marker, 'utf8'));
    } catch { layout = null; }   // an unreadable marker → the old, beside-the-server layout
    cache.set(key, layout && typeof layout === 'object' ? layout : null);
  }
  return cache.get(key);
}

/** True when the package at `baseDir` is a packaged install (plugin or Desktop bundle). */
export function isPackagedInstall(baseDir) {
  return readLayout(baseDir)?.config === 'state-dir';
}

// THE DIRECTORY EDITION. Anthropic's directory policy says listed software must not read
// Claude's chat history or "use conversation content to build user profiles", nor "make any
// changes to Claude's behavior across sessions". The plugin built for the directory therefore
// leaves out every transcript reader (the session hooks and the capture modules), and this
// flag turns off the two server paths that would still use conversation-derived data or apply
// the profile unasked: the starter profile folded from local capture counts, and the "load the
// profile at session start" instruction. The profile then comes only from the paired phone app,
// and loads when the user asks for it. Everything else — consult, escalate, sign, the merge
// check — is the same server.
export function isDirectoryEdition(baseDir) {
  return readLayout(baseDir)?.edition === 'directory';
}

export function configDir(baseDir, env = process.env) {
  if (env.PHAEDO_CONFIG_DIR) return resolve(env.PHAEDO_CONFIG_DIR);
  if (isPackagedInstall(baseDir)) return env.PHAEDO_MCP_STATE_DIR || join(homedir(), '.phaedo-mcp');
  return baseDir;
}
