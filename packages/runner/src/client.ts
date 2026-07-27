import {
  PairingCodeSchema,
  RunnerBindingsResponseSchema,
  RunnerHeartbeatResponseSchema,
  RunnerNameSchema,
  RunnerPairingResultSchema,
  type Runner,
  type RunnerBindingRef,
} from '@agent-party-time/runner-contract';
import { normalizeServerUrl } from './server-url';
import { RunnerStateStore } from './state';

export class RunnerClient {
  constructor(
    private readonly state: RunnerStateStore = new RunnerStateStore(),
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async pair(input: {
    serverUrl: string;
    code: string;
    name: string;
  }): Promise<Runner> {
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const response = await this.fetchImplementation(
      `${serverUrl}/api/runner/pair`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: PairingCodeSchema.parse(input.code),
          name: RunnerNameSchema.parse(input.name),
        }),
      },
    );
    const paired = RunnerPairingResultSchema.parse(
      await responseJson(response),
    );
    await this.state.saveConfig({
      serverUrl,
      runnerId: paired.runner.id,
      credential: paired.credential,
    });
    return paired.runner;
  }

  async heartbeat(): Promise<Runner> {
    const config = await this.state.loadConfig();
    const response = await this.fetchImplementation(
      `${config.serverUrl}/api/runner/heartbeat`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${config.credential}` },
      },
    );
    return RunnerHeartbeatResponseSchema.parse(await responseJson(response))
      .runner;
  }

  async listServerBindings(): Promise<RunnerBindingRef[]> {
    const config = await this.state.loadConfig();
    const response = await this.fetchImplementation(
      `${config.serverUrl}/api/runner/bindings`,
      { headers: { authorization: `Bearer ${config.credential}` } },
    );
    return RunnerBindingsResponseSchema.parse(await responseJson(response))
      .bindings;
  }
}

async function responseJson(response: Response): Promise<unknown> {
  const body = (await response.json()) as {
    error?: { message?: string };
  };
  if (!response.ok)
    throw new Error(
      body.error?.message ?? `服务端请求失败（${response.status}）`,
    );
  return body;
}
