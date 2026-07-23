import type { ControlPlanePort } from '@agent-party-time/control-plane-client';
import type { Logger } from '../logging/logger.js';

export interface RunnerRegistrationOptions {
  controlPlane: ControlPlanePort;
  runner: { runnerId: string; runnerName: string };
  intervalMs: number;
  logger: Logger;
}

export class RunnerRegistration {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(private readonly options: RunnerRegistrationOptions) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick(true);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick(register: boolean) {
    try {
      if (register)
        await this.options.controlPlane.registerRunner({
          runnerId: this.options.runner.runnerId,
          name: this.options.runner.runnerName,
        });
      else
        await this.options.controlPlane.heartbeatRunner(
          this.options.runner.runnerId,
        );
      register = false;
    } catch (error) {
      this.options.logger.warn(
        'control_plane.heartbeat_failed',
        'Agent 暂时无法连接控制平面',
        { error: error instanceof Error ? error.message : String(error) },
      );
      register = true;
    }
    if (this.stopped) return;
    this.timer = setTimeout(
      () => void this.tick(register),
      this.options.intervalMs,
    );
  }
}
