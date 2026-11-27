# Telemetry

**Removed in this fork.** cezar sends no usage data and no error reports — not from the server,
the cockpit, the CLI or the desktop shell. There is no endpoint, no install id and no consent to
give: the cockpit never asks, Settings → Privacy shows it as off, and `cezar telemetry` says it is
removed. See `packages/cezar/src/telemetry.ts` and `packages/desktop/src-tauri/src/telemetry.rs`.

cezar's other outbound calls (update checks, star count, remote skills, artifact CDNs, Claude
Code's own non-essential traffic) are off by default too — see `CEZ_OFFLINE` in `.env.example`.
