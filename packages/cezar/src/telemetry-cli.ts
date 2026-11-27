/**
 * `cezar telemetry` — telemetry is removed in this fork (telemetry.ts): every subcommand says so.
 * Kept so an old habit or script gets a clear answer instead of "unknown command".
 */

export interface TelemetryCommandIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

const defaultIo: TelemetryCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export async function runTelemetryCommand(args: string[], io: TelemetryCommandIo = defaultIo): Promise<number> {
  const [sub = 'status'] = args;
  if (!['status', 'enable', 'disable', 'inspect'].includes(sub)) {
    io.error('usage: cezar telemetry [status] — telemetry is removed in this build');
    return 1;
  }
  io.log('telemetry: removed in this build — cezar sends no usage data or error reports, and there is nothing to enable.');
  return 0;
}
