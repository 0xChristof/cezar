import { readdir } from 'node:fs/promises';
import { cockpitRuntimeRoot, readCockpitRuntime } from './cockpit-runtime.ts';

/**
 * Client side of the cockpit API authentication (server/api-auth.ts) for cezar's own CLIs
 * (`cez task`, `cez automation`, `cez runs`, `cez worktrees`, `cez-manager`, the tracker CLI).
 * Their requests to a cockpit get, in order of preference:
 *   - `x-cezar-task-token` — `CEZ_TASK_TOKEN`, which a cockpit hands the agent it runs;
 *   - `x-cezar-token` — `CEZ_API_TOKEN`, or the token of the cockpit published in its 0600 runtime
 *     lease, which only the user (not a sandboxed agent) can read.
 * Only requests to that cockpit carry a header: a loopback origin, or the `CEZ_API_URL` origin.
 */

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function cockpitTarget(url: URL, env: NodeJS.ProcessEnv): boolean {
  if (isLoopback(url.hostname)) return true;
  try {
    return Boolean(env.CEZ_API_URL) && new URL(env.CEZ_API_URL ?? '').origin === url.origin;
  } catch {
    return false;
  }
}

/** The token a running cockpit published for `url`'s port, from the runtime leases. */
export async function leaseTokenFor(url: URL, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  let slots: string[];
  try {
    slots = await readdir(cockpitRuntimeRoot(env));
  } catch {
    return undefined;
  }
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  for (const slot of slots) {
    try {
      const runtime = await readCockpitRuntime(slot, env);
      if (!runtime) continue;
      const origin = new URL(runtime.origin);
      const samePort = String(runtime.port) === port;
      if (origin.origin === url.origin || (samePort && isLoopback(origin.hostname) && isLoopback(url.hostname))) {
        return runtime.owner.token;
      }
    } catch {
      // An unreadable or foreign slot is not this cockpit.
    }
  }
  return undefined;
}

export async function cockpitAuthHeaders(target: URL, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
  if (!cockpitTarget(target, env)) return {};
  if (env.CEZ_TASK_TOKEN) return { 'x-cezar-task-token': env.CEZ_TASK_TOKEN };
  const token = env.CEZ_API_TOKEN || (await leaseTokenFor(target, env));
  return token ? { 'x-cezar-token': token } : {};
}

/** A `fetch` that adds the cockpit credentials to requests aimed at a cockpit; others pass untouched. */
export function withCockpitAuth(base: typeof fetch, env: NodeJS.ProcessEnv = process.env): typeof fetch {
  const wrapped = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      return base(input, init);
    }
    const extra = await cockpitAuthHeaders(target, env);
    if (Object.keys(extra).length === 0) return base(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [name, value] of Object.entries(extra)) if (!headers.has(name)) headers.set(name, value);
    return base(input, { ...init, headers });
  };
  return wrapped as typeof fetch;
}

/** Route this process's global `fetch` through `withCockpitAuth` (the CLIs default to it). */
export function installCockpitAuth(env: NodeJS.ProcessEnv = process.env): void {
  globalThis.fetch = withCockpitAuth(globalThis.fetch.bind(globalThis), env);
}
