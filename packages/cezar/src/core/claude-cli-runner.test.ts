import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-runner.ts';
import { isSignalTerminationExit, prependSystemPrompt } from './agent-runner.ts';
import {
  buildClaudeArgs,
  CLAUDE_HEADLESS_GUIDANCE,
  ClaudeCliRunner,
  appendClaudeSystemPrompt,
  shouldSpoolSystemPrompt,
  writeClaudeSystemPromptFile,
  claudeExitMessage,
  claudeMcpServers,
  writeClaudeSettingsFile,
  withClaudeSandbox,
  sandboxRunOf,
  scopeFileWrites,
  EOF_KILL_GRACE_MS,
  EOF_TERM_GRACE_MS,
  KILL_GRACE_MS,
} from './claude-cli-runner.ts';
import { cezInstallRoot, claudeSandboxSettings, projectRootOf, SECRET_FILE_PATTERNS } from './claude-sandbox.ts';
import { recordOwnSignal, resetOwnSignalsForTests } from './process-signals.ts';
import { ClaudeSessionCost, resetClaudeSessionCosts } from './claude-session-cost.ts';
import type { UiEvent } from './ui-events.ts';
import { connectorCallFence, connectorCallPrompt } from '../managers/connectors.ts';

/** Only the escalation tests below swap the child out; every other test in this
 *  file keeps spawning its real stub binary through the untouched `spawn`. */
const spawnHook = vi.hoisted(() => ({ override: null as null | (() => unknown) }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnHook.override ? spawnHook.override() : actual.spawn(...args),
  };
});

// The suites below pin settings shapes; the default OS sandbox has its own suite at the end.
beforeEach(() => {
  vi.stubEnv('CEZ_AGENT_SANDBOX', '0');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * The per-backend system-prompt delivery mechanism (spec §protocol v2
 * mapping table): claude gets `--append-system-prompt`, codex/opencode get
 * the prompt prepended to the opening user message (`prependSystemPrompt`,
 * shared by both runners).
 */
describe('buildClaudeArgs systemPrompt', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('emits --append-system-prompt with the exact text', () => {
    const args = buildClaudeArgs({ ...spec, systemPrompt: 'Extra rules.\n\n---\n\nContract.' });
    const idx = args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(appendClaudeSystemPrompt('Extra rules.\n\n---\n\nContract.'));
  });

  it('always appends Claude-local headless denial guidance', () => {
    const args = buildClaudeArgs(spec);
    const idx = args.indexOf('--append-system-prompt');
    expect(args[idx + 1]).toBe(CLAUDE_HEADLESS_GUIDANCE);
  });

  it('preserves caller instructions before the backend guidance', () => {
    expect(appendClaudeSystemPrompt('Caller rules.')).toBe(
      `Caller rules.\n\n---\n\n${CLAUDE_HEADLESS_GUIDANCE}`,
    );
  });

  it('uses the same guidance for a resumed call without changing resume args', () => {
    const initial = buildClaudeArgs({ ...spec, sessionId: 'session-1' });
    const resumed = buildClaudeArgs({ ...spec, sessionId: 'session-1', resume: true });
    expect(initial[initial.indexOf('--append-system-prompt') + 1]).toBe(CLAUDE_HEADLESS_GUIDANCE);
    expect(resumed[resumed.indexOf('--append-system-prompt') + 1]).toBe(CLAUDE_HEADLESS_GUIDANCE);
    expect(initial).toContain('--session-id');
    expect(resumed).toContain('--resume');
  });
});

describe('buildClaudeArgs enforceReadOnly', () => {
  const spec = { userPrompt: 'look', cwd: '/tmp', allowedTools: ['Read', 'Grep', 'Glob'] };

  it('denies the write tools, so settings allow rules cannot grant them back', () => {
    const args = buildClaudeArgs({ ...spec, enforceReadOnly: true });
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Bash,Edit,Write,MultiEdit,NotebookEdit');
  });

  it('denies nothing on an ordinary run', () => {
    expect(buildClaudeArgs(spec)).not.toContain('--disallowedTools');
  });
});

describe('buildClaudeArgs noMcpServers', () => {
  const spec = { userPrompt: 'look', cwd: '/tmp', allowedTools: ['Read'] };
  const server = { name: 'docs', command: 'docs-mcp', args: [], env: {} } as never;

  it('loads no MCP server, a private one included', () => {
    const args = buildClaudeArgs({ ...spec, noMcpServers: true, mcpServers: [server] }, {}, '/tmp/mcp.json');
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--mcp-config');
  });

  it('keeps the configured servers on an ordinary run', () => {
    expect(buildClaudeArgs(spec)).not.toContain('--strict-mcp-config');
  });

  it('also switches claude.ai connectors off in the child, and only then', async () => {
    const bin = fileURLToPath(new URL('./__fixtures__/claude/stub-reports-mcp-switches.mjs', import.meta.url));
    const run = (noMcpServers: boolean) => new ClaudeCliRunner({ bin, timeoutMs: 0 })
      .run({ ...spec, cwd: process.cwd(), env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'kept' }, ...(noMcpServers ? { noMcpServers } : {}) });
    expect((await run(true)).text).toBe('claudeai=false strict=true');
    expect((await run(false)).text).toBe('claudeai=kept strict=false');
  });
});

describe('buildClaudeArgs bashHookCommand', () => {
  const spec = { userPrompt: 'look', cwd: '/tmp', allowedTools: ['Read', 'Bash'], bashAllowlist: ['gh pr view'] };

  it('installs it as a Bash PreToolUse hook beside the prefix rules', () => {
    const args = buildClaudeArgs({ ...spec, bashHookCommand: "'/usr/bin/node' '/x/hook.js'" });
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Bash(gh pr view:*)');
    expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: "'/usr/bin/node' '/x/hook.js'" }] }] },
    });
  });

  it('adds no settings without a hook, or when Bash is not allowed at all', () => {
    expect(buildClaudeArgs(spec)).not.toContain('--settings');
    expect(buildClaudeArgs({ ...spec, allowedTools: ['Read'], bashHookCommand: 'x' })).not.toContain('--settings');
  });

  // The Seatbelt sandbox denies the loopback connect, so `cez-manager` failed with `fetch failed`.
  it('excludes sandboxExcludedCommands from the sandbox in the same settings as the hook', () => {
    const args = buildClaudeArgs({ ...spec, bashHookCommand: 'h', sandboxExcludedCommands: ['cez-manager *'] });
    expect(args.filter((arg) => arg === '--settings')).toHaveLength(1);
    expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'h' }] }] },
      sandbox: { excludedCommands: ['cez-manager *'] },
    });
    const alone = buildClaudeArgs({ ...spec, sandboxExcludedCommands: ['cez-manager *'] });
    expect(JSON.parse(alone[alone.indexOf('--settings') + 1]!)).toEqual({ sandbox: { excludedCommands: ['cez-manager *'] } });
    expect(buildClaudeArgs({ ...spec, allowedTools: ['Read'], sandboxExcludedCommands: ['cez-manager *'] })).not.toContain('--settings');
  });
});

describe('buildClaudeArgs bypassPermissions', () => {
  const spec = { userPrompt: 'go', cwd: '/tmp' };
  const mode = (args: string[]) => args[args.indexOf('--permission-mode') + 1];

  it('skips every prompt only when the project opted in, and never for a read-only run', () => {
    expect(mode(buildClaudeArgs(spec))).toBe('dontAsk');
    expect(mode(buildClaudeArgs({ ...spec, bypassPermissions: true }))).toBe('bypassPermissions');
    expect(mode(buildClaudeArgs({ ...spec, bypassPermissions: true }, { CEZ_APPROVAL_GATE: '1' }))).toBe('bypassPermissions');
    expect(mode(buildClaudeArgs({ ...spec, bypassPermissions: true, enforceReadOnly: true }))).toBe('dontAsk');
  });
});

describe('buildClaudeArgs output mode', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('runs in print mode, which both stream-json formats require', () => {
    expect(buildClaudeArgs(spec)).toContain('--print');
  });

  it('asks for partial messages so text streams as deltas', () => {
    expect(buildClaudeArgs(spec)).toContain('--include-partial-messages');
  });

  it('passes a reasoning effort as --effort (#808)', () => {
    const args = buildClaudeArgs({ ...spec, reasoningEffort: 'xhigh' });
    expect(args[args.indexOf('--effort') + 1]).toBe('xhigh');
  });

  it('re-sends the effort on a resumed session, since --effort is session-scoped', () => {
    const args = buildClaudeArgs({ ...spec, sessionId: 's1', resume: true, reasoningEffort: 'low' });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--effort') + 1]).toBe('low');
  });

  it('leaves the native effort untouched when none is chosen', () => {
    expect(buildClaudeArgs(spec)).not.toContain('--effort');
  });
});

describe('buildClaudeArgs approval gate', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('denies unapproved tools without prompting by default', () => {
    const args = buildClaudeArgs(spec, {});
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('dontAsk');
  });

  it('enables Claude approval prompts only when explicitly requested', () => {
    const args = buildClaudeArgs(spec, { CEZ_APPROVAL_GATE: '1' });
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('acceptEdits');
  });
});

/**
 * #703 — a session cezar tore down itself must not settle as an agent
 * failure. Every agent CLI installs its own stop-signal handler and exits
 * `128 + signal`, so the runner sees a NON-ZERO code for a teardown it
 * asked for (goal achieved → `end()`, or a user cancel → `interrupt()`).
 */
describe('isSignalTerminationExit', () => {
  it('recognizes the 128+signal codes a signalled CLI reports', () => {
    expect(isSignalTerminationExit(130)).toBe(true); // SIGINT
    expect(isSignalTerminationExit(137)).toBe(true); // SIGKILL
    expect(isSignalTerminationExit(143)).toBe(true); // SIGTERM
  });

  it('leaves genuine failures and clean exits alone', () => {
    for (const code of [0, 1, 2, 127, null]) {
      expect(isSignalTerminationExit(code)).toBe(false);
    }
  });
});

describe('a teardown cezar initiated', () => {
  const stubBin = fileURLToPath(
    new URL('./__fixtures__/claude/stub-ignores-eof-exits-143.mjs', import.meta.url),
  );

  it('settles the session instead of failing it when the CLI exits 143', async () => {
    const runner = new ClaudeCliRunner({ bin: stubBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const uiEvents: UiEvent[] = [];
    let sawText: () => void = () => {};
    const firstText = new Promise<void>((resolve) => {
      sawText = resolve;
    });
    const session = runner.startSession(
      { userPrompt: 'do it', cwd: process.cwd() },
      (event) => {
        events.push(event);
        if (event.type === 'text') sawText();
      },
      { onUiEvent: (event) => uiEvents.push(event) },
    );
    await firstText;

    // The cancel path; the EOF watchdog reaches the same `signalChild`.
    session.interrupt();
    const result = await session.result;

    expect(result.text).toBe('work done');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(
      uiEvents.some((event) => event.type === 'turn.completed' && event.stopReason === 'error'),
    ).toBe(false);
    expect(uiEvents).toContainEqual({
      type: 'turn.completed',
      turnId: 'turn_1',
      stopReason: 'end_turn',
    });
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(
      events.some((e) => e.type === 'note' && e.message.includes('terminated by cezar (code 143)')),
    ).toBe(true);
  }, 15_000);
});

// Telemetry 3ac6bbe3: a SIGTERM that reached cezar too (a unit stop, a logout, the group's Ctrl-C)
// made claude exit 143 mid-shutdown, and the run was failed and reported as a crash.
describe('a 143 exit while cezar itself is being signalled', () => {
  const stubBin = fileURLToPath(new URL('./__fixtures__/claude/stub-exits-143-on-its-own.mjs', import.meta.url));
  afterEach(() => resetOwnSignalsForTests());

  it('stays unsettled through the shutdown, then settles as an interruption', async () => {
    resetOwnSignalsForTests(1_000);
    const events: AgentEvent[] = [];
    const session = new ClaudeCliRunner({ bin: stubBin, timeoutMs: 0 })
      .startSession({ userPrompt: 'do it', cwd: process.cwd() }, (event) => events.push(event));
    recordOwnSignal('SIGTERM');
    let settled = false;
    const outcome = session.result.then(
      () => 'resolved',
      (err: Error) => err.message,
    ).finally(() => { settled = true; });

    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(settled).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(false);

    expect(await outcome).toBe('interrupted — cezar received SIGTERM and the claude CLI stopped with it (code 143)');
  }, 15_000);

  it('still fails with the signal named when only the CLI was signalled', async () => {
    const session = new ClaudeCliRunner({ bin: stubBin, timeoutMs: 0 })
      .startSession({ userPrompt: 'do it', cwd: process.cwd() }, () => {});
    await expect(session.result).rejects.toThrow('claude CLI exited with code 143 (SIGTERM: a signal cezar did not send)');
  }, 15_000);

  it('ignores a signal cezar received before the session started', async () => {
    recordOwnSignal('SIGTERM', Date.now() - 60_000);
    const session = new ClaudeCliRunner({ bin: stubBin, timeoutMs: 0 })
      .startSession({ userPrompt: 'do it', cwd: process.cwd() }, () => {});
    await expect(session.result).rejects.toThrow('a signal cezar did not send');
  }, 15_000);
});

/**
 * #844 — the watchdogs used to ask `!child.killed` before escalating, but Node
 * sets `killed` the moment a signal is *delivered*. claude installs its own
 * SIGTERM handler, so the flag went true while the process ran on and the
 * SIGKILL that exists for exactly that case was never sent — one leaked CLI per
 * teardown. The escalation now follows real termination instead.
 */
describe('SIGTERM→SIGKILL escalation for a CLI that survives SIGTERM', () => {
  function signallableChild(): {
    child: ChildProcessWithoutNullStreams;
    signals: NodeJS.Signals[];
    exit: (code: number) => void;
  } {
    const signals: NodeJS.Signals[] = [];
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      pid: 4242,
      // Node's semantics: delivery flips `killed`; a CLI with its own handler
      // keeps running with `exitCode` still null.
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal);
        Object.assign(child, { killed: true });
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    const exit = (code: number) => {
      Object.assign(child, { exitCode: code });
      emitter.emit('exit', code, null);
    };
    return { child, signals, exit };
  }

  function withFakeChild(run: (fake: ReturnType<typeof signallableChild>) => void): void {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    vi.useFakeTimers();
    try {
      run(fake);
    } finally {
      vi.useRealTimers();
      spawnHook.override = null;
    }
  }

  it('escalates after end() even though Node already flagged the child as killed', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      session.end();

      vi.advanceTimersByTime(EOF_TERM_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
      // Delivered, not dead — the state that used to disable the escalation.
      expect(fake.child.killed).toBe(true);
      expect(fake.child.exitCode).toBeNull();

      vi.advanceTimersByTime(EOF_KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('escalates on the wall-clock timeout path as well', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 20 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      vi.advanceTimersByTime(20);
      expect(fake.signals).toEqual(['SIGTERM']);

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  // cf2191f1: a 30-minute WALL clock killed steps that were still streaming work.
  it('never kills a session that keeps streaming, only one that went silent for the whole window', async () => {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    vi.useFakeTimers();
    try {
      const events: AgentEvent[] = [];
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 1_000 }).startSession(
        { userPrompt: 'do it', cwd: process.cwd() },
        (event) => events.push(event),
      );
      void session.result.catch(() => undefined);
      const frame = `${JSON.stringify({ type: 'system', subtype: 'status' })}\n`;
      for (let i = 0; i < 5; i += 1) {
        (fake.child.stdout as PassThrough).write(frame);
        await vi.advanceTimersByTimeAsync(800);
      }
      // 4 s of wall clock against a 1 s limit: still alive, because it never went quiet.
      expect(fake.signals).toEqual([]);

      await vi.advanceTimersByTimeAsync(200);
      expect(fake.signals).toEqual(['SIGTERM']);
      fake.exit(143);
      await session.result;
      const error = events.find((e) => e.type === 'error');
      expect(error).toEqual({
        type: 'error',
        message: 'claude CLI timed out after 1s without any output and was killed — Continue picks the task up again',
      });
    } finally {
      vi.useRealTimers();
      spawnHook.override = null;
    }
  });

  it('stops escalating once the CLI really exits after SIGTERM', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      session.end();

      vi.advanceTimersByTime(EOF_TERM_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
      fake.exit(143);

      vi.advanceTimersByTime(EOF_KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
    });
  });

  it('stops accepting messages once the child has exited on its own', () => {
    withFakeChild((fake) => {
      const session = new ClaudeCliRunner({ bin: 'claude', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      expect(session.open).toBe(true);
      fake.exit(1);

      expect(session.open).toBe(false);
      expect(session.sendMessage([{ type: 'text', text: 'are you there?' }])).toBe(false);
    });
  });
});

describe('claudeExitMessage', () => {
  it('names a hangup the CLI exited on, which cezar never sends (telemetry 046a0525)', () => {
    expect(claudeExitMessage(129, '')).toBe(
      'claude CLI exited with code 129 (SIGHUP: the terminal or console it ran under went away — cezar did not stop it)',
    );
  });

  it('names any other signal exit, and keeps the stderr tail', () => {
    expect(claudeExitMessage(137, 'a\nb')).toBe('claude CLI exited with code 137 (SIGKILL: a signal cezar did not send) — a | b');
  });

  it('leaves an ordinary failure code alone', () => {
    expect(claudeExitMessage(1, 'boom\n')).toBe('claude CLI exited with code 1 — boom');
  });
});

describe('prependSystemPrompt (codex/opencode delivery)', () => {
  it('prepends the prompt as a leading block of the first user message', () => {
    expect(prependSystemPrompt('Extra rules.', 'do it')).toBe('Extra rules.\n\n---\n\ndo it');
  });

  it('leaves the user prompt untouched when no systemPrompt is set', () => {
    expect(prependSystemPrompt(undefined, 'do it')).toBe('do it');
  });
});

describe('ClaudeCliRunner dry-run auth replay', () => {
  it('rejects a manager prompt once and answers its replay with CEZ_HOME unset', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cez-claude-auth-replay-'));
    const home = join(cwd, 'home');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('CEZ_HOME', undefined);
    vi.stubEnv('CEZ_CLAUDE_BIN', undefined);
    vi.stubEnv('CEZ_DRY_RUN', '1');

    try {
      const runner = new ClaudeCliRunner({ timeoutMs: 3_000 });
      const spec = { cwd, userPrompt: '[cez-manager:watch]\nmock:auth-error' };
      const firstEvents: AgentEvent[] = [];
      await runner.run(spec, (event) => firstEvents.push(event));
      expect(firstEvents).toContainEqual({
        type: 'error',
        message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      });

      const replay = await runner.run(spec);
      expect(replay.text).toBe('MANAGER:QUIET');
      expect(readdirSync(join(home, '.cezar', 'mock-auth-once'))).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});

describe('ClaudeCliRunner token usage', () => {
  it('counts the aggregate result usage without re-adding assistant-frame snapshots', async () => {
    const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
    const runner = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 60_000 });
    const events: AgentEvent[] = [];
    const cwd = mkdtempSync(join(tmpdir(), 'cez-claude-token-usage-'));

    try {
      const result = await runner.run(
        {
          userPrompt: 'fix the login redirect',
          cwd,
          env: {
            CEZ_HANDOFF_FILE: '',
            CEZ_MOCK_ARGS_FILE: '',
            CEZ_TODOS_FILE: '',
          },
          sessionId: '5f701b42-382a-4a6e-b831-0ab9e56eff58',
        },
        (event) => events.push(event),
      );

      // The mock emits four assistant usage snapshots before its aggregate
      // result usage (1,270 input + 185 output). Only the result is authoritative.
      expect(result.tokensUsed).toBe(1_455);
      expect(events.filter((event) => event.type === 'token-usage')).toEqual([
        { type: 'token-usage', tokensUsed: 1_455 },
      ]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});

describe('ClaudeCliRunner private MCP (spec 2026-10-07-private-project-mcp)', () => {
  it('spawns with --mcp-config pointing at a 0600 file that is gone once the session ends', async () => {
    const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
    const runner = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 60_000 });
    const cwd = mkdtempSync(join(tmpdir(), 'cez-claude-private-mcp-'));
    const argsFile = join(cwd, 'args.ndjson');
    try {
      await runner.run({
        userPrompt: 'do it',
        cwd,
        env: { CEZ_HANDOFF_FILE: '', CEZ_MOCK_ARGS_FILE: argsFile, CEZ_TODOS_FILE: '' },
        allowedTools: ['Read'],
        mcpServers: [{ name: 'tracker', transport: 'stdio', command: 'tracker-mcp', args: [], env: { TOKEN: 's3cret' }, headers: {} }],
      });
      const argv = JSON.parse(readFileSync(argsFile, 'utf8').trim().split('\n')[0]!) as string[];
      const configPath = argv[argv.indexOf('--mcp-config') + 1]!;
      expect(argv).toContain('--mcp-config');
      expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('Read,mcp__tracker');
      expect(argv.join(' ')).not.toContain('s3cret');
      expect(existsSync(configPath)).toBe(false);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});

describe('a CLI that dies before reading its prompt', () => {
  const stubBin = fileURLToPath(
    new URL('./__fixtures__/claude/stub-exits-before-reading.mjs', import.meta.url),
  );

  // A failed stdin write surfaces as an async 'error' event on the pipe, not a throw; unhandled,
  // it crashed the whole cezar process (seen on a fleet hub when the CLI failed to start).
  it('fails the session instead of crashing the process on EPIPE', async () => {
    const runner = new ClaudeCliRunner({ bin: stubBin, timeoutMs: 0 });
    const session = runner.startSession(
      { userPrompt: 'x'.repeat(8 * 1024 * 1024), cwd: process.cwd() },
      () => {},
    );
    await expect(session.result).rejects.toThrow('claude CLI exited with code 1');
    // Give a late EPIPE time to surface as an unhandled error, which vitest reports as a failure.
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
});

// Spec 2026-10-24 item 9 (eb4b12dc): a gateway's OpenAI-shaped envelope read as its type and message.
describe('claude result error with a JSON envelope', () => {
  it('shows the vendor error type and message, not the raw JSON', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-envelope-'));
    const bin = join(root, 'claude.mjs');
    const result = 'API Error: 400 [400]: {"error":{"type":"invalid_request_error","message":"model gpt-5 is not available","param":null,"code":null}}';
    writeFileSync(bin, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify({ type: 'result', is_error: true, result }))});\nprocess.exit(1);\n`, { mode: 0o755 });
    try {
      const errors: string[] = [];
      await new ClaudeCliRunner({ bin, timeoutMs: 5000 })
        .run({ cwd: root, userPrompt: 'work' }, (event) => { if (event.type === 'error') errors.push(event.message); })
        .catch(() => undefined);
      expect(errors).toContain('API Error: 400 [400]: invalid_request_error: model gpt-5 is not available');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('system prompt past the Windows command-line limit (#1584)', () => {
  const big = 'x'.repeat(40_000);

  it('spools only on win32 and only when the prompt is large', () => {
    expect(shouldSpoolSystemPrompt(big, 'win32')).toBe(true);
    expect(shouldSpoolSystemPrompt('short', 'win32')).toBe(false);
    expect(shouldSpoolSystemPrompt(big, 'linux')).toBe(false);
    expect(shouldSpoolSystemPrompt(big, 'darwin')).toBe(false);
    expect(writeClaudeSystemPromptFile(big, 'linux')).toBeUndefined();
  });

  it('passes a file flag and keeps the prompt out of argv', () => {
    const file = writeClaudeSystemPromptFile(big, 'win32');
    expect(file).toBeDefined();
    try {
      const args = buildClaudeArgs({ userPrompt: 'do it', cwd: '/tmp', systemPrompt: big }, process.env, undefined, file!.path);
      expect(args).not.toContain('--append-system-prompt');
      expect(args[args.indexOf('--append-system-prompt-file') + 1]).toBe(file!.path);
      expect(args.join(' ').length).toBeLessThan(2_000);
      expect(readFileSync(file!.path, 'utf8')).toBe(big);
    } finally {
      file!.cleanup();
    }
  });
});

describe('ClaudeCliRunner connectors (spec 2026-11-12-manager-connectors)', () => {
  const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
  const tool = 'mcp__claude_ai_Google_Calendar__create_event';

  it('reads mcp_servers and tools off system/init, and nothing off other frames', () => {
    expect(claudeMcpServers({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'claude.ai Gmail', status: 'failed' }, { bogus: 1 }], tools: ['Read', 7, 'mcp__a__b'] }))
      .toEqual({ type: 'mcp-servers', servers: [{ name: 'claude.ai Gmail', status: 'failed' }], tools: ['Read', 'mcp__a__b'] });
    expect(claudeMcpServers({ type: 'system', subtype: 'init' })).toBeUndefined();
  });

  it('passes --settings as a path, never the JSON, and only when settings are given', () => {
    const settings = { hooks: { PreToolUse: [] } };
    const off = { CEZ_AGENT_SANDBOX: '0' };
    const args = buildClaudeArgs({ userPrompt: 'x', cwd: '/', claudeSettings: settings }, off, undefined, undefined, '/tmp/s.json');
    expect(args.slice(args.indexOf('--settings'), args.indexOf('--settings') + 2)).toEqual(['--settings', '/tmp/s.json']);
    expect(args.join(' ')).not.toContain('PreToolUse');
    expect(buildClaudeArgs({ userPrompt: 'x', cwd: '/' }, off, undefined, undefined, '/tmp/s.json')).not.toContain('--settings');
    // With the sandbox on, a fence file still means exactly one --settings: the sandbox rides inside it.
    const fenced = buildClaudeArgs({ userPrompt: 'x', cwd: '/', claudeSettings: settings }, {}, undefined, undefined, '/tmp/s.json');
    expect(fenced.filter((arg) => arg === '--settings')).toEqual(['--settings']);
  });

  it('writes the settings to a 0600 file its cleanup removes', () => {
    const file = writeClaudeSettingsFile({ a: 1 })!;
    try {
      expect(JSON.parse(readFileSync(file.path, 'utf8'))).toEqual({ a: 1 });
      if (process.platform !== 'win32') expect((statSync(file.path).mode & 0o777).toString(8)).toBe('600');
    } finally {
      file.cleanup();
    }
    expect(existsSync(file.path)).toBe(false);
    expect(writeClaudeSettingsFile(undefined)).toBeUndefined();
  });

  const call = async (args: Record<string, unknown>) => {
    const cwd = mkdtempSync(join(tmpdir(), 'cez-claude-connector-'));
    const fence = connectorCallFence(tool, args);
    const events: AgentEvent[] = [];
    try {
      await new ClaudeCliRunner({ bin: mockBin, timeoutMs: 60_000 }).run({
        userPrompt: connectorCallPrompt(tool, args),
        cwd,
        env: { CEZ_HANDOFF_FILE: '', CEZ_MOCK_ARGS_FILE: '', CEZ_TODOS_FILE: '', CEZ_MANAGER_ID: 'm1' },
        allowedTools: [tool],
        claudeSettings: fence.settings,
      }, (event) => events.push(event));
    } finally {
      fence.cleanup();
      rmSync(cwd, { force: true, recursive: true });
    }
    return events;
  };

  it('emits the init servers and lets the approved input through the PreToolUse hook', async () => {
    const events = await call({ summary: 'Kick-Off', when: { start: '2027-01-21' } });
    expect(events.find((event) => event.type === 'mcp-servers')).toMatchObject({
      servers: [{ name: 'claude.ai Google Calendar', status: 'connected' }],
      tools: expect.arrayContaining([tool]),
    });
    expect(events.find((event) => event.type === 'tool-result')).toMatchObject({ isError: false });
  });

  it('denies an input that differs from the approved one', async () => {
    const events = await call({ summary: 'mock:tamper' });
    const result = events.find((event) => event.type === 'tool-result');
    expect(result).toMatchObject({ isError: true });
    expect(result?.type === 'tool-result' && result.result).toContain('differs from the one the user approved');
  });
});

// Claude's result totals are session-wide running sums; each turn reports only its own share.
describe('per-turn cost from a session running total', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-claude-turn-cost-'));
  });
  afterEach(() => {
    resetClaudeSessionCosts();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports each result as an increment, in v1 cost and v2 turn usage alike', async () => {
    const stubBin = join(dir, 'claude-two-turns.mjs');
    const result = (total: number, input: number) => JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'unpinned-1',
      total_cost_usd: total, usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: { 'claude-opus-5-5': { inputTokens: input, outputTokens: 2, costUSD: total, contextWindow: 200000 } },
    });
    writeFileSync(stubBin, `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'unpinned-1', model: 'claude-opus-5-5' }));
console.log(${JSON.stringify(result(0.5, 10))});
console.log(${JSON.stringify(result(1.25, 30))});
`, { mode: 0o700 });
    const events: AgentEvent[] = [];
    const uiEvents: UiEvent[] = [];
    const session = new ClaudeCliRunner({ bin: stubBin, timeoutMs: 0 }).startSession(
      { userPrompt: 'go', cwd: dir },
      (event) => events.push(event),
      { onUiEvent: (event) => uiEvents.push(event) },
    );
    await session.result;

    expect(events.flatMap((e) => (e.type === 'cost' ? [e.usd] : []))).toEqual([0.5, 0.75]);
    const models = uiEvents.flatMap((e) => (e.type === 'turn.completed' ? [e.models?.[0]] : []));
    expect(models).toEqual([
      { model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 2, costUsd: 0.5 },
      { model: 'claude-opus-5-5', inputTokens: 20, outputTokens: 0, costUsd: 0.75 },
    ]);
    // The session is now known: a resume in this process diffs against its last total.
    expect(new ClaudeSessionCost('unpinned-1', true, dir, undefined).increment(2)).toBeCloseTo(0.75);
  }, 15_000);
});

describe('default OS sandbox for Claude Bash', () => {
  const spec = { userPrompt: 'go', cwd: '/tmp', allowedTools: ['Read', 'Bash'] };
  const settingsOf = (args: string[]) => JSON.parse(args[args.indexOf('--settings') + 1]!) as Record<string, any>;
  const home = '/home/dev';
  const on: NodeJS.ProcessEnv = { HOME: home };

  it('is on by default: fail-closed, no unsandboxed retry, credential stores unreadable', () => {
    const settings = claudeSandboxSettings(on, { home, platform: 'linux', exists: () => true })!;
    expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false });
    expect(settings.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining([`${home}/.ssh`, `${home}/.aws`, `${home}/.cezar`, `${home}/.config/gh`]));
    // Only the agent's TMPDIR and the `cez` binary are carved back out of cezar's home.
    expect(settings.sandbox.filesystem.allowRead).toEqual([`${home}/.cezar/tmp`, `${home}/.cezar/bin`, `${home}/.cezar/versions`]);
    expect(settings.permissions.deny).toEqual(expect.arrayContaining([`Read(/${home}/.ssh/**)`, `Read(/${home}/.netrc)`]));
    expect(settings.sandbox.network.allowedDomains).toEqual(expect.arrayContaining(['registry.npmjs.org', '127.0.0.1', 'api.github.com']));
    expect(settings.sandbox.network.allowedDomains).not.toContain('example.com');
  });

  it('turns off with CEZ_AGENT_SANDBOX=0 and on native Windows', () => {
    expect(claudeSandboxSettings({ CEZ_AGENT_SANDBOX: '0' }, { platform: 'linux' })).toBeUndefined();
    expect(claudeSandboxSettings({ CEZ_AGENT_SANDBOX: 'false' }, { platform: 'linux' })).toBeUndefined();
    expect(claudeSandboxSettings({}, { platform: 'win32' })).toBeUndefined();
  });

  it('extends domains, deny-read and writable paths from env; grants only existing caches', () => {
    const settings = claudeSandboxSettings(
      { CEZ_AGENT_SANDBOX_DOMAINS: 'api.example.com, *.corp.test', CEZ_AGENT_SANDBOX_DENY_READ: '/srv/secrets', CEZ_AGENT_SANDBOX_ALLOW_WRITE: '/data/out' },
      { home, platform: 'darwin', exists: (p) => p === `${home}/.npm/_cacache` || p === '/data/out' },
    )!;
    expect(settings.sandbox.network.allowedDomains).toEqual(expect.arrayContaining(['api.example.com', '*.corp.test']));
    expect(settings.sandbox.filesystem.denyRead).toContain('/srv/secrets');
    expect(settings.sandbox.filesystem.allowWrite).toEqual([`${home}/.npm/_cacache`, '/data/out']);
  });

  it('CEZ_AGENT_GH_TOKEN=1 also lifts the ~/.config/gh read denial', () => {
    const settings = claudeSandboxSettings({ CEZ_AGENT_GH_TOKEN: '1' }, { home, platform: 'linux' })!;
    expect(settings.sandbox.filesystem.denyRead).not.toContain(`${home}/.config/gh`);
    expect(settings.sandbox.filesystem.denyRead).toContain(`${home}/.ssh`);
  });

  it('rides inline in --settings, merged with the hook and the excluded commands', () => {
    const args = buildClaudeArgs({ ...spec, bashHookCommand: 'h', sandboxExcludedCommands: ['cez-manager *'] }, on);
    expect(args.filter((arg) => arg === '--settings')).toHaveLength(1);
    const settings = settingsOf(args);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('h');
    expect(settings.sandbox).toMatchObject({ enabled: true, excludedCommands: ['cez-manager *'] });
    expect(settings.permissions.deny.length).toBeGreaterThan(0);
    expect(settingsOf(buildClaudeArgs(spec, on)).sandbox.enabled).toBe(true);
    expect(buildClaudeArgs(spec, { CEZ_AGENT_SANDBOX: '0' })).not.toContain('--settings');
  });

  it('merges into a fence file without dropping the caller deny rules', () => {
    const merged = withClaudeSandbox({ permissions: { deny: ['Bash'] }, hooks: { x: 1 } }, on) as Record<string, any>;
    expect(merged.hooks).toEqual({ x: 1 });
    expect(merged.permissions.deny[0]).toBe('Bash');
    expect(merged.permissions.deny.length).toBeGreaterThan(1);
    expect(merged.sandbox.enabled).toBe(true);
    expect(withClaudeSandbox({ a: 1 }, { CEZ_AGENT_SANDBOX: '0' })).toEqual({ a: 1 });
  });
});

describe('the run\'s own files outside the worktree stay writable under the sandbox', () => {
  const env: NodeJS.ProcessEnv = { HOME: '/home/dev' };
  const runEnv = { CEZ_HANDOFF_FILE: '/repo/.ai/cezar/runs/r1.handoff.md', CEZ_TODOS_FILE: '/repo/.ai/cezar/todos.json', CEZ_TASK_ID: 'r1' };

  it('grants the handoff and todos files, on macOS even before they exist', () => {
    const settings = claudeSandboxSettings(env, { platform: 'darwin', exists: () => false, runFiles: [runEnv.CEZ_HANDOFF_FILE, runEnv.CEZ_TODOS_FILE] })!;
    expect(settings.sandbox.filesystem.allowWrite).toEqual([runEnv.CEZ_HANDOFF_FILE, runEnv.CEZ_TODOS_FILE]);
    const linux = claudeSandboxSettings(env, { platform: 'linux', exists: (p) => p === runEnv.CEZ_TODOS_FILE, runFiles: [runEnv.CEZ_HANDOFF_FILE, runEnv.CEZ_TODOS_FILE] })!;
    expect(linux.sandbox.filesystem.allowWrite).toEqual([runEnv.CEZ_TODOS_FILE]);
  });

  it('grants only the run\'s own temp dir, never the host one', () => {
    const settings = claudeSandboxSettings(env, { home: '/home/dev', platform: 'darwin', exists: (p) => p !== '/gone', tempDirs: ['/repo/tmp/r1', '/gone', '/repo/tmp/r1'] })!;
    const temps = settings.sandbox.filesystem.allowWrite.filter((p) => !p.startsWith('/home/dev/'));
    expect(temps).toEqual(['/repo/tmp/r1']);
    const byDefault = claudeSandboxSettings(env, { home: '/home/dev', platform: 'darwin', exists: () => true })!;
    expect(byDefault.sandbox.filesystem.allowWrite.every((p) => p.startsWith('/home/dev/'))).toBe(true);
  });

  it('denies the Read tool all of cezar home, entries created later included; CEZ_HOME is honored', () => {
    const settings = claudeSandboxSettings({ CEZ_HOME: '/srv/cez' }, { home: '/home/dev', platform: 'linux', exists: () => true })!;
    expect(settings.sandbox.filesystem.denyRead).toContain('/srv/cez');
    expect(settings.sandbox.filesystem.allowRead).toEqual(['/srv/cez/tmp', '/srv/cez/bin', '/srv/cez/versions']);
    expect(settings.permissions.deny).toContain('Read(//srv/cez/**)');
  });

  it('buildClaudeArgs passes them from the run env', () => {
    const args = buildClaudeArgs({ userPrompt: 'go', cwd: '/repo/wt', allowedTools: ['Bash'], env: runEnv }, env);
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!) as { sandbox: { filesystem: { allowWrite: string[] } } };
    if (process.platform === 'darwin') expect(settings.sandbox.filesystem.allowWrite).toEqual(expect.arrayContaining([runEnv.CEZ_HANDOFF_FILE]));
    expect(settings.sandbox.filesystem.allowWrite).not.toContain('/repo/.ai/cezar');
  });
});

describe('secret files (.env, keys) and the run\'s own roots under the sandbox', () => {
  const home = '/home/dev';

  it('denies secret-file patterns under home and the project, to Bash and the Read tool alike', () => {
    const settings = claudeSandboxSettings({}, { home, platform: 'linux', exists: () => true, projectRoots: ['/srv/repo'] })!;
    const deny = settings.sandbox.filesystem.denyRead;
    for (const root of [home, '/srv/repo']) {
      expect(deny).toEqual(expect.arrayContaining([`${root}/**/.env`, `${root}/.env`, `${root}/**/.env.local`, `${root}/**/*.pem`, `${root}/**/id_ed25519`]));
      expect(settings.permissions.deny).toContain(`Read(/${root}/**/.env)`);
    }
    expect(SECRET_FILE_PATTERNS).not.toContain('.env.example');
    expect(SECRET_FILE_PATTERNS).not.toContain('.env.test');
  });

  it('keeps the run\'s own roots readable inside an extra denied dir; the Read tool is denied every other entry', () => {
    const tree: Record<string, string[]> = {
      '/home/dev/code': ['app', 'other', 'cezar'],
      '/home/dev/code/app': ['src', '.env', '.git', '.ai'],
      '/home/dev/code/app/.ai': ['cezar'],
      '/home/dev/code/app/.ai/cezar': ['worktrees', 'automations.json'],
      '/home/dev/code/app/.ai/cezar/worktrees': ['r1', 'r2'],
    };
    const settings = claudeSandboxSettings({ CEZ_AGENT_SANDBOX_DENY_READ: '/home/dev/code,/srv/other' }, {
      home, platform: 'linux', exists: () => true,
      readableRoots: ['/home/dev/code/app/.ai/cezar/worktrees/r1', '/home/dev/code/app/.git', '/elsewhere/runs'],
      binRoots: ['/home/dev/code/cezar'],
      listDir: (p) => tree[p] ?? [],
    })!;
    expect(settings.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining(['/home/dev/code', '/srv/other']));
    // Shell carve-outs: only roots inside a denied dir, the cez install included.
    expect(settings.sandbox.filesystem.allowRead).toEqual(expect.arrayContaining(['/home/dev/code/app/.ai/cezar/worktrees/r1', '/home/dev/code/app/.git', '/home/dev/code/cezar']));
    expect(settings.sandbox.filesystem.allowRead).not.toContain('/elsewhere/runs');
    const deny = settings.permissions.deny;
    expect(deny).not.toContain('Read(//home/dev/code/**)');
    for (const denied of ['other', 'cezar', 'app/src', 'app/.env', 'app/.ai/cezar/automations.json', 'app/.ai/cezar/worktrees/r2']) {
      expect(deny).toContain(`Read(//home/dev/code/${denied}/**)`);
    }
    for (const kept of ['app/.git', 'app/.ai/cezar/worktrees/r1']) expect(deny).not.toContain(`Read(//home/dev/code/${kept}/**)`);
    expect(deny).toContain('Read(//srv/other/**)');
  });

  it('never carves out a root that holds home or a credential store, and fails closed on a listing error', () => {
    const settings = claudeSandboxSettings({ CEZ_AGENT_SANDBOX_DENY_READ: '/' }, {
      home, platform: 'linux', exists: () => true,
      readableRoots: [home, '/home', '/srv/repo'],
      listDir: () => { throw new Error('EACCES'); },
    })!;
    expect(settings.sandbox.filesystem.allowRead).not.toContain(home);
    expect(settings.sandbox.filesystem.allowRead).not.toContain('/home');
    expect(settings.sandbox.filesystem.allowRead).toContain('/srv/repo');
    expect(settings.permissions.deny).toContain('Read(///**)');
  });

  it('derives the project, its .git and the cez install from the run', () => {
    expect(projectRootOf('/home/dev/code/app/.ai/cezar/worktrees/r1')).toBe('/home/dev/code/app');
    expect(projectRootOf('/home/dev/code/app')).toBe('/home/dev/code/app');
    const exists = (p: string) => ['/home/dev/code/cezar/package.json', '/home/dev/code/cezar/packages/cezar/package.json'].includes(p);
    expect(cezInstallRoot('/home/dev/code/cezar/packages/cezar/dist/index.js', home, exists)).toBe('/home/dev/code/cezar');
    expect(cezInstallRoot(undefined, home, exists)).toBeUndefined();
    const run = sandboxRunOf({ cwd: '/home/dev/code/app/.ai/cezar/worktrees/r1', env: { TMPDIR: '/t/r1' }, additionalDirectories: ['/home/dev/code/app/.ai/cezar/runs'] }, {});
    expect(run.projectRoots).toEqual(['/home/dev/code/app']);
    expect(run.readableRoots).toEqual(expect.arrayContaining(['/home/dev/code/app/.ai/cezar/worktrees/r1', '/home/dev/code/app/.git', '/home/dev/code/app/.ai/cezar/runs']));
    expect(run.tempDirs).toEqual(['/t/r1']);
  });
});

describe('file-writing tools are scoped to the run under the sandbox', () => {
  const spec = {
    cwd: '/repo/.ai/cezar/worktrees/r1',
    additionalDirectories: ['/repo/.ai/cezar/runs'],
    artifactsWriteDir: '/repo/.ai/cezar/artifacts/r1',
    env: { TMPDIR: '/t/r1', CEZ_HANDOFF_FILE: '/repo/.ai/cezar/runs/r1.handoff.md', CEZ_TODOS_FILE: '/repo/.ai/cezar/todos.json' },
  };

  it('replaces bare Write/Edit grants with rules over the run\'s own paths only', () => {
    const scoped = scopeFileWrites(['Read', 'Edit', 'Write', 'Bash'], spec);
    expect(scoped).toEqual(['Read', 'Bash',
      'Edit(//repo/.ai/cezar/worktrees/r1/**)', 'Edit(//repo/.ai/cezar/runs/**)', 'Edit(//repo/.ai/cezar/artifacts/r1/**)', 'Edit(//t/r1/**)',
      'Edit(//repo/.ai/cezar/runs/r1.handoff.md)', 'Edit(//repo/.ai/cezar/todos.json)']);
    expect(scoped.join(',')).not.toContain('Edit(//repo/**)');
  });

  it('leaves a grant without file-writing tools alone and drops inexpressible paths', () => {
    expect(scopeFileWrites(['Read', 'Bash(git status:*)'], spec)).toEqual(['Read', 'Bash(git status:*)']);
    expect(scopeFileWrites(['Write'], { cwd: '/odd(dir)', env: {} })).toEqual([]);
  });

  it('applies only while the sandbox is on', () => {
    const args = (env: NodeJS.ProcessEnv) => {
      const a = buildClaudeArgs({ userPrompt: 'go', allowedTools: ['Read', 'Write'], ...spec }, env);
      return a[a.indexOf('--allowedTools') + 1]!;
    };
    expect(args({ HOME: '/home/dev' })).toContain('Edit(//repo/.ai/cezar/worktrees/r1/**)');
    expect(args({ HOME: '/home/dev' }).split(',')).not.toContain('Write');
    expect(args({ CEZ_AGENT_SANDBOX: '0' }).split(',')).toContain('Write');
  });
});

describe('runs that live under cezar\'s home stay usable (review checkouts, manager workdirs)', () => {
  const home = '/home/dev';
  it('carves a PR checkout out of cezar home for Bash and the Read tool, keeping secrets denied', () => {
    const tree: Record<string, string[]> = {
      '/home/dev/.cezar': ['pr-checkouts', 'secrets', 'tmp', 'config.json'],
      '/home/dev/.cezar/pr-checkouts': ['r1', 'r2'],
    };
    const settings = claudeSandboxSettings({}, {
      home, platform: 'linux', exists: () => true,
      readableRoots: ['/repo/wt', '/home/dev/.cezar/pr-checkouts/r1'],
      listDir: (p) => tree[p] ?? [],
    })!;
    expect(settings.sandbox.filesystem.allowRead).toContain('/home/dev/.cezar/pr-checkouts/r1');
    expect(settings.sandbox.filesystem.allowRead).not.toContain('/repo/wt'); // not inside a denied dir
    const deny = settings.permissions.deny;
    expect(deny).not.toContain('Read(//home/dev/.cezar/**)');
    expect(deny).not.toContain('Read(//home/dev/.cezar/pr-checkouts/r1/**)');
    for (const denied of ['pr-checkouts/r2', 'secrets', 'tmp', 'config.json', 'relay', 'agent-homes']) {
      expect(deny).toContain(`Read(//home/dev/.cezar/${denied}/**)`);
    }
  });

  it('never caches PATH dirs or executables as writable', () => {
    const settings = claudeSandboxSettings({}, { home, platform: 'linux', exists: () => true })!;
    const writes = settings.sandbox.filesystem.allowWrite;
    for (const risky of ['/home/dev/Library/pnpm', '/home/dev/.yarn', '/home/dev/.npm', '/home/dev/.cache', '/home/dev/Library/Caches']) {
      expect(writes).not.toContain(risky);
    }
    expect(writes).toContain('/home/dev/.npm/_cacache');
  });

  it('reads CEZ_AGENT_GH_TOKEN exactly like agent-env does', () => {
    const denied = (v: string) => claudeSandboxSettings({ CEZ_AGENT_GH_TOKEN: v }, { home, platform: 'linux', exists: () => true })!
      .sandbox.filesystem.denyRead.includes('/home/dev/.config/gh');
    expect(denied('1')).toBe(false);
    expect(denied('no')).toBe(false); // truthy in agent-env too: tokens forwarded, so gh config readable
    expect(denied('0')).toBe(true);
    expect(denied('false')).toBe(true);
  });
});

describe('a Bash-free run needs no OS sandbox', () => {
  it('keeps the read-deny rules but requires no sandbox when Bash is not granted', () => {
    const noBash = buildClaudeArgs({ userPrompt: 'go', cwd: '/repo', allowedTools: ['Read', 'Grep'] }, { HOME: '/home/dev' });
    const settings = JSON.parse(noBash[noBash.indexOf('--settings') + 1]!) as Record<string, unknown>;
    expect(settings).not.toHaveProperty('sandbox');
    expect(JSON.stringify(settings)).toContain('/.ssh/**)');
    const withBash = buildClaudeArgs({ userPrompt: 'go', cwd: '/repo', allowedTools: ['Read', 'Bash'] }, { HOME: '/home/dev' });
    expect(JSON.parse(withBash[withBash.indexOf('--settings') + 1]!)).toHaveProperty('sandbox.failIfUnavailable', true);
  });
});
