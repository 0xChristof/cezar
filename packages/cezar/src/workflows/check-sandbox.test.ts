import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkSandboxEnabled, checkSandboxSettings, prepareCheckSandbox, srtCliPath } from './check-sandbox.ts';
import { spawnCheck } from './check-process.ts';

describe('check sandbox policy', () => {
  it('is on by default, off with CEZ_CHECK_SANDBOX=0 and on native Windows', () => {
    expect(checkSandboxEnabled({}, 'darwin')).toBe(true);
    expect(checkSandboxEnabled({ CEZ_CHECK_SANDBOX: '0' }, 'linux')).toBe(false);
    expect(checkSandboxEnabled({}, 'win32')).toBe(false);
    // The agent's switch does not turn checks off.
    expect(checkSandboxEnabled({ CEZ_AGENT_SANDBOX: '0' }, 'linux')).toBe(true);
  });

  it('mirrors the agent policy in srt\'s complete schema', () => {
    const settings = checkSandboxSettings({ CEZ_AGENT_SANDBOX: '0' }, {
      cwd: '/repo/.ai/cezar/worktrees/r1', tmpDir: '/home/dev/.cezar/tmp/checks/c1', writable: ['/repo/.ai/cezar/cache'],
      home: '/home/dev', platform: 'linux',
    }) as { filesystem: Record<string, string[]>; network: Record<string, unknown> };
    expect(settings.filesystem.allowWrite).toEqual(expect.arrayContaining(['/repo/.ai/cezar/worktrees/r1', '/home/dev/.cezar/tmp/checks/c1', '/repo/.ai/cezar/cache']));
    expect(settings.filesystem.allowWrite).not.toContain('/home/dev');
    expect(settings.filesystem.denyRead).toEqual(expect.arrayContaining(['/home/dev/.ssh', '/home/dev/.cezar', '/repo/**/.env', '/home/dev/**/.env']));
    expect(settings.filesystem.denyWrite).toEqual([]);
    expect(settings.network).toMatchObject({ deniedDomains: [], allowLocalBinding: true });
    expect(settings.network.allowedDomains).toEqual(expect.arrayContaining(['registry.npmjs.org']));
    expect(settings.network.allowedDomains).not.toContain('example.com');
  });

  it('ships srt as a dependency', () => {
    const cli = srtCliPath();
    expect(cli && existsSync(cli)).toBe(true);
  });
});

// The real thing: a check under srt (Seatbelt). Linux CI may lack bubblewrap, so macOS only.
describe.skipIf(process.platform !== 'darwin')('a check under the sandbox (live srt)', () => {
  let root: string;
  let outside: string;
  const saved = process.env.CEZ_CHECK_SANDBOX;
  beforeEach(() => {
    process.env.CEZ_CHECK_SANDBOX = '1';
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-check-sbx-')));
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'cez-check-outside-')));
    writeFileSync(join(root, '.env'), 'SECRET=1\n');
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CEZ_CHECK_SANDBOX;
    else process.env.CEZ_CHECK_SANDBOX = saved;
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const run = (command: string) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const env = { ...process.env };
    const child = spawnCheck(command, root, env, prepareCheckSandbox(root, env));
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('close', (code) => resolve({ code, out }));
  });

  it('writes in the worktree and its temp dir, keeps the exit code', async () => {
    const res = await run(`echo ok > inside.txt && node -e "require('fs').writeFileSync(require('os').tmpdir()+'/t','x')" && cat inside.txt; exit 7`);
    expect(res.out).toContain('ok');
    expect(res.code).toBe(7);
  }, 60_000);

  it('cannot write outside the worktree, read its .env, or reach a host off the allowlist', async () => {
    const res = await run(`touch ${outside}/escape; cat .env; curl -sS -m 5 -o /dev/null https://example.com; echo done`);
    expect(existsSync(join(outside, 'escape'))).toBe(false);
    expect(res.out).not.toContain('SECRET=1');
    expect(res.out).toContain('done');
  }, 60_000);
});
