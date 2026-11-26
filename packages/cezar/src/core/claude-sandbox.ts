import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Default OS sandbox for Claude Code's Bash tool (Seatbelt on macOS, bubblewrap on Linux).
 * A worktree is not a sandbox: an unrestricted, prompt-injected shell could read host
 * credentials and post them anywhere. With this on, Bash writes only to the worktree (plus
 * toolchain caches), cannot read the credential stores below, and reaches only the allowlisted
 * hosts. Fails closed when the sandbox is unavailable. `CEZ_AGENT_SANDBOX=0` turns it off.
 * https://code.claude.com/docs/en/sandboxing
 */

/** Credential stores no agent shell needs to read. `~/.config/gh` is lifted by `CEZ_AGENT_GH_TOKEN=1`. */
const DENY_READ_HOME = [
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  '.docker',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.cezar',
  '.config/gcloud',
  '.config/op',
  'Library/Keychains',
] as const;
const GH_CONFIG = '.config/gh';

/** Package-manager caches a build legitimately writes; only those that exist are granted. */
const ALLOW_WRITE_HOME = [
  '.npm',
  '.cache',
  '.pnpm-store',
  '.yarn',
  '.bun/install/cache',
  '.cargo/registry',
  'go/pkg/mod',
  'Library/Caches',
  'Library/pnpm',
] as const;

/** Package registries, GitHub source downloads and the loopback cockpit (`CEZ_API_URL`). */
export const DEFAULT_SANDBOX_DOMAINS = [
  'localhost',
  '127.0.0.1',
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
] as const;

export interface ClaudeSandboxSettings {
  sandbox: {
    enabled: true;
    failIfUnavailable: true;
    allowUnsandboxedCommands: false;
    autoAllowBashIfSandboxed: false;
    filesystem: { denyRead: string[]; allowWrite: string[] };
    network: { allowedDomains: string[]; allowLocalBinding: true };
  };
  permissions: { deny: string[] };
}

function isOff(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

function isOn(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v !== undefined && v !== '' && !isOff(v);
}

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** undefined = no sandbox (opted out, or native Windows, where Claude Code has none). */
export function claudeSandboxSettings(
  env: NodeJS.ProcessEnv = process.env,
  opts: { home?: string; platform?: NodeJS.Platform; exists?: (path: string) => boolean } = {},
): ClaudeSandboxSettings | undefined {
  if (isOff(env.CEZ_AGENT_SANDBOX)) return undefined;
  if ((opts.platform ?? process.platform) === 'win32') return undefined;
  const home = opts.home ?? homedir();
  const exists = opts.exists ?? existsSync;

  const denyHome = isOn(env.CEZ_AGENT_GH_TOKEN) ? [...DENY_READ_HOME] : [...DENY_READ_HOME, GH_CONFIG];
  const denyRead = [...denyHome.map((p) => join(home, p)), ...list(env.CEZ_AGENT_SANDBOX_DENY_READ)];
  // bubblewrap cannot bind a path that does not exist yet.
  const allowWrite = [...ALLOW_WRITE_HOME.map((p) => join(home, p)), ...list(env.CEZ_AGENT_SANDBOX_ALLOW_WRITE)]
    .filter((p) => exists(p));
  const allowedDomains = [...new Set([...DEFAULT_SANDBOX_DOMAINS, ...list(env.CEZ_AGENT_SANDBOX_DOMAINS)])];

  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      // Never widen `--allowedTools`: a step's `bashAllowlist` must still decide which commands run.
      autoAllowBashIfSandboxed: false,
      filesystem: { denyRead, allowWrite },
      network: { allowedDomains, allowLocalBinding: true },
    },
    // The sandbox wraps Bash only; the Read tool (and Grep/Glob) obey permission rules.
    // `//` is Claude's absolute-path spelling; the bare rule covers files such as `~/.netrc`.
    permissions: { deny: denyRead.flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`]) },
  };
}
