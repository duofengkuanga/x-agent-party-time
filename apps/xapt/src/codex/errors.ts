export class CodexAppServerError extends Error {
  constructor(
    message: string,
    readonly sessionId: string | null,
  ) {
    super(message);
    this.name = 'CodexAppServerError';
  }
}
