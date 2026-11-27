# Remote access — macOS + ngrok

Expose a cezar cockpit running on your **Mac** to the internet through an
[ngrok](https://ngrok.com) tunnel — no ports to open, no TLS to manage.

**How it's wired:** cezar runs locally on the Mac. **ngrok** is the public
front (in place of nginx+certbot): it provides the public HTTPS URL, and its
built-in `--basic-auth` is the identity gate (the htpasswd equivalent). A
**launchd** agent keeps the tunnel up and restarts it on login (the systemd
equivalent).

```
  internet ──HTTPS──► ngrok tunnel ──►  cezar (localhost:4321)
                      --basic-auth              launchd agent
```

---

## Prerequisites

- macOS with [Homebrew](https://brew.sh).
- An [ngrok account](https://dashboard.ngrok.com) and its **authtoken**.
- A **reserved domain** on ngrok (recommended, so the URL is stable) — optional;
  without one you get an ephemeral URL.
- At least one logged-in agent CLI — `claude`, `codex`, or OpenCode (experimental).

---

## Install

```bash
npx cezar-run server-install --platform macosx-ngrok
```

### What each step does

| Step | What happens |
|------|--------------|
| **Dependencies** | Detects the agent CLIs / `gh` / `git`; offers to `brew install` the missing ones. |
| **ngrok tunnel** | Installs ngrok if needed, saves your **authtoken** (passed via the environment, never on a command line `ps` could read), and writes the tunnel definition — cockpit port, **basic auth** (username + password, at least 12 characters) and, if provided, your **reserved domain** — to `~/Library/Application Support/cezar/ngrok-tunnel.yml` (`0600`). The launchd agent runs `ngrok start cezar` with that file, so the password never appears on a command line `ps` could read. |
| **Autostart** | Installs a **launchd** agent (`~/Library/LaunchAgents/ai.cezar.ngrok.plist`) with `RunAtLoad` + `KeepAlive` so the authenticated tunnel comes back automatically. |
| **Verify** | Confirms the ngrok basic-auth gate is active. |

The **username + password** you set become the ngrok `--basic-auth`
credentials — what you type in the browser to reach the cockpit over the public
HTTPS URL.

---

## Updating / redeploying

Reload the public tunnel with the standardized command:

```bash
npx cezar-run server-deploy --platform macosx-ngrok
```

`server-deploy` restarts the ngrok launchd agent and re-verifies the basic-auth
gate. On macOS cezar itself runs locally — restart it the way you launched it;
`server-deploy` reloads the tunnel that fronts it.

To change the setup itself, the installer is idempotent:

```bash
npx cezar-run server-install --platform macosx-ngrok --reconfigure autostart
npx cezar-run server-install --platform macosx-ngrok --reinstall   # redo everything
```

---

## Uninstall

```bash
npx cezar-run server-uninstall --platform macosx-ngrok
```

Removes the launchd plist and the tunnel config cezar **owns**. Shared tools
(ngrok, the agent CLIs, `gh`) are *listed* for manual removal, not deleted.

---

← Back to [Remote access overview](./README.md)
