import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildChildEnv } from '../core/agent-env.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import {
  issueTaskToken,
  resetTaskTokensForTests,
  resolveApiAuth,
  sessionCookieName,
  taskRouteAllowed,
  type ApiAuth,
} from './api-auth.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { createApp, verifyWsUpgrade } from './server.ts';

const HOST = '127.0.0.1:4321';
const auth: ApiAuth = { token: 'cockpit-secret-token', cookieName: sessionCookieName(4321) };

describe('cockpit API authentication (security hardening)', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    resetTaskTokensForTests();
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-api-auth-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    process.env.CEZ_DRY_RUN = '1';
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) =>
        store.createRun({ title: 't', workflow: '(planned)', task: input.task, steps: [] }),
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth(), apiAuth: auth });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers: { host: HOST, ...headers } });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { host: HOST, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('refuses an /api request with no credentials, even one that forges a same-origin Origin', async () => {
    expect((await get('/api/v1/runs')).status).toBe(401);
    expect((await post('/api/v1/runs', { task: 'x', steps: [{ id: 'w', prompt: '{{task}}' }] }, { origin: `http://${HOST}` })).status).toBe(401);
    expect((await get('/api/v1/runs', { 'x-cezar-token': 'wrong' })).status).toBe(401);
  });

  it('keeps the health probe open', async () => {
    expect((await get('/api/v1/health')).status).toBe(200);
  });

  it('accepts the cockpit token header and the session cookie', async () => {
    expect((await get('/api/v1/runs', { 'x-cezar-token': auth.token })).status).toBe(200);
    expect((await get('/api/v1/runs', { cookie: `other=1; ${auth.cookieName}=${auth.token}` })).status).toBe(200);
    expect((await get('/api/v1/runs', { cookie: `${sessionCookieName(9999)}=${auth.token}` })).status).toBe(401);
  });

  it('trades ?token= on a page for an HttpOnly session cookie and strips it from the address', async () => {
    const res = await get(`/p/default/?token=${auth.token}&x=1`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/p/default/?x=1');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${auth.cookieName}=${auth.token}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect((await get('/p/default/?token=wrong')).status).toBe(403);
  });

  it('answers a page opened without the session with a sign-in hint, not an empty cockpit', async () => {
    const res = await get('/p/default/', { accept: 'text/html' });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('cez open');
    expect((await get('/p/default/', { accept: 'text/html', cookie: `${auth.cookieName}=${auth.token}` })).status).not.toBe(401);
    // Assets stay public: the hint page is for navigations only.
    expect((await get('/assets/app.js', { accept: '*/*' })).status).not.toBe(401);
  });

  it('lets a task token reach only its own run and the agent routes', async () => {
    const run = store.createRun({ title: 't', workflow: '(planned)', task: 'x', steps: [] });
    const other = store.createRun({ title: 'o', workflow: '(planned)', task: 'y', steps: [] });
    const task = { 'x-cezar-task-token': issueTaskToken(run.id) };
    expect((await get('/api/v1/runs', task)).status).toBe(200);
    expect((await get(`/api/v1/runs/${run.id}`, task)).status).not.toBe(403);
    expect((await get(`/api/v1/runs/${other.id}`, task)).status).toBe(403);
    // Everything a person does stays out of reach: starting tasks, config, secrets.
    expect((await post('/api/v1/runs', { task: 'x', steps: [{ id: 'w', prompt: '{{task}}' }] }, task)).status).toBe(403);
    expect((await app.request('/api/v1/config', { method: 'PUT', headers: { host: HOST, ...task, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
  });

  it('lets an agent draft an automation but not enable it', async () => {
    const run = store.createRun({ title: 't', workflow: '(planned)', task: 'x', steps: [] });
    const task = { 'x-cezar-task-token': issueTaskToken(run.id) };
    const draft = { name: 'Nightly', kind: 'schedule', schedule: { type: 'daily', time: '03:00' }, task: { prompt: 'check' } };
    const enabled = await post('/api/v1/automations', { ...draft, enable: true }, task);
    expect(enabled.status).toBe(403);
    expect(((await enabled.json()) as { error: string }).error).toContain('paused');
  });
});

describe('taskRouteAllowed', () => {
  const grant = { runId: 'r-1' };
  it('allows the agent CLIs\' routes, project-scoped or not', () => {
    for (const [method, path] of [
      ['GET', '/api/v1/runs'],
      ['GET', '/api/v1/p/proj/runs/r-1'],
      ['POST', '/api/v1/runs/r-1/dispatch'],
      ['POST', '/api/v1/p/proj/runs/r-1/report'],
      ['POST', '/api/v1/automations'],
      ['POST', '/api/v1/p/proj/automations/a1/check'],
      ['GET', '/api/v1/automation-checks/c1'],
      ['POST', '/api/v1/tracker/task'],
    ] as const) {
      expect(taskRouteAllowed(method, path, grant), `${method} ${path}`).toBe(true);
    }
  });
  it('refuses everything else', () => {
    for (const [method, path] of [
      ['POST', '/api/v1/runs'],
      ['POST', '/api/v1/runs/r-2/dispatch'],
      ['GET', '/api/v1/runs/r-2'],
      ['GET', '/api/v1/runs/r-10'],
      ['PUT', '/api/v1/config'],
      ['POST', '/api/v1/automations/a1/enable'],
      ['POST', '/api/v1/automations/a1/run'],
      ['PUT', '/api/v1/automations/a1'],
      ['DELETE', '/api/v1/automations/a1'],
      ['GET', '/api/v1/secrets'],
      ['GET', '/other'],
    ] as const) {
      expect(taskRouteAllowed(method, path, grant), `${method} ${path}`).toBe(false);
    }
  });
});

describe('resolveApiAuth', () => {
  it('is on by default with the lease token, off only on request or under the token-less desktop shell', () => {
    const warnings: string[] = [];
    expect(resolveApiAuth({}, 4321, 'lease')?.token).toBe('lease');
    expect(resolveApiAuth({}, 4321, undefined)?.token).toMatch(/^[\w-]{40,}$/);
    expect(resolveApiAuth({ CEZ_API_TOKEN: 'given' }, 4321, 'lease')).toMatchObject({ token: 'given', alsoAccept: ['lease'] });
    expect(resolveApiAuth({ CEZ_API_AUTH: '0' }, 4321, 'lease')).toBeUndefined();
    expect(resolveApiAuth({ CEZ_DESKTOP: '1' }, 4321, 'lease', (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(resolveApiAuth({ CEZ_DESKTOP: '1', CEZ_API_TOKEN: 'given' }, 4321, 'lease')?.token).toBe('given');
  });
});

describe('the WebSocket bus needs the session', () => {
  const req = (headers: Record<string, string>) => ({ headers } as unknown as IncomingMessage);
  it('rejects an upgrade without the cookie or cockpit token, and any task token', () => {
    expect(verifyWsUpgrade(req({ host: HOST }), undefined, auth)).toBe(false);
    expect(verifyWsUpgrade(req({ host: HOST, 'x-cezar-task-token': issueTaskToken('r') }), undefined, auth)).toBe(false);
    expect(verifyWsUpgrade(req({ host: HOST, cookie: `${auth.cookieName}=${auth.token}` }), undefined, auth)).toEqual({ trusted: true });
    expect(verifyWsUpgrade(req({ host: HOST }))).toEqual({ trusted: true }); // auth off: unchanged
  });
});

describe('cockpit secrets never reach an agent', () => {
  it('drops inherited CEZ_API_TOKEN / CEZ_TASK_TOKEN, also under CEZ_AGENT_ENV_FULL, but keeps a per-launch grant', () => {
    const source = { PATH: '/bin', CEZ_API_TOKEN: 'cockpit', CEZ_TASK_TOKEN: 'parent-task', CEZ_DRY_RUN: '1' };
    const env = buildChildEnv({ backend: 'claude', source });
    expect(env.CEZ_API_TOKEN).toBeUndefined();
    expect(env.CEZ_TASK_TOKEN).toBeUndefined();
    expect(env.CEZ_DRY_RUN).toBe('1');
    const full = buildChildEnv({ backend: 'claude', source: { ...source, CEZ_AGENT_ENV_FULL: '1' } });
    expect(full.CEZ_API_TOKEN).toBeUndefined();
    expect(buildChildEnv({ backend: 'claude', source, extraEnv: { CEZ_TASK_TOKEN: 'own' } }).CEZ_TASK_TOKEN).toBe('own');
  });
});
