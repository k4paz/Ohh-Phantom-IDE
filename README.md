# PHANTOM

[![CI](https://github.com/k4paz/Ohh-Phantom-IDE/actions/workflows/ci.yml/badge.svg)](https://github.com/k4paz/Ohh-Phantom-IDE/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

PHANTOM is a desktop IDE that works like a hacker workstation. It runs as a small operating system of floating windows: editors, terminals, monitors, network tools, Git, databases, a debugger and security scanners. You arrange them however you like across four virtual workspaces.

Everything is real: shells run in a real PTY, monitors read live kernel data, Git uses your Git binary, the debugger speaks the Chrome DevTools Protocol to Node, and the audits run on your project locally. The Agents hub uses the Copilot SDK and Codex SDK with saved provider sign-ins, plus Claude Code in a project terminal. PHANTOM does not request or store provider API keys and removes API-key environment variables before agent runs. Sign in with each provider's subscription account; PHANTOM relies on the provider's saved login and does not inspect its cached credential type.

## Install & run

You need **Node.js 20.19+ or 22.12+** and **git**. These are optional but recommended: `ripgrep` (fast search) and an OpenSSH client (`ssh`, which Windows 10/11 already includes).

```bash
npm install      # Electron, Monaco, xterm.js, node-pty…  (no git-hosted packages, no rebuild step)
npm start        # launch PHANTOM
npm run dev      # launch with DevTools detached
npm test         # backend, operational-transformation, and collaboration tests
npm run test:backend   # exercise every backend service against your real OS (plain Node)
npm run test:collab    # OT convergence and encrypted live-session tests
npm run dist     # build installers with electron-builder (fetched on demand via npx)
```

Terminals use **node-pty 1.1**, which is built on N-API. On **Windows and macOS** it installs from prebuilt binaries that work in Electron without a rebuild. On **Linux** it compiles once with the usual toolchain (`build-essential`, `python3`). If it can't install, PHANTOM still runs: Linux and macOS fall back to the system `script` utility, which gives a real PTY that can't resize live, and Windows falls back to plain pipes. The taskbar shows `pty:native` or `pty:bridge`.

If a previous `npm install` failed partway, delete `node_modules` and `package-lock.json` first.

For the intended look, install a programming font such as **JetBrains Mono**, Fira Code or Cascadia Code. PHANTOM picks the first one it finds.

## The window system

| Action | How |
|---|---|
| Move / raise | drag the title bar · click anywhere in a window |
| Resize | drag any edge or corner (live size readout) |
| Snap | drag to an edge (half), a corner (quarter) or the top (maximize). Hold **Alt** to disable snapping and magnets |
| Magnetic alignment | windows snap to each other's edges (cyan guides). Set the threshold in Settings |
| Keyboard snap | **Ctrl+Alt+←/→/↑/↓** (halves → quarters → maximize/minimize) |
| Always on top | pin button or title right-click (amber frame) |
| Minimize / maximize / close | title buttons · double-click title · middle-click title or taskbar to close |
| Multiple instances | every tool can be opened many times (Shift+click a dock icon, or "Duplicate window") |
| Workspaces | **Ctrl+Alt+1–4** switch · **Ctrl+Alt+Shift+1–4** move the focused window |
| Arrange | **Ctrl+Alt+T** tile · cascade · **Ctrl+Alt+D** show desktop · **Alt+`** cycle |
| Layouts | **Ctrl+Shift+L** saves every window on all workspaces, including open files, terminal folders and tool state. Restore from the LAYOUT menu, or use a preset (Dev station, Recon/ops, Debug bay, API lab, Security sweep, Architecture) |

The session (project, windows, positions, states) is saved automatically and restored on launch.

## Running programs (F5, like Visual Studio)

| Key | Action |
|---|---|
| **F5** | Start: debugs JavaScript files in the Debugger; any other language runs in the **Run** terminal. While debugging, F5 continues or pauses |
| **Ctrl+F5** | Start without debugging |
| **Shift+F5** | Stop (ends the debug session, or sends Ctrl+C to the Run terminal) |
| **Ctrl+Shift+F5** | Restart |
| **F10 / F11 / Shift+F11** | Step over / into / out (while paused) |

F5 saves every modified file first, then runs the file open in the active editor. It picks the command from the extension: Python, Node, TypeScript (via `tsx`), Go (`go run`, or `go run .` inside a module), Rust (`cargo run` inside a crate, otherwise `rustc`), C/C++ (`gcc`/`g++` then the binary), C# (`dotnet run --project` with the nearest `.csproj`, otherwise `dotnet run file.cs`), F#, Java, Kotlin, Ruby, PHP, Lua, Perl, R, Julia, Swift, Dart, Zig, Elixir, Haskell, Bash, PowerShell and batch. HTML opens in your browser. The compiler or interpreter has to be installed and on your PATH.

Programs run in a single reusable **Run** terminal, so input prompts (`input()`, `Console.ReadLine()`…) work, and the exit code is printed at the end. To make F5 always run the same thing, like a Visual Studio startup project, use **RUN → Set project run command…** (for example `npm run dev` or `dotnet run`). It's saved per project. The ▶ button in each editor's tab bar does the same, and right-clicking it shows the other options.

## Live collaboration (pair programming)

Two or more people (up to 9) can edit the same file at the same time, each seeing the others' cursors and selections in their own colour with a name tag.

1. **Host:** open **Live Session** from the dock (the people icon) or the palette, then click **START SESSION**. PHANTOM shows a session code (`XXXX-XXXX-XXXX-XXXX`) and your network addresses. **COPY INVITE** copies both, ready to send.
2. **Join:** in your own PHANTOM, open Live Session and enter the host's address and the code. You can paste the whole invite into the code box. Then click **JOIN**.
3. **Share files:** whoever owns a file shares it: **SHARE CURRENT FILE**, right-click a tab → *Share in live session*, or right-click it in the explorer. Everyone else clicks **OPEN** and edits along.
4. **Save:** the file stays on its owner's disk. Ctrl+S from anyone saves it there. Chat lives in the Live Session window.

How it works:
- **Sync:** operational transformation (`renderer/js/shared/ot.js`, the same family of algorithm as Google Docs). The host orders all edits, so everyone converges to identical text even when typing in the same spot at the same time.
- **Connection:** the computers connect directly over TCP (default port 7457). There's no cloud and no account.
- **Encryption:** the session code is never sent. Both sides derive an AES-256-GCM key from it with scrypt, so all traffic, including your code, is encrypted and authenticated. A connection with the wrong code can't read or send anything; it's rejected and logged to the event stream, and an address is locked out after 5 failed attempts. Each new session gets a fresh 80-bit code.
- **Network:** on the same network it works straight away. Allow PHANTOM through the firewall the first time you host; Windows asks automatically. Over the internet, use a VPN such as Tailscale or ZeroTier (simplest), or forward the port on the host's router.
- **Ending:** if the host ends the session, guests keep their open shared files as local copies they can *Save As*.

## Tools

- **Projects**: open folders, create project directories, and revisit or remove recent projects from one window.
- **Window shortcuts**: Ctrl+1-9 focuses the matching window in the current taskbar list; Ctrl+Shift+1-4 switches workspaces; Ctrl+Tab / Ctrl+Shift+Tab cycles windows; Ctrl+Shift+D duplicates the focused window; Ctrl+Shift+R closes every other window.
- **Desktop viewport**: pan the wallpaper and app windows together without changing their scale; reset the viewport position from the desktop control.
- **Agent Flow recovery**: unfinished runs save per-project checkpoints in local app storage, outside the project repository. Resume continues from the latest completed step; interrupted agent or build steps may be retried.
- **Agents**: in-app Copilot SDK and Codex SDK chats use saved provider sign-ins; API-key environment variables are stripped. Use the Subscriptions dashboard to create isolated local sign-in profiles for Copilot, Codex, and Claude Code, switch accounts, and review PHANTOM-tracked request/character totals plus provider-reported token totals where available. Copilot quota is fetched via GitHub's `copilot_internal/user` endpoint using the active `gh` CLI account, which may differ from a saved Copilot CLI profile; this endpoint is internal and may change. Copilot device-code sign-in is the default. Copilot asks before permissioned tool actions, and Codex runs read-only with on-request approval. Claude Code runs in a project terminal under the selected account profile. Copilot project MCP configuration can be enabled per chat with explicit opt-in; MCP actions still request approval. Codex and Claude Code use their native CLI configuration and approval flows.
- **Agent Flow**: build per-project workflows saved to `.phantom/agent-flow.json`, alongside the existing reusable presets. Apply built-in workflow templates or save, reuse, and delete your own presets. Right-click empty space in the Explorer and choose **Open Agent Flow Here** to add that folder as task context. Left-drag nodes to move them, left-drag empty canvas to marquee-select nodes and wires, Ctrl/Cmd-click to toggle individual nodes or wires, middle- or right-drag to pan, and use the mouse wheel to zoom. Ctrl/Cmd+Z undoes and Ctrl/Cmd+Shift+Z (or Ctrl/Cmd+Y) redoes workflow edits; text fields retain their native undo behavior. Press Delete/Backspace to remove selected agent nodes and/or connections; built-in workflow nodes stay in place. Drag output ports onto input ports to connect agents; connect agents, the compiler, and/or the orchestrator to Final Response to collect their results. Select one node to edit its task and flow function; multi-select agent nodes to edit shared provider, mode, and permission settings. Choose a Simple Agent Role preset (Planner, FrontEnd, Backend, Debugger, Orchestrator, BrainStormer, or SecurityEngineer), or switch to Advanced Agent Role to edit custom instructions and reasoning effort. Interactive, Plan, and Autopilot modes are available per node; Plan is read-only, and Autopilot is limited to the active project while protected actions remain gated. Copilot permissions include Manual, Assisted read approvals, and Project-scoped file access; Project-scoped auto-approves reads and writes inside the active project while shell, network, sandbox-bypass, managed, and out-of-project requests remain approval-gated. Unrestricted Allow All is not available. Codex nodes can optionally use cached or live web search. The orchestrator can pause for user clarification, delegate scoped assignments to worker nodes, run detected or selected build/test commands, send implementation and compiler findings to Plan-mode reviewers, and dispatch targeted worker revisions. Responses without a valid action block get one format-retry before the workflow stops with an error. The maximum number of revision rounds is configurable on the orchestrator; the final response reports the latest review and verification results.
- **Live Session**: host or join encrypted peer-to-peer sessions, edit shared files concurrently with live cursors, and chat. The file remains on its owner's computer; guests request saves from the owner.
- **Editor** (Monaco): tabs, split groups (Ctrl+\\, drag tabs between groups or windows), IntelliSense for JS/TS/JSON/CSS/HTML, word-based completion everywhere, shared models across all editor windows, external-change detection with conflict warning, breakpoints (gutter/F9), optional autosave.
- **Terminal** (xterm.js + node-pty): real shells, 256-colour/truecolor, scrollback search (Ctrl+Shift+F), clickable links, copy/paste (Ctrl+Shift+C/V). The working directory is tracked so layouts reopen terminals in the right folder.
- **Explorer**: lazy tree, git status colours, create/rename/duplicate/trash (to the system trash), open-with menus, keyboard navigation.
- **Search**: project-wide search powered by ripgrep (built-in fallback). Supports regex, case and whole-word options, include/exclude globs, and replace-all with confirmation.
- **Git**: stage, unstage, discard, commit/amend, inline diffs, side-by-side Monaco diff, ASCII graph log with commit inspection, branches/checkout, fetch, pull (ff-only), push (auto-sets upstream), stash.
- **Debugger**: Node.js via `--inspect-brk` and CDP. Breakpoints, continue/pause/step over/into/out (F5/F10/F11), call stack, lazily-expanded scopes, and evaluation in the selected frame.
- **Test Runner**: auto-detects jest, vitest, mocha, node:test, pytest, unittest, cargo and go. Shows a live pass/fail/skip count, failure list and run history, with an optional watch mode.
- **Build Monitor**: detects npm/pnpm/yarn scripts, Makefile targets, cargo, go, python and docker tasks. Runs several at once with timing, error/warning counts and stop/rerun.
- **API Tester**: all common methods, params↔URL sync, headers, JSON/text/form bodies, bearer/basic auth, `{{env}}` variables, history, saved requests, copy as cURL. Requests run from the main process, so CORS doesn't apply.
- **Database**: SQLite (native `node:sqlite`, `sql.js` fallback), PostgreSQL and MySQL/MariaDB. Schema browser, Monaco SQL editor with table/column completion, result grid, CSV/JSON copy. Destructive statements ask for confirmation, and passwords are never written to disk.
- **SSH**: profiles (port, identity file, ProxyJump, L/R/D forwards) plus import from `~/.ssh/config`. Sessions run the system OpenSSH client in a PTY, so your keys, agent and known_hosts apply.
- **System Monitor**: total and per-core CPU, memory/swap, disk I/O, network throughput, filesystems, load, uptime, temperature, top processes.
- **Network**: per-interface traffic graphs, every socket with its owning process, listening ports (one click to open them in the API tester or probe them), interfaces.
- **Processes**: live CPU% (computed from /proc deltas on Linux), sortable, filterable, tree view, details (exe, cwd, fds, I/O), signals with confirmation.
- **Event Stream**: one live feed of file changes, Git state, process spawn/exit, ports opening and closing, PTY sessions, task results, debugger, security and resource-pressure events.
- **Logs**: tail -f any file (handles rotation) or PHANTOM's own log, with level colouring, filter/regex and follow mode.
- **Security Audit**: npm/pnpm audit, pip-audit, cargo audit and govulncheck when installed; a committed-secret scanner (AWS, GitHub, Slack, Stripe, private keys, JWTs, DB URLs…, with masked previews); and config checks for env files not ignored or committed, curl-pipe-sh scripts, unpinned or git dependencies, missing lockfiles, root containers, world-writable files and stray key material. Results are graded A–F.
- **Architecture**: a force-directed import graph for JS/TS (including tsconfig path aliases), Python, Go, Rust and CSS. Directory clustering, cycle detection (Tarjan SCC), most-imported/most-dependent lists, optional external packages. Double-click a module to open it.
- **Markdown / JSON viewers**: live markdown preview (sanitised with DOMPurify, follows unsaved edits) and a collapsible JSON tree with path copy, filtering and JSON Lines support.

Global keys: **F5** run · **F12** developer tools · **Ctrl+W** close focused window (**Ctrl+Shift+W** also works) · **Ctrl+Alt+Shift+Arrow** snap the focused window · **Ctrl+Shift+P** command palette · **Ctrl+P** go to file (`file:line`) · **Ctrl+O** open folder · **Ctrl+`** terminal · **Ctrl+Shift+F/E/G** search/explorer/git · **Ctrl+,** settings · **F11** fullscreen (Windows enters hard kiosk; **Alt+Tab** cycles PHANTOM windows; **Ctrl+Shift+F12** exits).

Themes: PHANTOM, FSOCIETY, E CORP, AMBER CRT, DARK ARMY, ICEBREAKER, GHOST. You can also set a custom accent, glow intensity, scanlines and grid.

## Architecture

```
main/
  main.js          Electron bootstrap: app:// protocol, CSP, hardened session, IPC wiring
  preload.js       sandboxed contextBridge: window.phantom.invoke / on (channel allowlist)
  registry.js      builds the backend core and loads services
  util.js          exec/walk/which helpers (no Electron imports)
  services/*.js    one module per domain: fs, watch, pty, sys, proc, net, git, search, http,
                   db, ssh, audit, tasks, debug, arch, logs, events, collab, store, app, agents
renderer/
  index.html, css/ base · window manager · tool styles
  js/core/         api (bridge, shared pollers, telemetry), wm (window manager), shell (chrome,
                   palette, keys, layouts), docs (Monaco models, breakpoints), collab (live sessions),
                   settings (themes), project, ui (modals/menus/toasts), graph (canvas plots), dom
  js/apps/*.js     one module per tool: { id, title, icon, size, create(win, state) → instance }
  js/shared/ot.js  operational-transformation engine shared by the host and renderer
tools/
  backend-test.js  integration tests for every service (runs in plain Node)
  ot-test.js       randomised convergence tests for the collaboration engine
  collab-test.js   host + 2 guests over real encrypted TCP, concurrent editing
  devbridge.js     dev harness: serves the renderer over HTTP with the real backend (for UI testing)
```

Adding a tool means writing one file in `renderer/js/apps/` and registering it in `main.js` (and optionally the dock). A tool's `instance` can implement `serialize`, `apply`, `onResize`, `onShow`, `onFocus`, `canClose` and `destroy`. The window manager handles persistence, instances and workspaces.

**Security model.** The renderer runs with `contextIsolation`, `sandbox: true` and `nodeIntegration: false`. It is served only from the `app://` scheme, with path-traversal checks, a strict CSP (no remote scripts, no eval), navigation blocked and new windows denied. IPC handlers accept calls only from PHANTOM's own origin and validate their inputs. Git refs and SSH hosts/users are validated against option injection. Commands use `execFile` without a shell; the exception is user-authored build tasks, which run in a shell just as they would in a terminal. Process signals refuse PHANTOM itself and PID ≤ 1. Port probes are limited to loopback. Live Session traffic is encrypted and authenticated with AES-256-GCM using a key derived from the session code; the session code itself is not sent to peers. Hosting opens the configured TCP port on the network interfaces, so share invites only with intended collaborators. Deletes go to the system trash. Database passwords and API auth values are never persisted.

**Performance.** All monitors share pollers, so one backend sample serves every window. Polling pauses for hidden or minimised windows and background workspaces. Backend snapshots are cached and de-duplicated. On Linux the file watcher skips `node_modules`, `.git` and build output. Terminal output is batched, and Monaco models are shared and reference-counted.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and contribution guidelines. PHANTOM is released under the [MIT License](LICENSE).

For a sensitive security report, use GitHub Security Advisories rather than opening a public issue.
