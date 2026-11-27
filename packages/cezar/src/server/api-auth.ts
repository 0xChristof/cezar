import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Cockpit API authentication (security hardening). The cockpit binds to loopback, but loopback is
 * not a boundary against the agents it runs: an OS sandbox that lets a task's tests start a local
 * server also lets the task reach every loopback port, this cockpit included, and the Origin/Host
 * checks stop web pages, not a `curl` that sets its own headers. So every `/api` request must
 * carry one of:
 *   - the session cookie, set by opening the cockpit through the link cezar prints (`?token=`);
 *   - the cockpit token in `x-cezar-token` (host CLIs read it from the 0600 runtime lease);
 *   - a per-task token in `x-cezar-task-token`, which only reaches the routes an agent's own
 *     `cez task` / `cez automation` / tracker CLIs call (`taskRouteAllowed`);
 * or arrive through the paired-phone relay, which authenticates on its own.
 */

export interface ApiAuth {
  token: string;
  /** Also accepted as a header (not as the cookie): the runtime lease's token when `CEZ_API_TOKEN`
   *  overrides it, so `cez` CLIs that read the lease keep working. */
  alsoAccept?: readonly string[];
  /** Cookies are per host, not per port: two cockpits on one machine need two names. */
  cookieName: string;
}

/** A run's agent (in its project), or a manager's (whose CLI drives its own workspace routes). */
export type TaskGrant =
  | { runId: string; projectId?: string; managerId?: undefined }
  | { managerId: string; runId?: undefined; projectId?: undefined };

const taskTokens = new Map<string, TaskGrant>();

function issue(grant: TaskGrant): string {
  for (const [token, held] of taskTokens) {
    if (held.runId === grant.runId && held.managerId === grant.managerId && held.projectId === grant.projectId) return token;
  }
  const token = randomBytes(24).toString('base64url');
  taskTokens.set(token, grant);
  return token;
}

/** The run's token (one per run, reused across its spawns); revoked on its terminal transition. */
export function issueTaskToken(runId: string, projectId?: string): string {
  return issue(projectId ? { runId, projectId } : { runId });
}

/** A manager's token: its own `/workspace/managers/<id>` routes and the workflow lists. */
export function issueManagerToken(managerId: string): string {
  return issue({ managerId });
}

let cockpitToken: string | undefined;

/** The serving cockpit's token, for in-process launchers that hand it to a trusted child (managers). */
export function setCockpitApiToken(token: string | undefined): void {
  cockpitToken = token;
}

export function cockpitApiToken(): string | undefined {
  return cockpitToken;
}

/** Env names that carry cockpit authority and must never be inherited by an agent or a check. */
export const COCKPIT_SECRET_ENV: readonly string[] = ['CEZ_API_TOKEN', 'CEZ_TASK_TOKEN'];

export function revokeTaskTokens(runId: string): void {
  for (const [token, grant] of taskTokens) if (grant.runId === runId) taskTokens.delete(token);
}

export function taskGrantOf(token: string | undefined): TaskGrant | undefined {
  return token ? taskTokens.get(token) : undefined;
}

/** @internal tests */
export function resetTaskTokensForTests(): void {
  taskTokens.clear();
}

export function sameSecret(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sessionCookieName(port: number | string): string {
  return `cez_session_${port}`;
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return undefined;
}

export function sessionCookie(auth: ApiAuth, secure: boolean): string {
  // Lax, not Strict: a link from another site (the github.com bookmarklet) is a top-level GET that
  // must arrive signed in; cross-site writes stay refused by the Origin guard, and no GET mutates.
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${60 * 60 * 24 * 365}`, ...(secure ? ['Secure'] : [])];
  return `${auth.cookieName}=${encodeURIComponent(auth.token)}; ${attrs.join('; ')}`;
}

/**
 * The cockpit's auth, or undefined when it is off: `CEZ_API_AUTH=0`, or under the desktop shell,
 * which navigates its webview to the bare cockpit URL and has no way yet to carry a token — unless
 * it hands one over in `CEZ_API_TOKEN`.
 */
export function resolveApiAuth(
  env: NodeJS.ProcessEnv,
  port: number,
  leaseToken: string | undefined,
  warn: (message: string) => void = (m) => console.warn(m),
): ApiAuth | undefined {
  if (env.CEZ_API_AUTH === '0') return undefined;
  const explicit = env.CEZ_API_TOKEN?.trim();
  if (!explicit && env.CEZ_DESKTOP === '1') {
    warn('  ⚠ cockpit API authentication is off under the desktop shell (it cannot pass a token yet): agents on this machine can reach the cockpit API.');
    return undefined;
  }
  const token = explicit || leaseToken || randomBytes(32).toString('base64url');
  return {
    token,
    cookieName: sessionCookieName(port),
    ...(leaseToken && leaseToken !== token ? { alsoAccept: [leaseToken] } : {}),
  };
}

export type ApiCaller = { kind: 'cockpit' } | { kind: 'task'; grant: TaskGrant };

export interface ApiCredentials {
  cookie?: string;
  token?: string;
  handoffToken?: string;
  taskToken?: string;
}

export function authenticate(auth: ApiAuth, creds: ApiCredentials): ApiCaller | undefined {
  if (sameSecret(cookieValue(creds.cookie, auth.cookieName), auth.token)) return { kind: 'cockpit' };
  for (const secret of [auth.token, ...(auth.alsoAccept ?? [])]) {
    if (sameSecret(creds.token, secret) || sameSecret(creds.handoffToken, secret)) return { kind: 'cockpit' };
  }
  const grant = taskGrantOf(creds.taskToken);
  return grant ? { kind: 'task', grant } : undefined;
}

/**
 * What a task token reaches: its own run, the runs list, creating and previewing automations
 * (created paused; enabling, running, editing and deleting stay with the person), and the tracker
 * task route (which checks its own per-task capability). Paths are the request path, with or
 * without the `/p/<project>` scope.
 */
export function taskRouteAllowed(method: string, path: string, grant: TaskGrant): boolean {
  const escape = (id: string) => encodeURIComponent(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (grant.managerId !== undefined) {
    const own = new RegExp(`^/api/v1/workspace/managers/${escape(grant.managerId)}(/.*)?$`).exec(path);
    if (own) {
      const sub = own[1] ?? '';
      // The manager itself: read it, rename it (the route narrows the body). Never delete it, and
      // never decide on its own proposals — those decisions are the person's.
      if (sub === '' || sub === '/') return method === 'GET' || method === 'PATCH';
      return !/^\/actions\/[^/]+\/decision\/?$/.test(sub);
    }
    return method === 'GET' && /^\/api\/v1\/p\/[^/]+\/workflows$/.test(path);
  }
  // The run's own project only (CEZ_PROJECT_ID scopes its CLIs); the check poll is unscoped.
  if (method === 'GET' && /^\/api\/v1\/automation-checks\/[^/]+$/.test(path)) return true;
  const scope = grant.projectId ? `/p/${escape(grant.projectId)}` : '';
  const m = new RegExp(`^/api/v1${scope}(/.*)?$`).exec(path);
  if (!m) return false;
  const rest = m[1] ?? '/';
  const own = escape(grant.runId);
  const rules: Array<[string, RegExp]> = [
    ['GET', /^\/runs\/?$/],
    ['GET', new RegExp(`^/runs/${own}$`)],
    ['POST', new RegExp(`^/runs/${own}/(?:dispatch|report)$`)],
    // A definition by id, never the export bundle (which `/:id` would otherwise match).
    ['GET', /^\/automations(?:\/(?!export\/?$)[^/]+)?\/?$/],
    ['POST', /^\/automations\/?$/],
    ['POST', /^\/automations\/[^/]+\/check$/],
    ['GET', /^\/tracker\/automation-options$/],
    ['POST', /^\/tracker\/task$/],
  ];
  return rules.some(([verb, re]) => verb === method && re.test(rest));
}
