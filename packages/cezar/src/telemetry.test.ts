import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  flushTelemetry,
  loadTelemetryConsent,
  recordTiming,
  reportError,
  sendDailyPing,
  setTelemetryConsent,
  startDailyPing,
  telemetryBlockedBy,
  telemetryEnabled,
  track,
} from './telemetry.ts';
import { runTelemetryCommand } from './telemetry-cli.ts';

/** Telemetry is removed in this fork: nothing is ever sent, stored or switched on. */
describe('telemetry removed', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('never touches the network, even after an attempted opt-in and with CEZ_TELEMETRY=1', async () => {
    const network = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', network);
    vi.stubEnv('CEZ_TELEMETRY', '1');
    expect(await setTelemetryConsent('granted')).toBe('denied');
    expect(await loadTelemetryConsent()).toBe('denied');
    expect(telemetryEnabled()).toBe(false);
    expect(telemetryBlockedBy()).toBe('env');
    track('task_start', { label: 'claude' });
    recordTiming('boot', 12);
    reportError(new Error('boom'));
    startDailyPing();
    await sendDailyPing();
    await flushTelemetry();
    expect(network).not.toHaveBeenCalled();
  });

  it('the CLI says it is removed for every subcommand', async () => {
    for (const sub of ['status', 'enable', 'disable', 'inspect']) {
      const lines: string[] = [];
      expect(await runTelemetryCommand([sub], { log: (l) => lines.push(l), error: (l) => lines.push(l) })).toBe(0);
      expect(lines.join('\n')).toContain('removed');
    }
    expect(await runTelemetryCommand(['bogus'], { log: () => {}, error: () => {} })).toBe(1);
  });
});
