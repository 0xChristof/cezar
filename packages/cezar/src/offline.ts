/**
 * Offline by default (this fork): cezar itself makes no outbound call. The agents still reach
 * their model providers (that is how they work) and, through their sandbox allowlist, package
 * registries and GitHub; `CEZ_OFFLINE=0` restores upstream's behaviour. Off here:
 *   - telemetry (`CEZ_TELEMETRY=0`, also when consented in the cockpit);
 *   - the npm update checks for cezar itself and for the agent CLIs;
 *   - the GitHub star count (`CEZ_NO_BANNER=1`);
 *   - cloning/fetching remote skills repos (open-mercato/skills by default) and their auto-update;
 *   - CDN scripts, styles and fonts in agent-made HTML artifacts;
 *   - Claude Code's own non-essential traffic (its telemetry, error reports, auto-updater) via
 *     CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, which the agent env forwards.
 * The phone relay is left to its own switch: it connects only after you pair a phone.
 */
export function isOffline(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CEZ_OFFLINE?.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** Seed the existing per-feature switches from the offline default; an explicit value wins. */
export function applyOfflineDefaults(env: NodeJS.ProcessEnv = process.env): void {
  if (!isOffline(env)) return;
  env.CEZ_TELEMETRY ??= '0';
  env.CEZ_AGENT_VERSION_CHECK ??= '0';
  env.CEZ_SKILLS_AUTO_UPDATE ??= '0';
  env.CEZ_NO_BANNER ??= '1';
  env.CEZ_ARTIFACTS_CDN ??= '0';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ??= '1';
}
