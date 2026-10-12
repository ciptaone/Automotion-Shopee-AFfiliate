/**
 * Crash-safe, race-safe file persistence primitives.
 *
 * Every file-backed store (settings, catalog, slot content) writes with
 * "temp file + atomic rename" so a crash mid-write can never truncate the
 * previous good snapshot.
 *
 * Three concurrency hazards are handled here:
 *
 *  1. **Shared temp name.** With a single fixed `<file>.tmp`, two concurrent
 *     saves interleave: writer A renames the temp file away, writer B's rename
 *     then fails with ENOENT (the error observed live in the PART 4 smoke test
 *     when an API-triggered pipeline run raced a scheduler tick). Each write
 *     therefore uses its own unique temp name, and removes it on failure.
 *
 *  2. **Out-of-order snapshots.** Renames are atomic but ordering is not: a
 *     caller that built an older snapshot could otherwise overwrite a newer
 *     one. Writes to the SAME path are funnelled through one FIFO chain, so
 *     the last requested snapshot wins. (Stores additionally serialize their
 *     own `save()` calls; this is the low-level backstop.)
 *
 *  3. **Windows rename semantics.** On Windows, `rename()` onto a target that
 *     another rename just touched (or that a scanner holds open) fails with
 *     `EPERM`/`EBUSY` rather than overwriting. Rename retries a bounded number
 *     of times with a short backoff before giving up.
 *
 * Multi-process access to the same file (e.g. two backend instances sharing a
 * volume) is still NOT safe — that is what the PostgreSQL store in
 * `db/schema.ts` is for. This module only makes a single process safe.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Error codes where a bounded rename retry is worth attempting. */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

const RENAME_MAX_ATTEMPTS = 6;
const RENAME_BASE_DELAY_MS = 10;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const errorCode = (error: unknown): string => (error as NodeJS.ErrnoException | null)?.code ?? '';

/**
 * One FIFO chain per absolute path, so concurrent writers to the same file can
 * never rename over each other. Entries are removed once a path goes idle.
 */
const pathQueues = new Map<string, Promise<unknown>>();

function enqueueForPath<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = pathQueues.get(key) ?? Promise.resolve();
  const result = previous.then(run, run);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  pathQueues.set(key, settled);
  void settled.then(() => {
    // Drop the entry once nothing else is chained behind it.
    if (pathQueues.get(key) === settled) {
      pathQueues.delete(key);
    }
  });
  return result;
}

/** `rename` with a bounded backoff for the Windows-specific transient codes. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await sleep(RENAME_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
    try {
      await rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_RENAME_CODES.has(errorCode(error))) {
        break;
      }
    }
  }
  throw lastError;
}

/**
 * Write `data` to `filePath` atomically: unique temp file in the same
 * directory, then a rename into place.
 *
 * Writes to the same path are serialized and the rename is retried on the
 * transient Windows codes. On failure the temp file is removed and the
 * original file is left untouched; the caller decides how to wrap the error.
 */
export async function atomicWriteText(filePath: string, data: string): Promise<void> {
  const key = path.resolve(filePath);
  return enqueueForPath(key, async () => {
    const dir = path.dirname(key);
    // Unique per attempt: concurrent writers never share a temp path, and a
    // leftover temp file from a previous crash can never be renamed by mistake.
    const tmp = `${key}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(tmp, data, 'utf8');
      await renameWithRetry(tmp, key);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  });
}

/**
 * A FIFO mutex for async work inside one process.
 *
 * `enqueue(fn)` runs `fn` after every previously enqueued `fn` has settled,
 * whether it resolved or rejected (a failing write must not wedge the store).
 * Results and rejections are forwarded to the caller unchanged.
 */
export function createSerialQueue(): <T>(run: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();

  return function enqueue<T>(run: () => Promise<T>): Promise<T> {
    // Queue the slot on the tail, but hand the caller a promise for THIS run
    // only, so one rejection does not reject the shared chain.
    const result = tail.then(run, run);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
