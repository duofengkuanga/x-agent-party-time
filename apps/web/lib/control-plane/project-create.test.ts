import { describe, expect, test } from 'bun:test';
import { ProjectSlugSchema } from '@agent-party-time/shared/control-plane';
import {
  prepareProjectCreation,
  projectInvitationIdempotencyKey,
} from './project-create';

describe('prepareProjectCreation', () => {
  test('preserves an explicitly supplied project slug', async () => {
    const prepared = await prepareProjectCreation(
      { slug: 'checkout', title: null },
      'project:checkout',
    );

    expect(prepared.command).toEqual({ slug: 'checkout', title: null });
    expect(prepared.inviteeUserIds).toEqual([]);
  });

  test('generates a stable valid slug when only the project title is supplied', async () => {
    const first = await prepareProjectCreation(
      { title: '结算服务', inviteeUserIds: ['user-zhoumingbo'] },
      'web-project:stable',
    );
    const repeated = await prepareProjectCreation(
      { title: '结算服务', inviteeUserIds: ['user-zhoumingbo'] },
      'web-project:stable',
    );

    expect(first.command.slug).toBe(repeated.command.slug);
    expect(ProjectSlugSchema.safeParse(first.command.slug).success).toBe(true);
    expect(first.inviteeUserIds).toEqual(['user-zhoumingbo']);
  });

  test('requires either a project name or an explicit slug', async () => {
    await expect(
      prepareProjectCreation({ title: '', slug: '' }, 'web-project:empty'),
    ).rejects.toThrow('请填写项目名称');
  });

  test('rejects duplicate invitees', async () => {
    await expect(
      prepareProjectCreation(
        {
          title: '结算服务',
          inviteeUserIds: ['user-zhoumingbo', 'user-zhoumingbo'],
        },
        'web-project:duplicates',
      ),
    ).rejects.toThrow('受邀开发人员不能重复');
  });
});

describe('projectInvitationIdempotencyKey', () => {
  test('is stable per project request and invitee', async () => {
    const first = await projectInvitationIdempotencyKey(
      'web-project:stable',
      'user-zhoumingbo',
    );
    const repeated = await projectInvitationIdempotencyKey(
      'web-project:stable',
      'user-zhoumingbo',
    );
    const another = await projectInvitationIdempotencyKey(
      'web-project:stable',
      'user-another',
    );

    expect(first).toBe(repeated);
    expect(first).not.toBe(another);
    expect(first.length).toBeLessThanOrEqual(200);
  });
});
