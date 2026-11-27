/**
 * Telemetry is REMOVED in this fork. This module keeps upstream's exports so the call sites
 * (`track`, `reportError`, `recordTiming`, the daily ping, the crash reporter, the consent API)
 * compile unchanged, but none of them sends, stores or identifies anything:
 *   - there is no endpoint and no network code at all;
 *   - consent is always `denied` and cannot be granted (the cockpit's consent bar, Settings →
 *     Privacy and `cezar telemetry enable` have nothing to turn on);
 *   - no install id (`cezarId`) is created and no crash handler is installed.
 * The pure helpers other modules use (`uuidv7`, `deviceSid`, `scrub`, `telemetryVersion`,
 * `telemetryRuntime`) are kept as they were.
 */
import { randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';

/** No endpoint: telemetry is removed. Kept so callers that print it show nothing. */
export const DEFAULT_TELEMETRY_URL = '';
export const TELEMETRY_POLICY_VERSION = 1;
export const DEV_TELEMETRY_SERVICE = '';

export function stampedTelemetryService(_file?: string): string | undefined {
  return undefined;
}

export type TelemetryConsent = 'unknown' | 'granted' | 'denied';

/** Always blocked: `env` is the reason the cockpit already knows how to show ("turned off"). */
export function telemetryBlockedBy(): 'env' | 'automation' | null {
  return 'env';
}

export function telemetryEnabled(): boolean {
  return false;
}

export function telemetryConsent(): TelemetryConsent {
  return 'denied';
}

export async function loadTelemetryConsent(): Promise<TelemetryConsent> {
  return 'denied';
}

/** Answers are not recorded; there is nothing to opt into. */
export async function setTelemetryConsent(_answer: 'granted' | 'denied'): Promise<TelemetryConsent> {
  return 'denied';
}

/** How this cezar was launched (`app` under the desktop shell, else `cli`). */
export function telemetryRuntime(): 'app' | 'cli' {
  return process.env.CEZ_DESKTOP === '1' ? 'app' : 'cli';
}

/** The release channel of a version string (`0.14.0-nightly.…` → `0.14.0-nightly`). */
export function telemetryVersion(raw: string, checkout = false): string {
  const match = /^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(raw.trim());
  if (!match) return 'unknown';
  const [, base, pre] = match;
  if (checkout || raw.includes('+')) return `${base}-dev`;
  if (!pre) return base!;
  if (/^nightly(\.|$)/.test(pre)) return `${base}-nightly`;
  if (/^pr\d+/.test(pre)) return `${base}-pr`;
  return `${base}-dev`;
}

export async function initTelemetry(_opts: { version: string }): Promise<void> {}

export function installCrashReporter(): void {}

/** RFC 9562 UUIDv7: 48-bit Unix-ms timestamp, then random bits — sortable by creation time. */
export function uuidv7(now: number = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The header the cockpit sends its device id in; anything that is not a v7 UUID is ignored. */
export function deviceSid(header: string | undefined | null): string | undefined {
  return header && SID_RE.test(header) ? header.toLowerCase() : undefined;
}

export function track(
  _event: string,
  _extra: Record<string, string | number | boolean | undefined> = {},
  _opts: { sid?: string } = {},
): void {}

export interface TimingFields {
  operation?: string;
  target?: string;
  outcome?: string;
}

export function recordTiming(_name: string, _durationMs: number, _fields: TimingFields = {}): void {}

/** What an event would carry; nothing is sent. */
export function telemetryEnvelope(): Record<string, string> {
  return { runtime: telemetryRuntime() };
}

/** No events exist any more. */
export const TELEMETRY_EVENTS: readonly string[] = [];

export function registerDailyInventory(_collect: (() => Promise<Array<{ label: string; value: number }>>) | undefined): void {}

export async function sendDailyPing(): Promise<void> {}

export function startDailyPing(): void {}

/** `process.cwd()` throws once the directory is deleted. */
function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return '';
  }
}

/** Replace paths that name the user or their work: the working directory becomes `<repo>`, the
 *  temp dir `<tmp>`, the home directory `~` (still used for messages shown in the cockpit). */
export function scrub(text: string): string {
  const cwd = safeCwd();
  const pairs: Array<[string, string]> = [
    [cwd === homedir() ? '' : cwd, '<repo>'],
    [tmpdir(), '<tmp>'],
    [homedir(), '~'],
  ];
  return pairs
    .filter(([path]) => path.length > 1)
    .sort((a, b) => b[0].length - a[0].length)
    .reduce((out, [path, mask]) => out.split(path).join(mask), text);
}

export type ContextValue = string | number | boolean | null;
type Context = Record<string, ContextValue | undefined>;

export function registerTelemetryContext(_provider: () => Context): void {}

export function reportError(
  _error: unknown,
  _context: Context = {},
  _opts: { code?: string; fingerprint?: string; sid?: string; version?: string; unthrottled?: boolean } = {},
): void {}

export async function flushTelemetry(_maxMs = 1_500): Promise<void> {}
