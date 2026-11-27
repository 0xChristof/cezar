import { describe, expect, it, vi } from 'vitest';
import { withCockpitAuth } from './cockpit-client-auth.ts';

describe('withCockpitAuth — the CLIs\' cockpit credentials', () => {
  const capture = () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const base = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response('{}');
    });
    return { seen, base: base as unknown as typeof fetch };
  };

  it('sends a task token when the process is an agent, never the cockpit token', async () => {
    const { seen, base } = capture();
    await withCockpitAuth(base, { CEZ_TASK_TOKEN: 'task', CEZ_API_TOKEN: 'cockpit' })('http://127.0.0.1:4321/api/v1/runs');
    expect(seen[0]?.headers.get('x-cezar-task-token')).toBe('task');
    expect(seen[0]?.headers.get('x-cezar-token')).toBeNull();
  });

  it('sends CEZ_API_TOKEN to the cockpit and keeps a caller\'s own headers', async () => {
    const { seen, base } = capture();
    await withCockpitAuth(base, { CEZ_API_TOKEN: 'cockpit' })('http://localhost:4321/api/v1/runs', { headers: { accept: 'application/json' } });
    expect(seen[0]?.headers.get('x-cezar-token')).toBe('cockpit');
    expect(seen[0]?.headers.get('accept')).toBe('application/json');
  });

  it('never attaches a credential to a non-cockpit host', async () => {
    const { seen, base } = capture();
    await withCockpitAuth(base, { CEZ_API_TOKEN: 'cockpit', CEZ_TASK_TOKEN: 'task' })('https://api.github.com/zen');
    expect(seen[0]?.headers.get('x-cezar-token')).toBeNull();
    expect(seen[0]?.headers.get('x-cezar-task-token')).toBeNull();
  });

  it('treats the CEZ_API_URL origin as the cockpit (hosted installs)', async () => {
    const { seen, base } = capture();
    await withCockpitAuth(base, { CEZ_API_URL: 'https://cezar.example.com', CEZ_API_TOKEN: 'cockpit' })('https://cezar.example.com/api/v1/runs');
    expect(seen[0]?.headers.get('x-cezar-token')).toBe('cockpit');
  });
});
