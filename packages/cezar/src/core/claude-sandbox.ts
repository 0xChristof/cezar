import { existsSync, readdirSync } from 'node:fs';
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
  // The hosted (ngrok) cockpit's API token, tunnel config and launchd agents that carry it.
  'Library/Application Support/cezar',
  'Library/LaunchAgents',
] as const;
const GH_CONFIG = '.config/gh';

/**
 * cezar's home (`CEZ_HOME`, default ~/.cezar) holds secrets, account homes, relay keys and runtime
 * tokens, so all of it is unreadable except what a run needs: its TMPDIR and the `cez` binary.
 */
const CEZAR_HOME_READABLE = ['tmp', 'bin', 'versions'] as const;
/**
 * Every top-level entry cezar itself creates in its home (`claude-sandbox.test.ts` greps the
 * sources so this list cannot drift). When a run's root lives under cezar's home, the Read tool is
 * denied each of these by name on top of the launch-time listing, so nothing cezar writes later
 * slips through. Only the path down to the run's own root is left open.
 */
export const CEZAR_HOME_ENTRIES = [
  'agent-accounts.json', 'agent-fallback.json', 'agent-homes', 'agent-usage-holds',
  'attention-overrides.json', 'attention-pr-ends.json', 'bin', 'cache', 'codex-restricted',
  'codex-restricted-dry-source', 'config.json', 'instances', 'logs', 'managers', 'managers.json',
  'npm-cache', 'opencode-servers', 'pr-checkouts', 'relay', 'runtime', 'secrets', 'server-instances',
  'server.install.lock', 'server.json', 'telemetry', 'tmp', 'tracker-connections', 'ui-state.json',
  'uploads', 'usage-ledger', 'usage-tracking.json', 'usage-windows.json', 'versions',
] as const;

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

/**
 * Package-manager caches a build legitimately writes; only those that exist are granted. Cache
 * subdirectories only: never a dir on PATH (`~/Library/pnpm`, `~/.yarn/bin`) or one whose content
 * the host later executes (`~/.npm/_npx`), where a planted shim would run unsandboxed.
 */
const ALLOW_WRITE_HOME = [
  '.npm/_cacache',
  '.npm/_logs',
  '.pnpm-store',
  'Library/pnpm/store',
  '.yarn/berry/cache',
  'Library/Caches/Yarn',
  '.cache/pip',
  'Library/Caches/pip',
  '.cache/uv',
  '.bun/install/cache',
  '.cargo/registry',
  'go/pkg/mod',
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

/** Same reading as `agent-env.ts` `isTruthy`, so one toggle never means two things. */
function isOn(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v !== undefined && v !== '' && v !== '0' && v !== 'false';
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
     *  its worktree, the project's `.git`, its `--add-dir` dirs. A pattern deny still wins over
     *  these (verified), so a `.env` inside them stays unreadable. */
    readableRoots?: readonly string[];
    /** The `cez` install: readable by the shell inside a denied directory, never by the Read tool. */
    binRoots?: readonly string[];
    /** Directory listing for the Read-tool rules of a denied directory that holds the run. */
    listDir?: (path: string) => string[];
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
  const inside = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
  const credentialDirs = [home, cezarHome, ...denyHome.map((p) => join(home, p))];
  // A carve-out is only for a run root inside an extra deny dir, and never one that holds home,
  // cezar's home or a credential store: a broad allow must not reopen what a narrow deny closed.
  // cezar's home is carved like an extra deny dir: a review's PR checkout and a manager's workdir
  // live there (`~/.cezar/pr-checkouts`, `~/.cezar/managers/<id>/workdir`).
  const carvable = [...extraDeny, cezarHome];
  const carve = (roots: readonly string[] | undefined) => [...new Set(roots ?? [])].filter((r) =>
    r && carvable.some((d) => inside(d, r)) && !credentialDirs.some((c) => inside(r, c)));
  const runRoots = carve(opts.readableRoots);
  const allowRead = [...CEZAR_HOME_READABLE.map((p) => join(cezarHome, p)), ...runRoots, ...carve(opts.binRoots)];
  const secretRoots = [...new Set([home, ...(opts.projectRoots ?? [])])].filter(Boolean);
  const secretPatterns = secretRoots.flatMap((root) => SECRET_FILE_PATTERNS.flatMap((p) => [join(root, p), join(root, '**', p)]));
  // Bash: the whole cezar home, with `allowRead` carving the exceptions back out.
  const denyRead = [...denyHome.map((p) => join(home, p)), cezarHome, ...secretPatterns, ...extraDeny];
  // Read tool: its deny rules cannot carve exceptions, so the whole cezar home is denied, and an
  // extra deny dir that holds the run is denied entry by entry around the path to the run's roots.
  // A listing that fails denies the whole dir (fail closed).
  const listDir = opts.listDir ?? ((path: string) => readdirSync(path));
  const aroundRoots = (dir: string, roots: string[]): string[] => {
    if (roots.some((r) => r === dir)) return [];
    let entries: string[];
    try { entries = listDir(dir); } catch { return [dir]; }
    return entries.flatMap((name) => {
      const child = join(dir, name);
      const within = roots.filter((r) => inside(child, r));
      return within.length > 0 ? aroundRoots(child, within) : [child];
    });
  };
  const readToolDeny = denyRead.flatMap((p) => {
    if (!carvable.includes(p)) return [p];
    const within = runRoots.filter((r) => inside(p, r));
    if (within.length === 0) return [p];
    // The listing is a launch-time snapshot: name every entry cezar creates too, so one created
    // later is still denied.
    const known = p === cezarHome
      ? CEZAR_HOME_ENTRIES.map((n) => join(p, n)).filter((k) => !within.some((r) => inside(k, r)))
      : [];
    return [...new Set([...aroundRoots(p, within), ...known])];
  });
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
