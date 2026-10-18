# Thallium Iodide

A Node.js/TypeScript server and browser dashboard for an explicit list of **Podman containers**. Initial entries cover Halogen Flash Server, Hindsight, Prometheus, Grafana, and node_exporter.

## Run

Requires Node.js 22+, npm, and Podman available on PATH. Run as the **same user who owns the containers**; rootless and rootful Podman have separate inventories. No Podman socket or Docker daemon is needed.

```sh
npm install
cp config.example.json config.json
# Edit config.json with an absolute scriptsDirectory, container names, and script paths.
npm run build
npm start
```

Open **http://127.0.0.1:4310**. The server binds to `0.0.0.0` (all IPv4 interfaces); access it remotely at `http://<server-ip>:4310`. Host validation accepts localhost and the machine's IPv4 addresses, not arbitrary DNS names. Configuration is loaded at startup; restart the server after edits. Use `CONFIG_PATH=/absolute/path/config.json npm start` for a different configuration file.

`npm run dev` builds the browser assets and watches server sources. Rebuild/restart it after browser-source edits.

## Local installation (Linux/macOS)

The launcher and installation/configuration directories use the `thallium-iodide` name. Older installations are not migrated automatically; seed the new installation with your existing configuration using `--config` (see below).

Install for your current user, without sudo, from this checkout:

```sh
npm ci
npm run install:local
# Edit ~/.config/thallium-iodide/config.json before starting.
~/.local/bin/thallium-iodide
```

Requires Node.js 22+ and npm. Runtime tools (Podman, and `ps`/`tail` for their respective views) must remain on PATH. Run as the user who owns your containers. The installer builds the app, copies its runtime and browser assets to `~/.local/share/thallium-iodide`, installs production dependencies there using the lockfile, and creates an executable launcher at `~/.local/bin/thallium-iodide`. It does not install Node.js or Podman, start the application, or configure an autostart service. Dependency installation may need network access.

Configuration lives at `${XDG_CONFIG_HOME:-$HOME/.config}/thallium-iodide/config.json`. On first install it is copied from `config.example.json`, **not** your checkout's `config.json`. To seed it with your existing configuration instead:

```sh
npm run install:local -- --config /absolute/path/config.json
```

Existing installed configuration is never overwritten. Review container names and the absolute `scriptsDirectory` before launching. Lifecycle scripts remain in your configured directory; the installer does not copy or execute them.

Add `~/.local/bin` to your shell's PATH to launch with `thallium-iodide`. The launcher works from any working directory and honors `CONFIG_PATH` overrides. Node.js must remain at the path used during installation; reinstall after moving or replacing a version-manager installation. Open **http://127.0.0.1:4310** (or your configured port) and use Ctrl+C to stop.

To update, stop the app, update the checkout, run `npm ci` and `npm run install:local` again, then relaunch. Build or dependency-install failures leave the previous installation intact.

To uninstall, stop the app first, then use either command:

```sh
npm run uninstall:local
# Or, without needing the source checkout:
~/.local/bin/thallium-iodide --uninstall
```

Uninstall removes only the owned application directory and unchanged launcher. It **preserves configuration**, lifecycle scripts, monitored files, and all managed containers. Delete the configuration directory manually if you no longer want those settings. Repeated uninstall is harmless; unrelated paths or edited launchers are rejected rather than deleted.

For a custom install prefix, use an absolute path with both commands:

```sh
npm run install:local -- --prefix /absolute/path/prefix
npm run uninstall:local -- --prefix /absolute/path/prefix
```

The prefix changes the `bin` and `share` locations, not the configuration location. Installation directories and their parents must be writable only by trusted users. Do not run install/update/uninstall operations concurrently.

## Build processes

Set `monitoredProcesses` in `config.json` to executable names to monitor:

```json
"monitoredProcesses": ["ctest", "cmake", "gcc", "g++"]
```

Names match executable basenames, not command arguments; paths and wildcard patterns are not accepted. `gcc` and `g++` also match versioned and target-prefixed compilers. Omitted lists default to the four names above; `[]` disables process monitoring. Restart the server after changes.

The **Processes** tab shows matching running host processes, with PID, full command, local start time, elapsed runtime, CPU percentage, resident memory in MiB, and memory percentage. It refreshes at `pollIntervalMs` and supports the dashboard's Refresh button. CPU is the lifetime average reported by `ps`, not an instantaneous sample; 100% represents one core. Memory is RSS, not virtual memory.

This read-only view requires Linux/procps `ps` on PATH and shows processes visible to the server, not Podman container inventory. Scan failures appear in the tab instead of being shown as an empty process list.

## GitHub issues

The **GitHub** tab is a read-only list of open issues (not pull requests) in repositories owned by the configured account. It includes private repositories and forks accessible to the server's GitHub login and excludes archived repositories and repositories owned by organizations or other users. Anyone who can access this dashboard can read matching private issues: restrict network access accordingly.

Install the GitHub CLI (`gh`) on the server's PATH and run `gh auth login` as the user running this application. The login must have access to the intended repositories (including private repository access). No credentials are sent to the browser; missing authentication or permissions are reported in the tab. GitHub can only return repositories visible to that login; hidden repositories cannot be detected.

Optional configuration (these are the defaults):

```json
"github": {
  "owner": "ajare",
  "labels": ["assignee:halogen/qwen-3.8-flash-next"]
}
```

`labels` matches **any** configured label, case-insensitively, and deduplicates issues matching multiple labels. An empty list disables GitHub fetching. Restart after configuration edits. Descriptions are displayed as plain text, never HTML or embedded images. Repository and text filters apply locally; newest updates come first. Expand an issue for its full description or open it on GitHub for comments.

The tab loads on first selection and checks every 60 seconds while visible. Both Refresh buttons use the same shared server cache; concurrent requests are deduplicated and manual refresh cannot bypass the 60-second cooldown or GitHub rate-limit cooldowns. No background GitHub polling occurs without a visible client. Repository and issue lists are paginated rather than using GitHub Search's 1,000-result-limited endpoint. Safety limits of 100 pages per list and two minutes per refresh are reported as incomplete results, never as an empty successful list. A failed/incomplete refresh preserves previous results with a stale indicator and timestamp; if only partial results were obtained initially, they are explicitly marked partial.

## JSON status API

`GET /api/status` returns a read-only combined snapshot:

```sh
curl http://127.0.0.1:4310/api/status
```

- `generatedAt`: response generation time (ISO 8601); individual sections are not sampled atomically.
- `containers`: configured containers with `id`, `name`, `containerName`, `status` (lifecycle state), `liveness`, `readiness`, `checkedAt`, `detail`, and `configurationErrors`. Checks use the latest monitor poll, not a new probe per request; `checkedAt` is null before the first check.
- `podmanError` and `pollIntervalMs`: container inventory error (or null) and configured polling interval.
- `files`: `monitoredPaths`, a freshly scanned `files` list (`id`, `path`, `modifiedAt`, `modifiedMs`), and `errors`.
- `processes`: `monitoredProcesses`, a freshly scanned `processes` list (`pid`, `command`, `startedAt`, `elapsedSeconds`, `cpuPercent`, `memoryPercent`, `memoryBytes`), and `error`. Memory bytes are RSS; CPU is the lifetime average from `ps`. On scan failure the list is null, not an empty successful result.
- `github`: the same cached snapshot as `/api/github`, including `issues` (tickets), owner/labels, timestamps, and `stale`, `partial`, and `error` indicators. Requests share its refresh and rate-limit cooldowns.

The endpoint returns HTTP 200 even when a source is unavailable: inspect each section's errors and freshness indicators. It includes no control token or file contents. Existing Host/origin protections apply, but no authentication is required; anyone who can reach the dashboard can read this status, including matching private GitHub issues.

## Container terminals

The **Terminal** button in the container table opens a new terminal window on the host running `podman exec -it <container> <shell>` for that row. The server prefers `bash` inside the container when available, falling back to `sh`. The button is enabled only while the container is running.

The window is opened with the first terminal emulator found on PATH, in this order: `xdg-terminal-exec` (the freedesktop default-terminal launcher), `ptyxis`, `gnome-terminal`, `konsole`, `xterm`. The server must run in a graphical session (with `DISPLAY` or `WAYLAND_DISPLAY` set) for the window to appear; otherwise the button reports an error. The endpoint is guarded by the same per-session control token as lifecycle actions.

## Configuration

`scriptsDirectory` must be an **absolute filesystem path**, for example `"/home/wm/scripts"`. Relative paths and `"~/scripts"` are rejected; use the full home-directory path. Individual `startScript`/`stopScript` paths remain relative to that directory. Each resource needs a stable unique ID and an exact, unique Podman container name. Configure only containers you intend to manage.

Example **resource entry** (merge into the configuration's `resources` array):

```json
{
  "id": "prometheus",
  "name": "Prometheus",
  "containerName": "your-actual-prometheus-container-name",
  "uiUrl": "http://127.0.0.1:9090/",
  "startScript": "prometheus/start.sh",
  "stopScript": "prometheus/stop.sh",
  "liveness": {
    "url": "http://127.0.0.1:9090/-/healthy",
    "timeoutMs": 3000
  },
  "readiness": {
    "url": "http://127.0.0.1:9090/-/ready",
    "timeoutMs": 3000
  }
}
```

Optional `uiUrl` supplies the dashboard's **UI** link, opening in a new tab. Use an HTTP(S) URL reachable from your browser; omit it or set it to `null` for services without a UI. The example UI URLs for Hindsight, Prometheus, and Grafana use typical local ports; adjust them to your deployment.

Those URLs are examples, not verified port assignments. Optional `liveness` and `readiness` probes are checked independently and accept `{ "url": "http://...", "timeoutMs": 3000 }` (not a bare URL string). Liveness checks whether the service responds; readiness checks whether it can serve traffic. Probe URLs must be reachable from the server host (usually via a published container port). Any HTTP 2xx response means healthy; errors, non-2xx responses, redirects, and timeouts mean unhealthy. No probe means **unknown**, never healthy. Stopped/missing containers are not probed. Neither probe triggers automatic recovery. Halogen uses `/health` for both because it does not expose separate endpoints.

The example configuration intentionally leaves Prometheus and Grafana names unset because they were not present in the inspected user inventory. All script paths and probe URLs are unset: provisioning scripts and endpoint details must come from you. Missing names disable actions. Missing containers need a valid executable creation script (`startScript`); invalid or escaped creation scripts are explained in the dashboard. Existing containers can be started, stopped, and restarted without scripts. `stopScript` remains accepted for configuration compatibility but is not used by ordinary controls.

Optional top-level settings:

| Setting | Default | Range |
| --- | --- | --- |
| `port` | 4310 | 1–65535 |
| `pollIntervalMs` | 5000 | 1000–60000 |
| `actionTimeoutMs` | 120000 | 1000–600000 |

Do not use your model generation endpoint as a readiness probe: choose an inexpensive endpoint that indicates application readiness.

## Lifecycle script contract

Supply your own executable scripts under `scriptsDirectory`, then reference them by relative path. This project does **not** generate or execute provisioning scripts during setup.

- Use a shebang (for example `#!/bin/sh`) and mark the file executable with `chmod +x`.
- Scripts are executed directly, with **no arguments**, no shell command interpolation, stdin closed, working directory set to `scriptsDirectory`, and the server user's inherited environment.
- `startScript` is a **creation/provisioning script**, not a script for starting existing containers. Create the exact configured name and return; do not remain attached indefinitely. The script may launch it directly, or leave it stopped for the application to start.
- `stopScript` describes a destructive/kill script. It is retained in the configuration but **never executed by ordinary Stop or Restart**. There is no destruction control in this dashboard.
- Exit zero for successful execution; return nonzero on failure. Write diagnostic output to stdout/stderr.
- No interactive prompts, password requests, or automatic privilege escalation. Do not depend on interactive-shell PATH setup; prefer explicit paths where needed.
- Script paths, including symlinks, must resolve to executable files **inside** the configured scripts directory.

**Start** is allowed only for missing/stopped containers:

- Existing stopped container: execute `podman start <configured-name>` directly; do not invoke the creation script.
- Missing container: execute `startScript`. If it exits nonzero, try `podman start <configured-name>` once: creation may have failed because that name already exists. Both outputs are retained. If fallback also fails, the action fails.
- Successful creation: recheck the named container. Start it through Podman if it exists but is stopped; if it is already running, do nothing further. If it remains missing or its state cannot be verified, report failure.
- A timed-out creation script does **not** trigger fallback. Inspect its effects before retrying.

**Stop** uses `podman stop <configured-name>`, retaining the container definition. **Restart** uses Podman stop then start, aborting if stop fails; it never runs creation or destruction scripts. Stop and Restart require browser confirmation and explicit server-side confirmation. Restart is available for running or stopped containers without scripts. Actions are locked per resource; different resources may be operated independently.

The action timeout covers the entire command sequence, not 120 seconds per command. Timed-out commands and their process groups are killed. Output is bounded to the most recent 64 KiB of characters; truncation is indicated. Output is shown after each command finishes, not streamed live. State and readiness are rechecked after execution: **successful commands do not prove that the application is ready**. Apart from the explicit creation-failure fallback, failures are never automatically retried.

Shutting down Thallium Iodide terminates in-flight command process groups. It does not stop your containers. A killed/timed-out script may already have changed container state: inspect the dashboard before retrying.

## Logs

The dashboard has a **Containers** tab and one **logs tab per configured container**. Table **View logs** buttons select the matching tab. Only the active logs tab streams; switching tabs closes its follower. Each tab retains bounded output while inactive. Returning to it or selecting **Reconnect** fetches a fresh recent tail and resumes live output. Arrow keys, Home, and End navigate the tab bar.

The log viewer runs `podman logs --tail 200 --follow --timestamps <configured-name>`. It combines stdout and stderr, streams to the browser via server-sent events, and stops the follower when the viewer disconnects. A missing container has no container logs. Permission or runtime errors appear in the viewer.

The browser retains at most 1000 lines / 128 KiB of characters, supports auto-scroll and clearing the view, and does not render log content as HTML. There are at most five simultaneous server log followers. Socket backpressure pauses the follower until output drains; viewers stalled for 30 seconds are disconnected rather than buffered indefinitely. Log connections do not automatically reconnect: use **Reconnect** or reselect the logs tab to retry. Host file tails are also available through the **Files** tab (see below).

## Monitored files

Add an optional top-level `monitoredPaths` list to `config.json` (defaults to `[]`):

```json
"monitoredPaths": [
  "/home/wm/logs",
  "/var/log/my-service.log",
  "/home/wm/services/**/*.log",
  "/home/wm/jobs/job-*/output?.txt"
]
```

Use absolute paths; `~` is not expanded. Literal and glob-matched directories are scanned recursively. Glob patterns support `*`, `?`, character classes and recursive `**`; only regular files are listed, not directories or symlink entries. Overlapping entries are deduplicated. Missing paths are harmless; scan errors are displayed above the table. Keep patterns narrow to avoid scanning large directory trees.

File-output tabs pretty-print `.json` documents and individual `.jsonl` records with two-space indentation. Split stream chunks are accumulated before formatting; invalid, incomplete, or tail-truncated JSON remains visible as raw text. Raw and displayed output remain bounded to 1000 lines / 128 KiB of characters.

The **Files** table rescans at the dashboard polling interval and shows full paths and local last-modified dates, newest first. Check **Tail** to open a file-output tab; uncheck it or use **Stop tail** to remove that tab. Like container logs, only the active output tab follows live; inactive tabs retain their output and resume with a fresh tail when selected.

File streaming requires `tail` on PATH and uses `tail -n <lines> -F -- <matched-path>` without a shell. File viewers share a line-count selector between Raw and Timeline (50, 100, 200, 500 or 1000 source lines; default 200). Changing it reconnects with the selected history; both views retain a rolling tail and Timeline updates live. The file logs API accepts `?lines=<1–1000>` (default 200). The browser's 128 KiB buffer and formatted-output limit still apply. This follows appended output and retries after file rotation or recreation. Output uses the same bounded viewer, auto-scroll, clear and reconnect controls as container logs, and shares the five-follower server limit. The server authorizes each new stream against a fresh scan of configured paths; arbitrary client-supplied paths are not accepted. Configuration and monitored directories must be trusted: path matching is not a sandbox against concurrent filesystem changes. Avoid configuring sensitive files; any local user who can access the dashboard can read matched files.

Restart after config edits, then rebuild browser assets if updating from an older version.

## Safety and limitations

- Lifecycle scripts are **trusted local code** with all privileges of the server user. Keep the configuration, scripts directory, scripts, and their parent directories writable only by trusted users. Path validation is not a sandbox and cannot protect against an attacker who can modify these files during execution.
- Host and origin validation, an action token, JSON-only action requests, and a restrictive content security policy protect the browser control surface against rebinding and cross-origin requests. Container names are passed as command arguments, never shell strings.
- The server listens on all IPv4 interfaces without user authentication. Anyone who can reach its port can access status, logs, monitored files, and controls. Restrict access with a firewall to trusted clients; do not expose it publicly or through port forwarding or a reverse proxy without adding authentication and revisiting its protections.
- If Podman is unavailable, inventory state becomes **unknown**, not missing, and lifecycle actions are disabled.
- Paused/removing/restarting containers retain their runtime state; lifecycle buttons are disabled for transitional states. Dependencies, pods, automatic recovery, arbitrary commands, host-service management, and remote control are outside the initial scope.
- Action history is in memory (last action per resource); it resets when the server restarts. Closing a browser does not cancel a lifecycle action.

## Development checks

```sh
npm run check
npm test
npm run build
```

Tests cover configuration and symlink validation, script-free Podman control of existing containers, missing-container creation and fallback, confirmation, non-destructive restart sequencing and failure short-circuiting, per-resource locks, process timeouts and bounded output, readiness checks, API safeguards, and live-log disconnect cleanup. Tests do not create, stop, or restart real containers.

See [CONTEXT.md](CONTEXT.md) for the domain glossary.
