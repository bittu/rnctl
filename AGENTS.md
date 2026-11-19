# AGENTS.md — `rnctl` Architecture, Conventions & AI Agent Guide

> **Repository:** `github.com/bittu/rnctl` | **npm Scope:** `@rnctl/*` | **CLI Binary:** `rnctl`  
> **Purpose:** Single-window mission control for React Native & Expo developers—launching iOS simulators and Android emulators, supervising Metro, and streaming unified native + JS logs without Xcode, Android Studio, or multiple terminal tabs.

---

## 1. Core Architectural Philosophy (Read First)

`rnctl` uses a **Microkernel + Plugin-First Architecture**. Every user-facing feature—including built-in capabilities—must be implemented as an isolated plugin communicating with `@rnctl/core` over a typed Event Bus and JSON-RPC contract.

* **Never hardcode feature logic into `@rnctl/core`, `@rnctl/tui`, or `@rnctl/web`.**
* **Dual-Headed Client Model:** A single lightweight Node.js background daemon (`@rnctl/core`) manages child processes (`simctl`, `adb`, `emulator`, `metro`) and exposes state over local IPC/WebSockets. Both the Terminal UI (`@rnctl/tui`) and Local Web Dashboard (`@rnctl/web`) are thin, stateless clients of this daemon.
* **Zero-Config Default:** Running `rnctl` in any React Native or Expo directory must work out of the box with zero configuration files required.

---

## 2. Monorepo Layout & Package Responsibilities

```text
rnctl/
├── AGENTS.md                     # You are here (universal agent instructions)
├── CLAUDE.md                     # Symlink or pointer to AGENTS.md
├── package.json                  # Root workspace scripts (pnpm + Turborepo)
├── pnpm-workspace.yaml           # Workspace definitions
├── turbo.json                    # Build pipeline & caching
├── tsconfig.base.json            # Strict TypeScript base config
└── packages/
    ├── sdk/                      # @rnctl/sdk — Public types, definePlugin(), Zod schemas
    ├── core/                     # @rnctl/core — Daemon, ProcessSupervisor, EventBus, PluginLoader, RPC server
    ├── cli/                      # rnctl (unscoped) — Entry binary, Commander router, daemon lifecycle
    ├── tui/                      # @rnctl/tui — Ink (React for CLI) terminal dashboard
    ├── web/                      # @rnctl/web — Vite + React + Tailwind local browser dashboard
    ├── plugin-devices/           # @rnctl/plugin-devices — iOS simctl & Android adb/avd lifecycle
    ├── plugin-metro/             # @rnctl/plugin-metro — Metro bundler & app build/launch runner
    ├── plugin-logs/              # @rnctl/plugin-logs — Unified Metro + logcat + simctl log stream
    └── plugin-doctor/            # @rnctl/plugin-doctor — Environment diagnostics & cache nuke
```

---

## 3. Coding Conventions & Strict Rules

### TypeScript & Module Standards
* **ESM Only:** All packages use `"type": "module"`, `"module": "NodeNext"`, and `"moduleResolution": "NodeNext"`. Always include `.js` extensions on relative imports if required by NodeNext resolution, or bundle cleanly via `tsup`.
* **Strict Type Safety:** `"strict": true` is enforced across all packages. Never use `any`; use `unknown` paired with `zod` runtime validation at RPC and plugin boundaries.
* **Public npm Publishing:** Every publishable package must include `"publishConfig": { "access": "public" }` in its `package.json`.

### Process Management Rules (Critical)
* **No Direct `child_process` Calls in Plugins:** Plugins must **never** import `node:child_process` directly. Always use `ctx.processes.spawn()` or `ctx.processes.exec()` provided by `@rnctl/sdk`.
* **Orphan Prevention:** Every spawned long-running child process (Metro, `adb logcat`, `xcrun simctl log stream`, emulators) must be registered with `ProcessSupervisor` using a deterministic `id` so the daemon guarantees clean `SIGTERM`/`SIGKILL` cleanup on exit.
* **Cross-Platform Guards:** Always check `process.platform === 'darwin'` before invoking `xcrun` or `open -a Simulator`. Android (`adb`, `emulator`) and Metro commands must work across macOS, Linux, and Windows.

### Naming Conventions
* **Official Built-in Plugins:** `@rnctl/plugin-<feature>` (e.g., `@rnctl/plugin-devices`).
* **Community Plugins:** `rnctl-plugin-<feature>` (auto-discovered from `node_modules` or `rnctl.config.ts`).
* **RPC Methods:** Dot-namespaced by plugin domain (`devices.list`, `devices.boot`, `metro.start`, `logs.clear`).
* **Event Bus Topics:** Colon-namespaced (`device:list-updated`, `device:booted`, `log:entry`, `metro:ready`).

---

## 4. Plugin Contract (`@rnctl/sdk`)

Every feature plugin must export a `definePlugin(...)` object:

```typescript
import { definePlugin } from '@rnctl/sdk';
import { z } from 'zod';

export default definePlugin({
  name: '@rnctl/plugin-example',
  version: '0.1.0',
  description: 'Short description of capability',
  async setup(ctx) {
    // 1. Subscribe to core events
    ctx.bus.on('device:booted', ({ deviceId, platform }) => {
      ctx.logger.info(`Device booted: ${deviceId} (${platform})`);
    });

    // 2. Register JSON-RPC methods for TUI & Web UI
    ctx.registerRpc('example.ping', {
      inputSchema: z.object({ echo: z.string() }),
      handler: async ({ echo }) => ({ reply: echo }),
    });

    // 3. Register CLI subcommands (`rnctl <command>`)
    ctx.registerCommand({
      name: 'ping',
      description: 'Test plugin command',
      action: async (_args, pluginCtx) => {
        pluginCtx.logger.info('Pong from plugin!');
      },
    });
  },
  async teardown() {
    // Clean up timers, file watchers, or sockets
  },
});
```

---

## 5. Phased Implementation Roadmap (Current Progress)

* **[x] Phase 0 — Foundation:** `@rnctl/sdk`, all workspace packages, root configs, CI and npm publishing scaffolded.
* **[x] Phase 1 — Core MVP:**
  1. `@rnctl/core`: `EventBus`, `ProcessSupervisor` (with stdin `write()`), `PluginLoader`, community plugin discovery, and a local WebSocket JSON-RPC daemon (`~/.rnctl/daemon.json`).
  2. `@rnctl/plugin-metro`: Start/stop Metro (`--reset-cache`), reload JS (`r`) and Dev Menu (`d`) via stdin.
  3. `@rnctl/plugin-logs`: Ring-buffer of `process:stdout`/`process:stderr` events exposed via `logs.list` / `logs.clear`.
  4. `@rnctl/plugin-devices`, `@rnctl/plugin-doctor`: real simctl/adb discovery and environment probes.
  5. `@rnctl/tui` & `rnctl` CLI: OpenTUI dashboard with fixed viewport, scrollboxes, mouse support and tabbed screens; CLI commands (`rnctl`, `rnctl devices`, `rnctl metro`, `rnctl nuke`, `rnctl web`, `rnctl up`).
* **[ ] Phase 1.5 — Interaction & UX (user-requested, see section 7):** side menu, per-device action menus, per-source log tabs, project/package.json awareness, startup logo and non-RN warning.
* **[~] Phase 2 — Daily Accelerators:**
  1. `[x]` `@rnctl/plugin-broadcast`: reload, deep-link and dark-mode across all booted devices, exposed over RPC and `rnctl broadcast`.
  2. `[x]` `@rnctl/plugin-doctor`: safe `nuke` with whitelisted targets, preview/dry-run, explicit confirmation and reclaimed-space stats.
  3. `[ ]` `@rnctl/plugin-simulator-tweaks`: GPS/network presets, status-bar overrides and mock push notifications.
* **[~] Phase 3 — Deep Inspection:**
  1. `[x]` `@rnctl/plugin-network`: zero-SDK network capture via Metro's CDP inspector proxy (RN 0.83+), with a Network tab in the TUI.
  2. `[ ]` `@rnctl/plugin-storage`: AsyncStorage/MMKV/SQLite viewer.
  3. `[ ]` `@rnctl/plugin-perf`: Hermes crash symbolication and FPS profiling.
* **[ ] Phase 4 — AI & Ecosystem:** Built-in MCP server (`@rnctl/plugin-mcp`) exposing live logs and device actions to AI coding agents, plus `rnctl plugin create <name>`.

---

## 6. Agent Workflow & Verification Commands

Before concluding any task, AI agents working in this repository must verify:
1. `pnpm typecheck` passes with zero errors across all packages.
2. `pnpm build` succeeds cleanly via Turborepo.
3. Any new RPC method includes a `zod` `inputSchema`.
4. Any new long-running CLI process uses `ctx.processes.spawn` with a corresponding cleanup path.

---

## 7. Interaction & UX Direction (user-requested)

These are product requirements gathered from hands-on UI reviews. Implement as plugins/RPC methods; never hardcode feature logic into `@rnctl/core` or the TUI.

* **Visual language:** dark theme only, palette inspired by OpenCode's TUI (deep slate backgrounds, cyan/teal accents, restrained green/amber/red status colors). Startup shows an ASCII art `rnctl` logo with the caption `react native mission control`.
* **Navigation:** replace the top tab bar with a persistent side menu. Screens switch on selection; shared state (logs, selection, health) survives switching. The active screen owns its scroll region; the header and side menu never scroll off-screen.
* **Devices:** booted devices sort to the top. iOS and Android are separate submenus under Devices. Selecting a device opens an action menu rather than a static list: start/boot if stopped, install app, run app, stop/shutdown if running, plus device-specific actions where supported.
* **Logs:** logs are per-source and each source opens in its own tab, like OpenCode opens a new session tab. Sources: Metro, Android (app-specific logcat), iOS (app-specific `simctl` log stream), JS console, and network. Offer a source only when relevant (e.g. Android logs only when an Android app is running).
* **Project awareness:** detect the current project on startup. If it is not a React Native/Expo project, show a prominent warning that rnctl works best in an RN project. Populate run/install actions from scripts in the project's `package.json`.
* **Suggested RPC namespaces:** `project.info` (isReactNative, scripts, package name), `devices.boot|shutdown|installApp|runApp`, `logs.sources` and `logs.attach(source)`.

Phase 1.5 completes these; per-source network/console inspection builds on Phase 3.
