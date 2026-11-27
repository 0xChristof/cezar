import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CEZAR_HOME_ENTRIES } from './claude-sandbox.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === '__fixtures__' ? [] : sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

describe('CEZAR_HOME_ENTRIES covers every entry cezar creates in its home', () => {
  // `join(cezarHomeDir(…), '<entry>'…)` is how cezar names a top-level home entry.
  const ENTRY = /join\(\s*cezarHomeDir\([^)]*\)\s*,\s*'([^']+)'/g;

  it('lists each literal entry the sources join onto cezarHomeDir()', () => {
    const found = new Set<string>();
    for (const file of sources(SRC)) {
      for (const match of readFileSync(file, 'utf8').matchAll(ENTRY)) found.add(match[1]!);
    }
    expect(found.size).toBeGreaterThan(20); // the matcher still sees the codebase
    const missing = [...found].filter((entry) => !(CEZAR_HOME_ENTRIES as readonly string[]).includes(entry));
    expect(missing).toEqual([]);
  });

  it('the matcher recognises the spellings in use (sentinel)', () => {
    const sample = "join(cezarHomeDir(), 'secrets'); join(cezarHomeDir(env), 'relay', id); join( cezarHomeDir(hostEnv) , 'codex-restricted', key)";
    expect([...sample.matchAll(ENTRY)].map((m) => m[1])).toEqual(['secrets', 'relay', 'codex-restricted']);
  });
});
