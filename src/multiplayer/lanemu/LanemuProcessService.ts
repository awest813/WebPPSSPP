/**
 * LanemuProcessService.ts — Manages the lifecycle of the LANemu Java process.
 */

export interface ProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
  detached?: boolean;
}

export interface IProcessLaunchService {
  spawn(command: string, args: string[], options?: ProcessOptions): Promise<number>;
  kill(pid: number): Promise<void>;
  isProcessRunning(pid: number): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  validateJava(path: string): Promise<boolean>;
}

export class LanemuProcessService {
  private _pid: number | null = null;
  private _launcher: IProcessLaunchService;

  constructor(launcher: IProcessLaunchService) {
    this._launcher = launcher;
  }

  get isRunning(): boolean { return this._pid !== null; }

  async start(javaPath: string, jarPath: string, args: string[]): Promise<void> {
    if (this._pid) await this.stop();

    const fullArgs = ["-jar", jarPath, ...args];
    try {
      this._pid = await this._launcher.spawn(javaPath, fullArgs, { detached: true });
    } catch (err) {
      throw new Error(`Failed to start LANemu: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async stop(): Promise<void> {
    if (!this._pid) return;
    try {
      await this._launcher.kill(this._pid);
    } finally {
      this._pid = null;
    }
  }

  async checkAlive(): Promise<boolean> {
    if (!this._pid) {
      return false;
    }
    const running = await this._launcher.isProcessRunning(this._pid);
    if (!running) this._pid = null;
    return running;
  }

  async validatePrerequisites(javaPath: string, jarPath: string): Promise<{ javaOk: boolean; jarOk: boolean }> {
    const [javaOk, jarOk] = await Promise.all([
      this._launcher.validateJava(javaPath).catch(() => false),
      this._launcher.exists(jarPath).catch(() => false)
    ]);
    return { javaOk, jarOk };
  }
}
