import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import {
  RunnerAuthorizationVerifierSchema,
  RunnerFingerprintSchema,
} from '@agent-party-time/runner-contract';
import { RunnerClient, RunnerProtocolError } from './client';
import { RunnerStateStore } from './state';

type AuthorizationClient = Pick<
  RunnerClient,
  'claimAuthorization' | 'createAuthorization' | 'heartbeat'
>;
type AuthorizationOutput = Pick<Console, 'log'>;

export class AgentAuthorization {
  constructor(
    private readonly client: AuthorizationClient = new RunnerClient(),
    private readonly state: RunnerStateStore = new RunnerStateStore(),
    private readonly openBrowser: (
      url: string,
    ) => Promise<void> = openSystemBrowser,
    private readonly wait: (durationMs: number) => Promise<void> = sleep,
    private readonly createVerifier: () => string = () =>
      randomBytes(32).toString('base64url'),
    private readonly suggestedName: () => string = () =>
      `${hostname().split('.')[0] || '本机'} Agent`,
    private readonly output: AuthorizationOutput = console,
  ) {}

  async ensureAuthorized(serverUrl: string): Promise<void> {
    let hasConfig = await this.state.hasConfig();
    if (hasConfig) {
      try {
        await this.state.loadConfig();
      } catch {
        await this.state.clearConfig();
        hasConfig = false;
      }
    }
    if (hasConfig) {
      while (true) {
        try {
          await this.client.heartbeat();
          return;
        } catch (error) {
          if (
            error instanceof RunnerProtocolError &&
            error.code === 'NOT_AUTHENTICATED'
          ) {
            await this.state.clearConfig();
            break;
          }
          await this.wait(1_000);
        }
      }
    }

    const verifier = RunnerAuthorizationVerifierSchema.parse(
      this.createVerifier(),
    );
    const verifierHash = createHash('sha256').update(verifier).digest('hex');
    const fingerprint = RunnerFingerprintSchema.parse(
      verifierHash.slice(0, 12).toUpperCase().match(/.{4}/gu)!.join('-'),
    );

    let issue;
    while (!issue) {
      try {
        issue = await this.client.createAuthorization(serverUrl, {
          verifierHash,
          fingerprint,
          suggestedName: this.suggestedName(),
        });
      } catch {
        await this.wait(1_000);
      }
    }

    const authorizationUrl =
      `${serverUrl}/cooking/agents/connect?request=` +
      encodeURIComponent(issue.requestId);
    try {
      await this.openBrowser(authorizationUrl);
    } catch {
      this.output.log(`请在浏览器打开 Agent 连接页：${authorizationUrl}`);
    }
    this.output.log(`等待浏览器确认 Agent（短指纹 ${fingerprint}）。`);

    while (true) {
      try {
        const result = await this.client.claimAuthorization(
          serverUrl,
          issue.requestId,
          verifier,
        );
        if (result.state === 'AUTHORIZED') return;
        if (result.state === 'REJECTED') {
          this.output.log(result.message);
          await waitUntilStopped(this.wait);
        }
        if (result.state === 'WAITING') await this.wait(result.retryAfterMs);
      } catch {
        await this.wait(1_000);
      }
    }
  }
}

async function openSystemBrowser(url: string): Promise<void> {
  if (process.platform !== 'darwin')
    throw new Error('当前平台不支持自动打开浏览器');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('open', [url], {
      stdio: 'ignore',
      detached: false,
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error('无法打开浏览器')),
    );
  });
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function waitUntilStopped(
  wait: (durationMs: number) => Promise<void>,
): Promise<never> {
  while (true) await wait(30_000);
}
