import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startLocalService,
  type LocalServiceHandle,
} from '@agent-party-time/local-service';
import {
  AddAgentCommandSchema,
  AddChannelCommandSchema,
  AgentMutationResultSchema,
  ChannelMessageSchema,
  ChannelMutationResultSchema,
  ListAgentsQuerySchema,
  ListAgentsResultSchema,
  ServiceStatusQuerySchema,
  ServiceStatusResultSchema,
  CreateTaskCommandSchema,
  ChangeTaskStateCommandSchema,
  GetTaskQuerySchema,
  GetTaskResultSchema,
  TaskMutationResultSchema,
  type AgentRunner,
  type ChannelMessageHandler,
  type ChannelTransport,
} from '@agent-party-time/shared';
import { ServiceClient } from './client/service-client.js';

describe('resident service and typed client', () => {
  let home: string | null = null;
  let handle: LocalServiceHandle | null = null;
  afterEach(async () => {
    await handle?.shutdown('test cleanup');
    if (home) await rm(home, { recursive: true, force: true });
    handle = null;
    home = null;
  });

  test('starts, authenticates, persists config mutations, and stops', async () => {
    home = await mkdtemp(join(tmpdir(), 'apt-e2e-'));
    handle = await startLocalService({
      homeDirectory: home,
      apiPort: 0,
      logLevel: 'fatal',
    });
    const client = new ServiceClient({
      homeDirectory: home,
      serverUrl: handle.address(),
      timeoutMs: 5_000,
    });
    const status = await client.query(
      'service.status',
      ServiceStatusQuerySchema,
      ServiceStatusResultSchema,
      {},
    );
    expect(status.instance.instanceId).toBe(handle.instanceId);
    const added = await client.request(
      'agent.add',
      AddAgentCommandSchema,
      AgentMutationResultSchema,
      {
        id: 'test-agent',
        expectedRevision: 0,
        name: 'Test Agent',
        workspacePath: process.cwd(),
        role: 'front',
      },
      { idempotencyKey: 'agent:test-agent' },
    );
    expect(added.configRevision).toBe(1);
    const agents = await client.query(
      'agent.list',
      ListAgentsQuerySchema,
      ListAgentsResultSchema,
      { limit: 10 },
    );
    expect(agents.items.map((agent) => agent.id)).toEqual(['test-agent']);
    const createTask = CreateTaskCommandSchema.parse({
      taskId: 'task-1',
      title: 'E2E task',
      creator: { kind: 'human', id: 'test' },
    });
    const created = await client.request(
      'task.create',
      CreateTaskCommandSchema,
      TaskMutationResultSchema,
      createTask,
      { idempotencyKey: 'task:task-1' },
    );
    const changed = await client.request(
      'task.change_state',
      ChangeTaskStateCommandSchema,
      TaskMutationResultSchema,
      {
        taskId: created.task.id,
        expectedRevision: created.task.revision,
        nextState: 'backlog',
        actor: { kind: 'human', id: 'test' },
      },
    );
    expect(changed.task.revision).toBe(1);
    expect(
      (
        await client.query(
          'task.get',
          GetTaskQuerySchema,
          GetTaskResultSchema,
          { taskId: 'task-1' },
        )
      ).task.state,
    ).toBe('backlog');
    await handle.shutdown('test complete');
    await handle.waitUntilStopped();
  });

  test('deduplicates a channel message, runs an agent, and delivers one reply', async () => {
    home = await mkdtemp(join(tmpdir(), 'apt-e2e-'));
    let onMessage: ChannelMessageHandler | null = null;
    const replies: string[] = [];
    const runner: AgentRunner = {
      name: 'fake',
      run: async (context) => ({
        status: 'succeeded',
        finalText: `done: ${context.objective.instructions}`,
        sessionUpdate: {
          sessionKey: context.session.key,
          expectedRevision: context.session.revision,
          codexThreadId: 'thread-1',
        },
        completionArtifact: null,
        usage: null,
      }),
      health: async () => ({
        status: 'ready',
        runnerName: 'fake',
        checkedAt: new Date().toISOString(),
      }),
      close: async () => undefined,
    };
    const transport: ChannelTransport = {
      name: 'fake',
      connect: async (subscription, handler) => {
        onMessage = handler;
        return {
          subscriptionId: subscription.id,
          health: () => ({
            status: 'connected',
            connectedAt: new Date().toISOString(),
            lastMessageAt: null,
            lastSuccessAt: null,
            lastError: null,
          }),
          close: async () => undefined,
        };
      },
      sendReply: async (_subscription, payload) => {
        replies.push(payload.text);
        return {
          providerMessageId: `reply-${replies.length}`,
          acceptedAt: new Date().toISOString(),
          deduplicated: false,
        };
      },
      health: async () => ({
        status: 'connected',
        connectedAt: new Date().toISOString(),
        lastMessageAt: null,
        lastSuccessAt: null,
        lastError: null,
      }),
      close: async () => undefined,
    };
    handle = await startLocalService(
      { homeDirectory: home, apiPort: 0, logLevel: 'fatal' },
      { runner, transports: { fake: () => transport } },
    );
    const client = new ServiceClient({
      homeDirectory: home,
      serverUrl: handle.address(),
      timeoutMs: 5_000,
    });
    await client.request(
      'agent.add',
      AddAgentCommandSchema,
      AgentMutationResultSchema,
      {
        id: 'front',
        expectedRevision: 0,
        name: 'Front',
        workspacePath: process.cwd(),
        role: 'front',
      },
      { idempotencyKey: 'agent:front' },
    );
    await client.request(
      'channel.add',
      AddChannelCommandSchema,
      ChannelMutationResultSchema,
      {
        id: 'channel-1',
        expectedRevision: 1,
        channelKey: 'room-1',
        transport: 'fake',
        agentId: 'front',
        trigger: { kind: 'all_messages' },
      },
      { idempotencyKey: 'channel:channel-1' },
    );
    expect(onMessage).not.toBeNull();
    const message = ChannelMessageSchema.parse({
      channel: { subscriptionId: 'channel-1', channelKey: 'room-1' },
      sourceSeq: '1',
      sourceEventId: 'event-1',
      sender: { id: 'human-1', displayName: 'Human', isBot: false },
      text: 'ship it',
      mentionedAgentIds: [],
      receivedAt: new Date().toISOString(),
    });
    await onMessage!(message);
    await onMessage!(message);
    const deadline = Date.now() + 3_000;
    while (replies.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(replies).toEqual(['done: ship it']);
  });
});
