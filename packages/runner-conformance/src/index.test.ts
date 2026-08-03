import { describe, expect, test } from 'bun:test';
import { ProtocolAgent, ProtocolTimeoutError } from './index';
import { RunnerHeartbeatRequestSchema } from '@agent-party-time/runner-contract';

describe('ProtocolAgent', () => {
  test('Heartbeat 容量固定限制为三个执行槽', () => {
    expect(RunnerHeartbeatRequestSchema.parse({ availableSlots: 3 })).toEqual({
      availableSlots: 3,
    });
    expect(() =>
      RunnerHeartbeatRequestSchema.parse({ availableSlots: 4 }),
    ).toThrow();
  });
  test('认证请求只通过 Bearer Header 并使用共享请求 Schema', async () => {
    const requests: Request[] = [];
    const agent = new ProtocolAgent({
      serverUrl: 'https://apt.example.com/path-is-ignored',
      credential: `credential-${'x'.repeat(32)}`,
      fetch: async (input, init) => {
        const request =
          input instanceof Request ? input : new Request(String(input), init);
        requests.push(request);
        return Response.json({ executions: [] });
      },
    });

    expect(await agent.claimExecutions(3, 0)).toEqual([]);
    expect(requests[0]?.url).toBe(
      'https://apt.example.com/api/runner/executions/claim',
    );
    expect(requests[0]?.headers.get('authorization')).toBe(
      `Bearer credential-${'x'.repeat(32)}`,
    );
    expect(requests[0]?.headers.get('content-type')).toBe('application/json');
    expect(await requests[0]?.json()).toEqual({ availableSlots: 3, waitMs: 0 });
  });

  test('确定性等待在截止时间后报告协议超时', async () => {
    const agent = new ProtocolAgent({
      serverUrl: 'https://apt.example.com',
      fetch: async () => Response.json({ executions: [] }),
    });

    await expect(
      agent.waitForExecution({ timeoutMs: 0, waitMs: 0 }),
    ).rejects.toBeInstanceOf(ProtocolTimeoutError);
  });

  test('Binding 请求在发出前拒绝本机路径', async () => {
    let called = false;
    const agent = new ProtocolAgent({
      serverUrl: 'https://apt.example.com',
      fetch: async () => {
        called = true;
        return Response.json({});
      },
    });

    await expect(
      agent.confirmBinding(
        '00000000-0000-4000-8000-000000000001',
        '/tmp/local-repository',
      ),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});
