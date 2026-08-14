import { randomUUID } from 'node:crypto';
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import { dirname } from 'node:path';
import type { LocalFileSystem } from '../platform/files';
import type { ConnectionProgress } from './connection';
import type { DaemonSnapshot } from './status';

const CONTROL_PROTOCOL_VERSION = 1;
const MAX_CONTROL_MESSAGE_BYTES = 64 * 1024;

type ControlRequest =
  | {
      protocolVersion: 1;
      id: string;
      method: 'status';
    }
  | {
      protocolVersion: 1;
      id: string;
      method: 'revoke';
    }
  | {
      protocolVersion: 1;
      id: string;
      method: 'stop';
      force: boolean;
    }
  | {
      protocolVersion: 1;
      id: string;
      method: 'connect';
      serverUrl: string;
    };

type ControlResponse =
  | { id: string; ok: true; result: DaemonSnapshot }
  | { id: string; ok: false; error: { code: string; message: string } };

type ControlEvent = {
  id: string;
  event: 'connect-progress';
  value: ConnectionProgress;
};

export interface ControlServerOptions {
  socketPath: string;
  files: LocalFileSystem;
  snapshot: () => Promise<DaemonSnapshot>;
  connect?: (
    serverUrl: string,
    progress: (value: ConnectionProgress) => void,
  ) => Promise<void>;
  forceStop?: () => Promise<void> | void;
  revoke?: () => Promise<void>;
}

export class DaemonControlServer {
  private server: Server | null = null;
  private resolveDone!: () => void;
  readonly done = new Promise<void>((resolve) => {
    this.resolveDone = resolve;
  });

  constructor(private readonly options: ControlServerOptions) {}

  async start(): Promise<void> {
    if (this.server) throw new Error('本机服务控制端已启动');
    await this.options.files.ensureDirectory(
      dirname(this.options.socketPath),
      0o700,
    );
    const existing = await this.options.files.info(this.options.socketPath);
    if (existing?.type === 'socket')
      await this.options.files.remove(this.options.socketPath);
    else if (existing)
      throw new ControlSocketError(
        'SOCKET_OCCUPIED',
        'control socket 位置被未知文件占用',
      );

    const server = createServer((socket) => this.handle(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await this.options.files.setMode(this.options.socketPath, 0o600);
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await this.options.files.remove(this.options.socketPath);
    this.resolveDone();
  }

  private handle(socket: Socket): void {
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      input += chunk;
      if (Buffer.byteLength(input) > MAX_CONTROL_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const line = input.slice(0, newline);
      input = '';
      void this.respond(socket, line);
    });
  }

  private async respond(socket: Socket, line: string): Promise<void> {
    let request: ControlRequest;
    try {
      request = parseRequest(line);
    } catch {
      sendFinal(socket, {
        id: 'invalid',
        ok: false,
        error: { code: 'INVALID_REQUEST', message: '本机控制请求无效' },
      });
      return;
    }
    try {
      if (request.method === 'connect') {
        if (!this.options.connect)
          throw new ControlSocketError('NOT_SUPPORTED', '本机服务尚不支持连接');
        await this.options.connect(request.serverUrl, (value) =>
          socket.write(
            `${JSON.stringify({
              id: request.id,
              event: 'connect-progress',
              value,
            } satisfies ControlEvent)}\n`,
          ),
        );
        sendFinal(socket, {
          id: request.id,
          ok: true,
          result: await this.options.snapshot(),
        });
        return;
      }

      if (request.method === 'revoke') {
        const snapshot = await this.options.snapshot();
        if (snapshot.activity === 'BUSY')
          throw new ControlSocketError('DAEMON_BUSY', '本机服务正在处理任务');
        if (!this.options.revoke)
          throw new ControlSocketError('NOT_SUPPORTED', '本机服务尚不支持撤销');
        await this.options.revoke();
        sendFinal(socket, {
          id: request.id,
          ok: true,
          result: await this.options.snapshot(),
        });
        return;
      }

      const snapshot = await this.options.snapshot();
      if (
        request.method === 'stop' &&
        snapshot.activity === 'BUSY' &&
        !request.force
      )
        throw new ControlSocketError('DAEMON_BUSY', '本机服务正在处理任务');
      if (request.method === 'stop' && request.force)
        await this.options.forceStop?.();
      sendFinal(
        socket,
        { id: request.id, ok: true, result: snapshot },
        request.method === 'stop' ? () => void this.close() : undefined,
      );
    } catch (error) {
      sendFinal(socket, {
        id: request.id,
        ok: false,
        error: {
          code:
            error instanceof ControlSocketError || hasCode(error)
              ? String(error.code)
              : 'CONTROL_FAILED',
          message: error instanceof Error ? error.message : '本机控制失败',
        },
      });
    }
  }
}

export class DaemonControlClient {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 2_000,
  ) {}

  async status(): Promise<DaemonSnapshot> {
    return await this.request(
      { protocolVersion: CONTROL_PROTOCOL_VERSION, id: '', method: 'status' },
      this.timeoutMs,
    );
  }

  async stop(force = false): Promise<DaemonSnapshot> {
    return await this.request(
      {
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        id: '',
        method: 'stop',
        force,
      },
      this.timeoutMs,
    );
  }

  async revoke(): Promise<DaemonSnapshot> {
    return await this.request(
      { protocolVersion: CONTROL_PROTOCOL_VERSION, id: '', method: 'revoke' },
      this.timeoutMs,
    );
  }

  async connect(
    serverUrl: string,
    progress: (value: ConnectionProgress) => void,
    timeoutMs = 10 * 60_000,
  ): Promise<DaemonSnapshot> {
    return await this.request(
      {
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        id: '',
        method: 'connect',
        serverUrl,
      },
      timeoutMs,
      progress,
    );
  }

  private async request(
    requestInput: ControlRequest,
    timeoutMs: number,
    progress: (value: ConnectionProgress) => void = () => {},
  ): Promise<DaemonSnapshot> {
    const id = randomUUID();
    const request = { ...requestInput, id } as ControlRequest;
    return await new Promise<DaemonSnapshot>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let input = '';
      let settled = false;
      const timeout = setTimeout(() => {
        socket.destroy();
        settle(() =>
          reject(new ControlSocketError('TIMEOUT', '本机服务无响应')),
        );
      }, timeoutMs);
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };
      socket.setEncoding('utf8');
      socket.once('error', (error) =>
        settle(() =>
          reject(
            new ControlSocketError('UNREACHABLE', '无法连接本机服务', error),
          ),
        ),
      );
      socket.on('data', (chunk: string) => {
        input += chunk;
        if (Buffer.byteLength(input) > MAX_CONTROL_MESSAGE_BYTES) {
          settle(() =>
            reject(
              new ControlSocketError('INVALID_RESPONSE', '本机服务响应过大'),
            ),
          );
          socket.destroy();
          return;
        }
        for (;;) {
          const newline = input.indexOf('\n');
          if (newline < 0) return;
          const line = input.slice(0, newline);
          input = input.slice(newline + 1);
          try {
            const frame = parseFrame(line, id);
            if ('event' in frame) {
              progress(frame.value);
              continue;
            }
            settle(() => {
              if (frame.ok) resolve(frame.result);
              else
                reject(
                  new ControlSocketError(frame.error.code, frame.error.message),
                );
            });
            socket.end();
            return;
          } catch (error) {
            settle(() => reject(error));
            socket.destroy();
            return;
          }
        }
      });
      socket.once('connect', () =>
        socket.write(`${JSON.stringify(request)}\n`),
      );
    });
  }
}

function parseRequest(line: string): ControlRequest {
  const value = JSON.parse(line) as Partial<ControlRequest>;
  if (
    value.protocolVersion !== CONTROL_PROTOCOL_VERSION ||
    typeof value.id !== 'string' ||
    !['status', 'stop', 'connect', 'revoke'].includes(String(value.method)) ||
    (value.method === 'stop' && typeof value.force !== 'boolean') ||
    (value.method === 'connect' && typeof value.serverUrl !== 'string')
  )
    throw new Error('invalid control request');
  return value as ControlRequest;
}

function parseFrame(line: string, id: string): ControlResponse | ControlEvent {
  const value = JSON.parse(line) as ControlResponse | ControlEvent;
  if (value.id !== id)
    throw new ControlSocketError('INVALID_RESPONSE', '本机服务响应无效');
  if ('event' in value) {
    if (value.event !== 'connect-progress')
      throw new ControlSocketError('INVALID_RESPONSE', '本机服务事件无效');
    return value;
  }
  if (typeof value.ok !== 'boolean')
    throw new ControlSocketError('INVALID_RESPONSE', '本机服务响应无效');
  return value;
}

function sendFinal(
  socket: Socket,
  response: ControlResponse,
  after?: () => void,
): void {
  socket.end(`${JSON.stringify(response)}\n`, after);
}

function hasCode(value: unknown): value is { code: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value;
}

export class ControlSocketError extends Error {
  constructor(
    readonly code: string,
    message: string,
    cause?: unknown,
  ) {
    super(`${message}。下一步：运行 xapt daemon status 检查状态。`, {
      cause,
    });
    this.name = 'ControlSocketError';
  }
}
