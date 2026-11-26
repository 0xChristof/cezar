import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cezarHomeDir } from '../paths.ts';

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
  // Agent CLIs read their own logins outside the sandbox; a sandboxed shell never needs them.
  '.claude/.credentials.json',
  '.codex/auth.json',
  '.config/gcloud',
  '.config/op',
  'Library/Keychains',
] as const;
const GH_CONFIG = '.config/gh';

/**
 * cezar's home (`CEZ_HOME`, default ~/.cezar) holds secrets, account homes, relay keys and runtime
 * tokens, so all of it is unreadable except what a run needs: its TMPDIR and the `cez` binary.
 */
const CEZAR_HOME_READABLE = ['tmp', 'bin', 'versions'] as const;

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
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
] as const;

export interface ClaudeSandboxSettings {
  sandbox: {
    enabled: true;
    failIfUnavailable: true;
    allowUnsandboxedCommands: false;
    autoAllowBashIfSandboxed: false;
    filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[] };
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
  opts: {
    home?: string;
    platform?: NodeJS.Platform;
    exists?: (path: string) => boolean;
    /** This run's own files outside the worktree (handoff, todos); `--add-dir` dirs are already writable. */
    runFiles?: readonly string[];
    /** The run's own TMPDIR. Never the host's: cezar keeps other sessions' settings files there. */
    tempDirs?: readonly string[];
    /** Entries of cezar's home, for the Read-tool rules (whose deny cannot carve exceptions). */
    listDir?: (path: string) => string[];
  } = {},
): ClaudeSandboxSettings | undefined {
  if (isOff(env.CEZ_AGENT_SANDBOX)) return undefined;
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') return undefined;
  const home = opts.home ?? homedir();
  const exists = opts.exists ?? existsSync;

  const listDir = opts.listDir ?? ((path: string) => { try { return readdirSync(path); } catch { return []; } });
  const denyHome = isOn(env.CEZ_AGENT_GH_TOKEN) ? [...DENY_READ_HOME] : [...DENY_READ_HOME, GH_CONFIG];
  const extraDeny = list(env.CEZ_AGENT_SANDBOX_DENY_READ);
  const cezarHome = opts.home && !env.CEZ_HOME ? join(opts.home, '.cezar') : cezarHomeDir(env);
  const allowRead = CEZAR_HOME_READABLE.map((p) => join(cezarHome, p));
  // Bash: the whole home, with `allowRead` carving the exceptions back out.
  const denyRead = [...denyHome.map((p) => join(home, p)), cezarHome, ...extraDeny];
  // Read tool: deny each entry but the exceptions (known secrets too, in case they appear later).
  const cezarEntries = new Set([...listDir(cezarHome), 'secrets', 'tracker-connections', 'runtime', 'relay', 'agent-homes', 'agent-accounts.json', 'config.json']);
  const readToolDeny = [
    ...denyHome.map((p) => join(home, p)),
    ...[...cezarEntries].filter((e) => !(CEZAR_HOME_READABLE as readonly string[]).includes(e)).map((e) => join(cezarHome, e)),
    ...extraDeny,
  ];
  // bubblewrap cannot bind a path that does not exist yet.
  const allowWrite = [
    ...[...ALLOW_WRITE_HOME.map((p) => join(home, p)), ...list(env.CEZ_AGENT_SANDBOX_ALLOW_WRITE)].filter((p) => exists(p)),
    // Seatbelt grants a file that does not exist yet; bubblewrap can only bind an existing one.
    ...(opts.runFiles ?? []).filter((p) => p && (platform === 'darwin' || exists(p))),
    ...[...new Set(opts.tempDirs ?? [])].filter((p) => p && exists(p)),
  ];
  const allowedDomains = [...new Set([...DEFAULT_SANDBOX_DOMAINS, ...list(env.CEZ_AGENT_SANDBOX_DOMAINS)])];

  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      // Never widen `--allowedTools`: a step's `bashAllowlist` must still decide which commands run.
      autoAllowBashIfSandboxed: false,
      filesystem: { denyRead, allowRead, allowWrite },
      network: { allowedDomains, allowLocalBinding: true },
    },
    // The sandbox wraps Bash only; the Read tool (and Grep/Glob) obey permission rules.
    // `//` is Claude's absolute-path spelling; the bare rule covers files such as `~/.netrc`.
    permissions: { deny: readToolDeny.flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`]) },
  };
}
