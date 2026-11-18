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

* **[x] Phase 0 — Foundation:** `@rnctl/sdk` and `@rnctl/plugin-devices` scaffolded.
* **[ ] Phase 1 — Core MVP (Next Up):**
  1. `@rnctl/core`: Implement `EventBus`, `ProcessSupervisor`, `PluginLoader`, and local WebSocket/HTTP JSON-RPC daemon (`~/.rnctl/daemon.sock` or localhost port).
  2. `@rnctl/plugin-metro`: Start/stop Metro (`--reset-cache`), run `adb reverse tcp:8081 tcp:8081`, trigger `run-ios` / `run-android`, reload JS (`r`), open Dev Menu (`d`).
  3. `@rnctl/plugin-logs`: Multiplex `stdout`/`stderr` from Metro, `adb logcat`, and `xcrun simctl spawn booted log stream` into unified `LogEntry` events.
  4. `@rnctl/tui` & `rnctl` CLI: Interactive Ink terminal dashboard + CLI commands (`rnctl`, `rnctl devices`, `rnctl logs`).
* **[ ] Phase 2 — Daily Accelerators:** Multi-device broadcast commands (simultaneous reload/deep-link/dark-mode), GPS/network presets, and `@rnctl/plugin-doctor` (`rnctl nuke` cache cleaner).
* **[ ] Phase 3 — Deep Inspection:** Zero-SDK network request inspector, AsyncStorage/MMKV viewer, Hermes crash/FPS profiler.
* **[ ] Phase 4 — AI & Ecosystem:** Built-in MCP server (`@rnctl/plugin-mcp`) exposing live logs and device actions to AI coding agents, plus `rnctl plugin create <name>`.

---

## 6. Agent Workflow & Verification Commands

Before concluding any task, AI agents working in this repository must verify:
1. `pnpm typecheck` passes with zero errors across all packages.
2. `pnpm build` succeeds cleanly via Turborepo.
3. Any new RPC method includes a `zod` `inputSchema`.
4. Any new long-running CLI process uses `ctx.processes.spawn` with a corresponding cleanup path.
