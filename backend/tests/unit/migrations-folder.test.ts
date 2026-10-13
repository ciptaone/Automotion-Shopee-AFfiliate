/**
 * PART 9 §4 — the migrations folder must resolve to the REAL journal in every
 * layout the app runs from.
 *
 * Under tsx/vitest the module lives in `src/db/`; in production it is compiled
 * to `dist/src/db/`, where a naive `../../drizzle` would point inside `dist/`
 * and the startup gate would (correctly, but unnecessarily) refuse to boot.
 * This test pins the walk-up resolver: the resolved folder contains the
 * committed journal, whichever layout the suite runs from.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { MIGRATIONS_FOLDER } from '../../src/db/client.js';

describe('MIGRATIONS_FOLDER', () => {
  it('resolves to a directory holding the committed journal', () => {
    expect(existsSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'))).toBe(true);
  });

  it('never resolves inside a build output directory', () => {
    expect(MIGRATIONS_FOLDER.split(path.sep)).not.toContain('dist');
  });
});
