export type ServiceStatus = 'STOPPED' | 'RUNNING' | 'UNRESPONSIVE';
export type ConnectionStatus =
  'UNCONFIGURED' | 'CONNECTING' | 'CONNECTED' | 'DEGRADED' | 'REVOKED';
export type ActivityStatus = 'IDLE' | 'BUSY';

export interface DaemonSnapshot {
  service: ServiceStatus;
  connection: ConnectionStatus;
  activity: ActivityStatus;
  version: string;
  codexVersion: string | null;
  serverOrigin: string | null;
  agentName: string | null;
  lastHeartbeatAt: string | null;
  activeSlots: number;
  totalSlots: number;
  waitingInteractions: number;
  outboxCount: number;
  bindingCount: number;
  bindingActive: boolean;
}

export function stoppedSnapshot(version: string): DaemonSnapshot {
  return {
    service: 'STOPPED',
    connection: 'UNCONFIGURED',
    activity: 'IDLE',
    version,
    codexVersion: null,
    serverOrigin: null,
    agentName: null,
    lastHeartbeatAt: null,
    activeSlots: 0,
    totalSlots: 3,
    waitingInteractions: 0,
    outboxCount: 0,
    bindingCount: 0,
    bindingActive: false,
  };
}

export function unresponsiveSnapshot(version: string): DaemonSnapshot {
  return { ...stoppedSnapshot(version), service: 'UNRESPONSIVE' };
}

export function isDaemonHealthy(snapshot: DaemonSnapshot): boolean {
  return snapshot.service === 'RUNNING' && snapshot.connection === 'CONNECTED';
}
