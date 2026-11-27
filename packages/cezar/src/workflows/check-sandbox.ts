import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudeSandboxSettings, projectRootOf } from '../core/claude-sandbox.ts';
import { cezarHomeDir } from '../paths.ts';

/**
 * Check steps run the repo's own commands — its test suite, code the agent may just have written —
 * so a check is as untrusted as the agent. It runs under the same OS sandbox policy the agent's
 * shell gets (core/claude-sandbox.ts), enforced by Anthropic's sandbox runtime (`srt`, the engine
 * Claude Code itself uses): writes only in the worktree, its own temp dir, the run's shared cache
 * and package caches; no reads of credential stores or secret files; network only to package
 * registries, GitHub and localhost (the cockpit API needs a token checks never get).
 * `CEZ_CHECK_SANDBOX=0` runs checks unsandboxed, as before.
 */

export interface CheckSandbox {
  /** `srt` config (its own schema: every key present). */
  settings: Record<string, unknown>;
  /** The check's private TMPDIR: `srt` points TMPDIR at a dir it does not create. */
  tmpDir: string;
  cleanup: () => void;
}

function isOff(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

export function checkSandboxEnabled(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32' && !isOff(env.CEZ_CHECK_SANDBOX);
}

/** The `srt` CLI shipped as a dependency; undefined if it cannot be resolved. */
export function srtCliPath(): string | undefined {
  try {
    const pkg = createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/package.json');
    return join(dirname(pkg), 'dist', 'cli.js');
  } catch {
    return undefined;
  }
}

/** The check's `srt` policy, derived from the agent's so the two never drift apart. */
export function checkSandboxSettings(
  hostEnv: NodeJS.ProcessEnv,
  opts: { cwd: string; tmpDir: string; writable?: readonly string[]; home?: string; platform?: NodeJS.Platform },
): Record<string, unknown> | undefined {
  // The check's own policy toggle, not the agent's: CEZ_AGENT_SANDBOX=0 keeps checks sandboxed.
  const policy = claudeSandboxSettings({ ...hostEnv, CEZ_AGENT_SANDBOX: '1' }, {
    ...(opts.home ? { home: opts.home } : {}),
    ...(opts.platform ? { platform: opts.platform } : {}),
    projectRoots: [projectRootOf(opts.cwd)],
    readableRoots: [opts.cwd, opts.tmpDir, ...(opts.writable ?? [])],
    tempDirs: [opts.tmpDir],
  });
  if (!policy) return undefined;
  const { filesystem, network } = policy.sandbox;
  return {
    filesystem: {
      denyRead: filesystem.denyRead,
      allowRead: filesystem.allowRead,
      allowWrite: [...new Set([opts.cwd, opts.tmpDir, ...(opts.writable ?? []).filter(Boolean), ...filesystem.allowWrite])],
      denyWrite: [],
    },
    network: { allowedDomains: network.allowedDomains, deniedDomains: [], allowLocalBinding: true },
  };
}

/** Prepare one check's sandbox: a private temp dir under cezar's home and the policy for it. */
export function prepareCheckSandbox(
  cwd: string,
  checkEnv: NodeJS.ProcessEnv,
  hostEnv: NodeJS.ProcessEnv = process.env,
): CheckSandbox | undefined {
  if (!checkSandboxEnabled(hostEnv)) return undefined;
  const base = join(cezarHomeDir(hostEnv), 'tmp', 'checks');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const tmpDir = mkdtempSync(join(base, 'check-'));
  const writable = [checkEnv.CEZ_SHARED_CACHE_DIR, checkEnv.CEZ_ARTIFACTS_DIR].filter((p): p is string => Boolean(p));
  const settings = checkSandboxSettings(hostEnv, { cwd, tmpDir, writable });
  if (!settings) {
    rmSync(tmpDir, { recursive: true, force: true });
    return undefined;
  }
  return { settings, tmpDir, cleanup: () => rmSync(tmpDir, { recursive: true, force: true }) };
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The argv that runs `command` in a login bash under `srt`, plus the 0600 settings file it reads
 * (outside every sandbox-writable dir, so the check cannot rewrite its own policy).
 */
export function sandboxedCheckArgv(command: string, sandbox: CheckSandbox): { file: string; args: string[]; cleanup: () => void } | undefined {
  const cli = srtCliPath();
  if (!cli) return undefined;
  const dir = mkdtempSync(join(tmpdir(), 'cez-check-srt-'));
  const file = join(dir, 'srt-settings.json');
  writeFileSync(file, JSON.stringify(sandbox.settings), { mode: 0o600 });
  const tmp = shellQuote(sandbox.tmpDir);
  const script = `export TMPDIR=${tmp} TMP=${tmp} TEMP=${tmp}; ${command}`;
  return {
    file,
    args: [cli, '--settings', file, '--', 'bash', '-lc', script],
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
