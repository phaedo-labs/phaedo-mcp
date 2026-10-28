// "Was this module executed directly?" — symlink-safe.
//
// The obvious ESM idiom
//
//     import.meta.url === pathToFileURL(resolve(process.argv[1])).href
//
// is WRONG whenever any component of the path is a symlink. Node resolves
// `import.meta.url` through symlinks (it is the module's real URL), while
// `resolve(process.argv[1])` normalizes `.`/`..` but does NOT follow links — so
// the two disagree and the check silently returns false.
//
// That is not a hypothetical. `os.tmpdir()` on macOS is `/var/folders/…`, a
// symlink to `/private/var/folders/…`, which made the SessionEnd capture hook a
// silent no-op for every macOS spawn from a temp path (caught by
// test-vendored-capture.mjs, which spawns the hook exactly as Claude Code does).
// The same trap is live in production for any install reached through a link — a
// symlinked home directory, a linked global npm root, `/tmp` on macOS.
//
// A capture hook that quietly does nothing is the worst failure this codebase
// has: it exits 0, prints nothing, and loses the session. So compare REAL paths,
// and fall back to the plain URL comparison only if realpath throws (a deleted or
// unreadable entry point — in which case "not main" is the safe answer anyway).

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// (import.meta.url of the caller, [argv]) -> boolean
export function isMainModule(moduleUrl, argv = process.argv) {
  const entry = argv && argv[1];
  if (!entry || !moduleUrl) return false;
  const self = fileURLToPath(moduleUrl);
  const target = resolve(entry);
  if (self === target) return true;                       // fast path, no IO
  try {
    return realpathSync(self) === realpathSync(target);
  } catch {
    return pathToFileURL(target).href === moduleUrl;      // best effort
  }
}
