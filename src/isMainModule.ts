import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Reports whether the module at `moduleUrl` is the script Node was started with.
 *
 * Compares real paths so the check still holds when the bin is reached through
 * a symlink, as with pnpm's `node_modules/.bin` shims and `npm link`.
 */
export function isMainModule(moduleUrl: string): boolean {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) {
    return false;
  }
  try {
    return realpathSync(invokedPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
