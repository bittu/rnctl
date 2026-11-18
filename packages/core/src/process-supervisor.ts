import type { ExecResult, ProcessHandle, Processes, SpawnOptions } from '@rnctl/sdk';

/** Tracks spawned process ids so the daemon can clean them up on shutdown. */
export class ProcessSupervisor implements Processes {
  private readonly handles = new Map<string, ProcessHandle>();

  // shortcut: spawn/exec are no-op stubs; wire execa + cleanup hooks in Phase 1.
  async spawn(id: string, _command: string, _args: string[] = [], _options: SpawnOptions = {}): Promise<ProcessHandle> {
    const handle: ProcessHandle = { id };
    this.handles.set(id, handle);
    return handle;
  }

  async exec(_command: string, _args: string[] = [], _options: SpawnOptions = {}): Promise<ExecResult> {
    return { stdout: '', stderr: '' };
  }

  get(id: string): ProcessHandle | undefined {
    return this.handles.get(id);
  }

  async shutdown(): Promise<void> {
    this.handles.clear();
  }
}
