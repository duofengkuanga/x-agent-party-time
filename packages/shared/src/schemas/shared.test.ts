import { describe, expect, test } from 'bun:test';
import {
  DurableEventSchema,
  EVENT_NAMES,
  EventNameSchema,
  PROMPT_TEMPLATES,
  PROTOCOL_VERSION,
  ServiceConfigSchema,
  TaskRecordSchema,
} from '../index.js';

describe('shared domain schemas', () => {
  test('rejects duplicate config identities and dangling subscriptions', () => {
    const result = ServiceConfigSchema.safeParse({
      agents: [
        { id: 'a', name: 'A', workspacePath: '/tmp' },
        { id: 'a', name: 'Again', workspacePath: '/tmp' },
      ],
      subscriptions: [
        { id: 's', channelKey: 'c', transport: 'fake', agentId: 'missing' },
      ],
    });
    expect(result.success).toBe(false);
  });

  test('enforces completion state invariants', () => {
    const result = TaskRecordSchema.safeParse({
      id: 'task',
      title: 'Task',
      state: 'done',
      creator: { kind: 'human', id: 'me' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  test('every registered event name has a durable event variant', () => {
    for (const name of Object.values(EVENT_NAMES))
      expect(EventNameSchema.parse(name)).toBe(name);
    expect(
      DurableEventSchema.parse({
        schema: PROTOCOL_VERSION,
        id: 'event',
        name: EVENT_NAMES.serviceStarted,
        occurredAt: new Date().toISOString(),
        correlationId: 'correlation',
        causationId: null,
        payload: { instanceId: 'instance' },
      }).name,
    ).toBe(EVENT_NAMES.serviceStarted);
  });

  test('deployment prompts prohibit production side effects', () => {
    for (const name of ['deployment-start', 'deployment-resume']) {
      const template = PROMPT_TEMPLATES.find((item) => item.name === name);
      expect(template?.text).toContain('非生产');
      expect(template?.text).toContain('禁止访问或变更生产环境');
      expect(template?.text).toContain('blocked');
    }
  });
});
