export class CodexAppServerError extends Error {
  constructor(
    message: string,
    readonly sessionId: string | null,
  ) {
    super(message);
    this.name = 'CodexAppServerError';
  }
}

export class CodexSessionReleaseError extends Error {
  readonly name = 'CodexSessionReleaseError';
  constructor(
    readonly processGroups: number[],
    cause?: unknown,
    readonly ownershipUncertain = false,
  ) {
    super('无法确认 Codex 及其工具进程已经退出，暂不释放执行通道', { cause });
  }
}
