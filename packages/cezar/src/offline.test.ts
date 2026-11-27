import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyOfflineDefaults, isOffline } from './offline.ts';
import { fetchPackageDocument } from './self-update/registry.ts';
import { ensureBareClone, fetchAll } from './skills-remote.ts';

describe('offline by default (this fork)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('is on unless CEZ_OFFLINE turns it off', () => {
    expect(isOffline({})).toBe(true);
    expect(isOffline({ CEZ_OFFLINE: '1' })).toBe(true);
    for (const off of ['0', 'false', 'off', 'no']) expect(isOffline({ CEZ_OFFLINE: off })).toBe(false);
  });

  it('seeds every phone-home switch off, without overriding an explicit choice', () => {
    const env: NodeJS.ProcessEnv = { CEZ_SKILLS_AUTO_UPDATE: '1' };
    applyOfflineDefaults(env);
    expect(env).toMatchObject({
      CEZ_TELEMETRY: '0',
      CEZ_AGENT_VERSION_CHECK: '0',
      CEZ_NO_BANNER: '1',
      CEZ_ARTIFACTS_CDN: '0',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CEZ_SKILLS_AUTO_UPDATE: '1',
    });
    const online: NodeJS.ProcessEnv = { CEZ_OFFLINE: '0' };
    applyOfflineDefaults(online);
    expect(online).toEqual({ CEZ_OFFLINE: '0' });
  });

  it('makes no npm registry request', async () => {
    const network = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', network);
    // The default fetch is the stubbed global now, so the gate compares against it.
    expect(await fetchPackageDocument('@open-mercato/cezar', globalThis.fetch)).toBeNull();
    expect(network).not.toHaveBeenCalled();
  });

  it('never clones or fetches a remote skills repo', async () => {
    await expect(ensureBareClone('open-mercato/skills')).rejects.toThrow('offline');
    await expect(fetchAll('/tmp/does-not-matter.git')).rejects.toThrow('offline');
  });
});
