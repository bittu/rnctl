# `rnctl` — Product & Technical Architecture Blueprint

> **Tagline:** One mission control for React Native. Boot devices, run Metro, stream unified native + JS logs, inspect networks, and extend everything via plugins—zero Xcode or Android Studio required.

---

## 1. Product Vision & Positioning

### The Problem
React Native developers constantly juggle 4–6 terminal tabs (Metro, iOS build, Android build, `adb logcat`, `simctl log stream`) alongside heavy GUIs (Xcode and Android Studio) just to boot devices, read native crash logs, clear caches, and debug builds.

### The Solution (`rnctl`)
**`rnctl`** is a free, open-source, editor-agnostic **microkernel developer tool** that unifies the entire React Native local workflow into a single **Terminal UI (TUI)** and **Local Web Dashboard**.

Unlike monolithic tools, **`rnctl` is 100% plugin-driven**. Every built-in capability—device management, Metro orchestration, log streaming, network inspection, and AI MCP integration—is implemented as an isolated plugin using the public `@rnctl/sdk`.

### Competitive Advantage

| Capability | Radon IDE (Commercial) | `lazymobile` (Open-Source TUI) | **`rnctl` (Your Product)** |
| :--- | :--- | :--- | :--- |
| **Pricing & License** | Paid commercial license | Free / Open-Source | **100% Free & Open-Source (MIT)** |
| **Editor Lock-in** | VS Code / Cursor only | Terminal only (editor-agnostic) | **Editor-agnostic (TUI + Web UI)** |
| **Architecture** | Monolithic extension | Monolithic Go binary | **Microkernel + First-Class Plugin SDK** |
| **Device Lifecycle** | Boot & run existing | Boot, wipe, create, cold boot | **Full lifecycle + Multi-device sync** |
| **Log Correlation** | JS console focus | Raw native + JS log follow | **Merged Native + JS timeline + stack folding** |
| **Native Health & Clean** | Basic rebuild | None | **One-click Doctor & Cache/DerivedData Nuke** |
| **Zero-SDK Inspection** | Paid extension feature | None | **Built-in Network, Storage & Hermes Profiler** |
| **AI Agent Integration** | Paid MCP server | None | **Free local MCP Server for Claude/Cursor/Windsurf** |

---

## 2. Tech Stack

* **Runtime & Language:** Node.js (v20+) / Bun + TypeScript (Strict Mode)
* **Monorepo Tooling:** pnpm Workspaces + Turborepo
* **Background Daemon & IPC:** Fastify + WebSockets (`ws`) + Unix Domain Sockets / Localhost HTTP
* **Terminal UI (TUI):** `ink` (React for CLIs) + `ink-ui`
* **Local Web Dashboard:** React 19 + Vite + Tailwind CSS + Lucide Icons
* **Process & CLI Execution:** `execa` + `node-pty` (for interactive terminal passthrough)
* **Schema & Config Validation:** `zod`
* **Testing:** Vitest

---

## 3. System Architecture (Microkernel + Dual-Head UI)

`rnctl` separates background process management from the user interface so your simulators, Metro bundler, and log streams keep running even if you close the TUI or browser tab.

```text
+-------------------------------------------------------------------+
|                        USER INTERFACES                            |
|   [ Terminal UI (Ink) ]               [ Local Web Dashboard ]     |
+-------------+-----------------------------------+-----------------+
              | (WebSocket / Local JSON-RPC)      |
              v                                   v
+-------------------------------------------------------------------+
|                     @rnctl/core (Background Daemon)               |
|                                                                   |
|  +-----------------------+   +---------------------------------+  |
|  |   Typed Event Bus     |   |      Process Supervisor         |  |
|  | (pub/sub across all   |   | (manages child PIDs, graceful   |  |
|  |  plugins & UIs)       |   |  shutdown, port conflict guard) |  |
|  +-----------+-----------+   +----------------+----------------+  |
|              |                                |                   |
|  +-----------v--------------------------------v----------------+  |
|  |                    Plugin Registry & Loader                 |  |
|  +---+--------------------+--------------------+---------------+  |
|      |                    |                    |                  |
|      v                    v                    v                  |
| [Built-in Plugins]  [npm Plugins]        [Local Workspace Plugins]|
| @rnctl/plugin-*     rnctl-plugin-*       ./.rnctl/plugins/*.ts    |
+-------------------------------------------------------------------+
              |                    |                    |
              v                    v                    v
       [ xcrun simctl ]     [ adb / emulator ]   [ Metro / Hermes ]
```

### Core Subsystems
1. **Background Daemon (`@rnctl/core`):** Runs quietly in `~/.rnctl/daemon.sock`. Prevents orphan Metro processes on port `8081` and broadcasts state updates to all connected UIs.
2. **Typed Event Bus:** Central nervous system where plugins publish events (e.g., `device:booted`, `log:entry`, `metro:error`) and subscribe to react to them.
3. **Process Supervisor:** Wraps `execa` with automatic cleanup hooks (`SIGINT`/`SIGTERM`), restart policies, and stdout/stderr stream multiplexers.
4. **Dual-Head Renderers:** Both the TUI (`rnctl`) and Web UI (`rnctl web`) are pure clients subscribing to daemon state and rendering plugin-contributed panels.

---

## 4. Conventions & Project Standards

### Naming & Package Conventions
* **CLI Binary:** `rnctl` (with short alias `rnc`)
* **Core Scope:** `@rnctl/*` (free on npm for public open-source packages)
* **Official Plugins:** `@rnctl/plugin-<name>` (e.g., `@rnctl/plugin-devices`)
* **Community Plugins:** `rnctl-plugin-<name>` (auto-discovered from `node_modules`)
* **Local Project Plugins:** `./.rnctl/plugins/<name>.ts`
* **User Configuration:** `rnctl.config.ts` in project root

### Repository Structure
```text
rnctl/
├── packages/
│   ├── cli/                  # CLI entry point (commander/citty) & TUI shell
│   ├── core/                 # Daemon, Event Bus, Process Supervisor, Plugin Loader
│   ├── sdk/                  # Public @rnctl/sdk types, helpers & test harness
│   ├── web/                  # Local React + Vite web dashboard
│   └── plugins/              # All built-in features live here as standalone plugins
│       ├── plugin-devices/
│       ├── plugin-metro/
│       ├── plugin-logs/
│       ├── plugin-broadcast/
│       ├── plugin-doctor/
│       ├── plugin-network/
│       ├── plugin-storage/
│       └── plugin-mcp/
├── rnctl.config.ts
├── pnpm-workspace.yaml
└── turbo.json
```

### CLI Ergonomics
* `rnctl` — Launches the interactive TUI dashboard.
* `rnctl web` — Opens the local browser dashboard.
* `rnctl up` — Boots default simulator/emulator, starts Metro, and runs the app.
* `rnctl logs --level error` — Streams filtered unified logs directly to stdout.
* `rnctl nuke` — Runs interactive cache, `node_modules`, Gradle, and DerivedData cleanup.
* `rnctl plugin create <name>` — Scaffolds a new plugin with TypeScript boilerplate.

---

## 5. Plugin Architecture & `@rnctl/sdk`

Every feature in `rnctl` adheres to the exact same `RnctlPlugin` contract. Third-party developers have access to the exact same APIs as core features.

### Plugin Lifecycle & Discovery
1. **Discovery:** On startup, `@rnctl/core` loads plugins in three tiers:
   * Built-in core plugins (`@rnctl/plugin-*`)
   * Installed npm packages matching `rnctl-plugin-*` or listed in `rnctl.config.ts`
   * Local project scripts inside `./.rnctl/plugins/`
2. **Validation:** Each plugin's manifest and config options are validated with `zod`.
3. **Registration:** Plugins register CLI commands, background workers, event listeners, TUI panels, Web UI tabs, and MCP tools.

### Example Plugin Implementation (`@rnctl/sdk`)
```typescript
import { definePlugin } from '@rnctl/sdk';
import { z } from 'zod';

export default definePlugin({
  id: 'rnctl-plugin-deeplinks',
  name: 'Deep Link Launcher',
  version: '1.0.0',
  configSchema: z.object({
    scheme: z.string().default('myapp'),
    presets: z.array(z.string()).default(['home', 'profile/settings']),
  }),

  async setup(ctx) {
    // 1. Register a CLI subcommand (`rnctl deeplink open profile/settings`)
    ctx.cli.command('deeplink open <path>', async ({ path }) => {
      const url = `${ctx.config.scheme}://${path}`;
      await ctx.bus.emit('broadcast:deeplink', { url });
      ctx.logger.info(`Dispatched deep link: ${url}`);
    });

    // 2. Listen to core events
    ctx.bus.on('device:booted', ({ deviceId }) => {
      ctx.logger.debug(`Ready to send deep links to ${deviceId}`);
    });

    // 3. Contribute a panel to TUI and Web Dashboard
    ctx.ui.registerPanel({
      id: 'deeplinks-panel',
      title: 'Deep Links',
      shortcut: 'd',
      renderWeb: () => '/plugins/deeplinks/index.js',
    });

    // 4. Expose capability to AI Agents via MCP
    ctx.mcp.registerTool({
      name: 'open_deeplink',
      description: 'Opens a deep link URL on all active simulators/emulators',
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => {
        await ctx.bus.emit('broadcast:deeplink', { url });
        return { success: true, url };
      },
    });
  },

  async teardown(ctx) {
    ctx.logger.info('Deep Link Launcher stopped');
  },
});
```

---

## 6. Phased Feature Roadmap (All Built as Plugins)

### Phase 1: MVP — Single-Window Mission Control
*Goal: Eliminate multiple terminal tabs, Xcode, and Android Studio for daily coding.*

1. **`@rnctl/plugin-devices` (Unified Device Manager)**
   * Lists iOS simulators (`xcrun simctl`), Android emulators (`emulator -list-avds`), and USB physical devices (`adb devices`) in one live table.
   * One-key actions: Boot, Cold Boot, Shutdown, Erase/Wipe, Create new AVD/Simulator, and auto-run `adb reverse tcp:8081 tcp:8081`.
2. **`@rnctl/plugin-metro` (Bundler & Build Supervisor)**
   * Starts, stops, and restarts Metro (`--reset-cache`) cleanly without leaving zombie processes.
   * Triggers `run-ios` / `run-android` builds targeted at specific selected devices.
   * One-key JS bundle reload (`r`) and Dev Menu trigger (`d`).
3. **`@rnctl/plugin-logs` (Unified Native + JS Log Multiplexer)**
   * Merges Metro JS logs, `adb logcat` (filtered to app PID), and `xcrun simctl log stream` into one chronological feed.
   * Color-coded source badges (`[METRO]`, `[iOS]`, `[ANDROID]`), regex/level filtering, and **automatic stack-trace collapsing** for noisy native errors.

---

### Phase 2: Workflow Accelerators & Environment Health
*Goal: Solve painful native environment issues and speed up multi-device testing.*

4. **`@rnctl/plugin-broadcast` (Multi-Device Simultaneous Actions)**
   * Send one action to all booted iOS + Android devices at once: reload app, toggle Dark/Light mode, open a deep link URL, or trigger a shake gesture.
5. **`@rnctl/plugin-simulator-tweaks` (Device Hardware & Environment Controls)**
   * Set custom GPS coordinates/routes, toggle airplane mode/network throttling, override status bar time/battery (clean screenshots), and send mock push notifications (APNs/FCM payloads).
6. **`@rnctl/plugin-doctor` (Environment Diagnostics & One-Click Nuke)**
   * Checks Xcode CLI tools, CocoaPods, JDK version, Android SDK paths, Watchman, and port `8081` conflicts.
   * Interactive **`rnctl nuke`** menu to selectively wipe Metro cache, Watchman, `node_modules`, Android `.gradle`/build folders, iOS `Pods`, and Xcode `DerivedData` with disk-space recovery stats.

---

### Phase 3: Zero-SDK Deep Inspection
*Goal: Replace Reactotron and paid IDE inspectors without requiring code changes in the user's app.*

7. **`@rnctl/plugin-network` (Zero-SDK Network Inspector)**
   * Inspects HTTP/HTTPS and WebSocket traffic via local proxy/CDP bridge without adding third-party SDKs to `package.json`.
   * Displays headers, JSON payload trees, response times, and one-click "Copy as cURL".
8. **`@rnctl/plugin-storage` (Live Local Storage Explorer)**
   * Reads and edits `AsyncStorage`, `MMKV`, `SecureStore`/`Keychain`, and local SQLite databases directly from simulator/emulator app containers.
9. **`@rnctl/plugin-perf` (Hermes Crash & FPS Profiler)**
   * Symbolicates native iOS `.crash` reports and Android tombstones automatically, and tracks JS/UI thread FPS drops.

---

### Phase 4: AI Agents & Community Ecosystem
*Goal: Make `rnctl` the standard bridge between React Native apps and AI coding assistants.*

10. **`@rnctl/plugin-mcp` (Local Model Context Protocol Server)**
    * Exposes live simulator screenshots, unified error logs, network failures, and device actions to **Claude Code, Cursor, Windsurf, and GitHub Copilot** for free.
11. **`@rnctl/plugin-e2e` (Maestro & Detox Runner)**
    * Discovers local Maestro `.yaml` flows and runs them against booted simulators with inline pass/fail screenshots.
12. **`@rnctl/plugin-scaffolder` (Plugin Generator & Registry)**
    * Provides `rnctl plugin create` to generate ready-to-publish `rnctl-plugin-*` templates with built-in mock daemon testing utilities.
