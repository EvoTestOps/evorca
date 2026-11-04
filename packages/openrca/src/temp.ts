/**
 * Deletes temporary files and directories when the scope that made them ends,
 * through `await using`. Deletion runs on every exit from the scope, including
 * a throw.
 *
 * @module
 */
import { rm } from "node:fs/promises";

/**
 * Returns a handle that deletes `path`, a file or a directory tree, when
 * `await using` disposes it. A path that no longer exists is fine, so code can
 * rename the path away to keep it.
 */
export function removeOnDispose(path: string): AsyncDisposable & { readonly path: string } {
  return { path, [Symbol.asyncDispose]: () => rm(path, { recursive: true, force: true }) };
}
