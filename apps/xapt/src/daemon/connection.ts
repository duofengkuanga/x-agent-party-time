import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import {
  RunnerAuthorizationVerifierSchema,
  RunnerFingerprintSchema,
} from '@agent-party-time/runner-contract';
import type { Browser, Clock, Keychain } from '../platform/contracts';
import { keychainAccount } from '../platform/macos/keychain';
import { CONNECTION_STATE_SCHEMA_VERSION } from '../state/schemas';
import type { LocalStateStore } from '../state/store';
import type { ConnectionStatus } from './status';
import { RunnerHttpError, type RunnerAuthorizationHttp } from './runner-http';

export interface ConnectionProjection {
  status: ConnectionStatus;
  activity: 'IDLE' | 'BUSY';
  serverOrigin: string | null;
  agentName: string | null;
  lastHeartbeatAt: string | null;
}

export interface ConnectionProgress {
  authorizationUrl: string;
  fingerprint: string;
  browserOpened: boolean;
}

export interface AuthenticatedRunnerSession {
  serverOrigin: string;
  credential: string;
}

export class ConnectionCoordinator {
  readonly projection: ConnectionProjection = {
    status: 'UNCONFIGURED',
    activity: 'IDLE',
    serverOrigin: null,
    agentName: null,
    lastHeartbeatAt: null,
  };

  constructor(
    private readonly state: LocalStateStore,
    private readonly keychain: Keychain,
    private readonly browser: Browser,
    private readonly http: RunnerAuthorizationHttp,
    private readonly clock: Clock,
    private readonly createVerifier: () => string = () =>
      randomBytes(32).toString('base64url'),
    private readonly suggestedName: () => string = () =>
      `${hostname().split('.')[0] || '本机'} Agent`,
  ) {}

  async restore(): Promise<void> {
    const connection = await this.state.loadConnection();
    if (!connection) return;
    const origin = normalizeServerOrigin(connection.serverUrl);
    this.projection.serverOrigin = origin;
    const credential = await this.keychain.read(
      keychainAccount(origin, connection.runnerId),
    );
    if (!credential) {
      this.projection.status = 'REVOKED';
      return;
    }
    try {
      const runner = await this.http.heartbeat(origin, credential, 3);
      this.projection.status = 'CONNECTED';
      this.projection.agentName = runner.name;
      this.projection.lastHeartbeatAt = this.clock.now().toISOString();
    } catch (error) {
      this.projection.status = isRevoked(error) ? 'REVOKED' : 'DEGRADED';
    }
  }

  async heartbeat(
    availableSlots: number,
  ): Promise<AuthenticatedRunnerSession | null> {
    const session = await this.authenticatedSession();
    if (!session) return null;
    try {
      const runner = await this.http.heartbeat(
        session.serverOrigin,
        session.credential,
        availableSlots,
      );
      this.projection.status = 'CONNECTED';
      this.projection.serverOrigin = session.serverOrigin;
      this.projection.agentName = runner.name;
      this.projection.lastHeartbeatAt = this.clock.now().toISOString();
      return session;
    } catch (error) {
      this.reportConnectionError(error);
      return null;
    }
  }

  async revokeSelf(): Promise<void> {
    if (this.projection.activity === 'BUSY')
      throw new ConnectionError('CONNECT_IN_PROGRESS', 'Agent 正在处理连接');
    const connection = await this.state.loadConnection();
    const session = await this.authenticatedSession();
    if (!connection || !session) return;
    this.projection.activity = 'BUSY';
    try {
      try {
        await this.http.revokeSelf(session.serverOrigin, session.credential);
      } catch (error) {
        if (!isRevoked(error)) throw error;
      }
      await this.keychain.delete(
        keychainAccount(session.serverOrigin, connection.runnerId),
      );
      await this.state.removeConnection();
      this.projection.status = 'UNCONFIGURED';
      this.projection.serverOrigin = null;
      this.projection.agentName = null;
      this.projection.lastHeartbeatAt = null;
    } finally {
      this.projection.activity = 'IDLE';
    }
  }

  reportConnectionError(error: unknown): void {
    this.projection.status = isRevoked(error) ? 'REVOKED' : 'DEGRADED';
  }

  private async authenticatedSession(): Promise<AuthenticatedRunnerSession | null> {
    const connection = await this.state.loadConnection();
    if (!connection) {
      this.projection.status = 'UNCONFIGURED';
      this.projection.serverOrigin = null;
      return null;
    }
    const serverOrigin = normalizeServerOrigin(connection.serverUrl);
    const credential = await this.keychain.read(
      keychainAccount(serverOrigin, connection.runnerId),
    );
    if (!credential) {
      this.projection.status = 'REVOKED';
      this.projection.serverOrigin = serverOrigin;
      return null;
    }
    return { serverOrigin, credential };
  }

  async connect(
    serverUrl: string,
    progress: (value: ConnectionProgress) => void,
  ): Promise<void> {
    if (this.projection.activity === 'BUSY')
      throw new ConnectionError(
        'CONNECT_IN_PROGRESS',
        '已有 Agent 授权正在进行',
      );
    const origin = normalizeServerOrigin(serverUrl);
    const existing = await this.state.loadConnection();
    if (existing) {
      const existingOrigin = normalizeServerOrigin(existing.serverUrl);
      if (existingOrigin !== origin)
        throw new ConnectionError(
          'DIFFERENT_SERVER',
          'xapt 已连接另一台 Server，不会隐式切换',
        );
      const credential = await this.keychain.read(
        keychainAccount(existingOrigin, existing.runnerId),
      );
      if (credential) {
        try {
          const runner = await this.http.heartbeat(
            existingOrigin,
            credential,
            3,
          );
          this.projection.status = 'CONNECTED';
          this.projection.serverOrigin = existingOrigin;
          this.projection.agentName = runner.name;
          this.projection.lastHeartbeatAt = this.clock.now().toISOString();
          return;
        } catch (error) {
          if (!isRevoked(error)) throw error;
        }
      }
    }

    const previousStatus = this.projection.status;
    this.projection.status = 'CONNECTING';
    this.projection.activity = 'BUSY';
    this.projection.serverOrigin = origin;
    try {
      const verifier = RunnerAuthorizationVerifierSchema.parse(
        this.createVerifier(),
      );
      const verifierHash = createHash('sha256').update(verifier).digest('hex');
      const fingerprint = RunnerFingerprintSchema.parse(
        verifierHash.slice(0, 12).toUpperCase().match(/.{4}/gu)!.join('-'),
      );
      const issue = await this.http.createAuthorization(origin, {
        verifierHash,
        fingerprint,
        suggestedName: this.suggestedName(),
      });
      const authorizationUrl =
        `${origin}/cooking/agents/connect?request=` +
        encodeURIComponent(issue.requestId);
      let browserOpened = true;
      try {
        await this.browser.open(new URL(authorizationUrl));
      } catch {
        browserOpened = false;
      }
      progress({ authorizationUrl, fingerprint, browserOpened });

      const deadline = Date.parse(issue.expiresAt);
      while (this.clock.now().getTime() < deadline) {
        const result = await this.http.claimAuthorization(
          origin,
          issue.requestId,
          verifier,
        );
        if (result.state === 'WAITING') {
          await this.clock.sleep(result.retryAfterMs);
          continue;
        }
        if (result.state === 'REJECTED')
          throw new ConnectionError('AUTHORIZATION_REJECTED', result.message);
        const account = keychainAccount(origin, result.runner.id);
        await this.keychain.save(account, result.credential);
        try {
          await this.state.saveConnection({
            schemaVersion: CONNECTION_STATE_SCHEMA_VERSION,
            serverUrl: origin,
            runnerId: result.runner.id,
          });
        } catch (error) {
          try {
            await this.keychain.delete(account);
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              '连接状态写入失败，且临时 Credential 清理失败',
            );
          }
          throw error;
        }
        if (existing && existing.runnerId !== result.runner.id)
          await this.keychain.delete(
            keychainAccount(origin, existing.runnerId),
          );
        this.projection.status = 'CONNECTED';
        this.projection.serverOrigin = origin;
        this.projection.agentName = result.runner.name;
        this.projection.lastHeartbeatAt = this.clock.now().toISOString();
        return;
      }
      throw new ConnectionError(
        'AUTHORIZATION_EXPIRED',
        'Agent 授权请求已过期',
      );
    } finally {
      this.projection.activity = 'IDLE';
      if (this.projection.status === 'CONNECTING') {
        this.projection.status = existing ? 'REVOKED' : previousStatus;
        this.projection.serverOrigin = existing
          ? normalizeServerOrigin(existing.serverUrl)
          : null;
      }
    }
  }
}

export function normalizeServerOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ConnectionError('INVALID_SERVER_URL', 'Server URL 无效');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new ConnectionError(
      'INVALID_SERVER_URL',
      'Server URL 必须使用 HTTP 或 HTTPS',
    );
  if (url.username || url.password)
    throw new ConnectionError('INVALID_SERVER_URL', 'Server URL 不得包含凭据');
  return url.origin;
}

function isRevoked(error: unknown): boolean {
  return (
    error instanceof RunnerHttpError &&
    (error.status === 401 || error.code === 'NOT_AUTHENTICATED')
  );
}

export type ConnectionErrorCode =
  | 'INVALID_SERVER_URL'
  | 'CONNECT_IN_PROGRESS'
  | 'DIFFERENT_SERVER'
  | 'AUTHORIZATION_REJECTED'
  | 'AUTHORIZATION_EXPIRED';

export class ConnectionError extends Error {
  constructor(
    readonly code: ConnectionErrorCode,
    message: string,
  ) {
    super(`${message}。下一步：请检查连接状态后重试。`);
    this.name = 'ConnectionError';
  }
}
