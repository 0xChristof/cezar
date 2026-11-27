import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
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

/**
 * Secret-bearing file names, denied by pattern under the home and project roots: the sandbox
 * enforces them for every process (`node -e`, scripts), not just a `cat` Claude can parse.
 * Exact names, not `.env.*`: a pattern cannot carve out `.env.example`, which agents need.
 * `.env.test` stays readable too (commonly committed test config).
 */
export const SECRET_FILE_PATTERNS = [
  '.env',
  '.env.local',
  '.env.*.local',
  '.env.development',
  '.env.dev',
  '.env.production',
  '.env.prod',
  '.env.staging',
  '.envrc',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.keystore',
  '*.jks',
  'id_rsa',
  'id_ecdsa',
  'id_ed25519',
] as const;

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
    /** Extra roots the secret-file patterns are anchored under (the project, when outside home). */
    projectRoots?: readonly string[];
    /** What the run itself must read even inside a denied directory (`CEZ_AGENT_SANDBOX_DENY_READ`):
     *  its worktree, the project's `.git`, its `--add-dir` dirs, the `cez` install. A pattern deny
     *  still wins over these, so a `.env` inside them stays unreadable. */
    readableRoots?: readonly string[];
  } = {},
): ClaudeSandboxSettings | undefined {
  if (isOff(env.CEZ_AGENT_SANDBOX)) return undefined;
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') return undefined;
  const home = opts.home ?? homedir();
  const exists = opts.exists ?? existsSync;

  const denyHome = isOn(env.CEZ_AGENT_GH_TOKEN) ? [...DENY_READ_HOME] : [...DENY_READ_HOME, GH_CONFIG];
  const extraDeny = list(env.CEZ_AGENT_SANDBOX_DENY_READ);
  const cezarHome = opts.home && !env.CEZ_HOME ? join(opts.home, '.cezar') : cezarHomeDir(env);
  const allowRead = [
    ...CEZAR_HOME_READABLE.map((p) => join(cezarHome, p)),
    ...[...new Set(opts.readableRoots ?? [])].filter(Boolean),
  ];
  const secretRoots = [...new Set([home, ...(opts.projectRoots ?? [])])].filter(Boolean);
  const secretPatterns = secretRoots.flatMap((root) => SECRET_FILE_PATTERNS.flatMap((p) => [join(root, p), join(root, '**', p)]));
  // Bash: the whole cezar home, with `allowRead` carving the exceptions back out.
  const denyRead = [...denyHome.map((p) => join(home, p)), cezarHome, ...secretPatterns, ...extraDeny];
  // Read tool: its deny rules cannot carve exceptions, so the whole cezar home is denied (the run
  // needs none of it through Read). An extra deny dir that contains one of the run's own roots is
  // left to the OS sandbox, which enforces it for Bash; denying it here would deny the worktree.
  const inside = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
  const readable = opts.readableRoots ?? [];
  const readToolDeny = denyRead.filter((p) => !(extraDeny.includes(p) && readable.some((r) => inside(p, r))));
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

/** The main checkout a cezar worktree (`<repo>/.ai/cezar/worktrees/<id>`) belongs to; else `cwd`. */
export function projectRootOf(cwd: string): string {
  const marker = `${sep}.ai${sep}cezar${sep}worktrees${sep}`;
  const at = cwd.indexOf(marker);
  return at > 0 ? cwd.slice(0, at) : cwd;
}

/** The outermost package directory above the `cez` entry point (a checkout's workspace root,
 *  whose node_modules the binary needs), stopping below the home directory. */
export function cezInstallRoot(bin: string | undefined, home = homedir(), exists: (p: string) => boolean = existsSync): string | undefined {
  if (!bin) return undefined;
  let dir = dirname(bin);
  let root: string | undefined;
  while (dir !== dirname(dir) && dir !== home) {
    if (exists(join(dir, 'package.json'))) root = dir;
    dir = dirname(dir);
  }
  return root;
}
