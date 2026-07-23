import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ControlPlaneClientError,
  HttpControlPlaneAdapter,
} from '@agent-party-time/control-plane-client';
import type {
  CreateBugCommand,
  CreateEngineeringCommand,
  EngineeringEnvironmentSummary,
} from '@agent-party-time/shared';
import { startControlPlane, type ControlPlaneHandle } from './index.js';
import { ControlPlaneStore } from './store.js';

describe('control plane HTTP interface', () => {
  let home: string | null = null;
  let handle: ControlPlaneHandle | null = null;

  afterEach(async () => {
    await handle?.close();
    if (home) await rm(home, { recursive: true, force: true });
    handle = null;
    home = null;
  });

  test('persists projects and exposes only logical runner state', async () => {
    home = await mkdtemp(join(tmpdir(), 'apt-control-plane-'));
    handle = await startControlPlane({
      homeDirectory: home,
      port: 0,
      runnerOfflineAfterMs: 20_000,
    });
    let client = new HttpControlPlaneAdapter({
      baseUrl: handle.address(),
    });
    const project = await client.createProject(
      { slug: 'checkout', title: '结算服务' },
      'project:checkout',
    );
    const runnerId = '7cc6dca7-26af-41ab-8355-09f8d93c8ec7';
    await client.registerRunner({ runnerId, name: 'Mac mini' });
    const assigned = await client.setProjectDefaultRunner(project.id, runnerId);
    expect(assigned.executable).toBe(true);
    expect(JSON.stringify(assigned)).not.toContain('/Users/');
    const renamed = await client.renameProject(project.id, '结算核心服务');
    expect(renamed.title).toBe('结算核心服务');
    expect(renamed.slug).toBe('checkout');

    await handle.close();
    handle = await startControlPlane({ homeDirectory: home, port: 0 });
    client = new HttpControlPlaneAdapter({ baseUrl: handle.address() });
    const [persisted] = await client.listProjects();
    expect(persisted?.slug).toBe('checkout');
    expect(persisted?.title).toBe('结算核心服务');
    expect(persisted?.defaultRunner?.name).toBe('Mac mini');
  });

  test('deduplicates project creation and rejects key reuse', async () => {
    home = await mkdtemp(join(tmpdir(), 'apt-control-plane-'));
    handle = await startControlPlane({ homeDirectory: home, port: 0 });
    const client = new HttpControlPlaneAdapter({ baseUrl: handle.address() });
    const first = await client.createProject(
      { slug: 'billing', title: null },
      'project:billing',
    );
    const repeated = await client.createProject(
      { slug: 'billing', title: null },
      'project:billing',
    );
    expect(repeated.id).toBe(first.id);
    await expect(
      client.createProject(
        { slug: 'different', title: null },
        'project:billing',
      ),
    ).rejects.toBeInstanceOf(ControlPlaneClientError);
  });

  test('keeps projects private until a developer accepts an owner invitation', async () => {
    home = await mkdtemp(join(tmpdir(), 'apt-control-plane-'));
    handle = await startControlPlane({ homeDirectory: home, port: 0 });
    let owner = new HttpControlPlaneAdapter({
      baseUrl: handle.address(),
      actor: {
        kind: 'user',
        userId: 'user-xujiequan',
        accountType: 'DEVELOPER',
      },
    });
    let developer = new HttpControlPlaneAdapter({
      baseUrl: handle.address(),
      actor: {
        kind: 'user',
        userId: 'user-zhoumingbo',
        accountType: 'DEVELOPER',
      },
    });
    const tester = new HttpControlPlaneAdapter({
      baseUrl: handle.address(),
      actor: {
        kind: 'user',
        userId: 'user-tianguohui',
        accountType: 'TESTER',
      },
    });

    await expect(
      tester.createProject(
        { slug: 'tester-project', title: null },
        'private-project:tester-create',
      ),
    ).rejects.toMatchObject({
      appError: { code: 'project.access_denied' },
    });

    const project = await owner.createProject(
      { slug: 'private-checkout', title: '私密结算项目' },
      'private-project:create',
    );
    expect(project.memberRole).toBe('OWNER');
    expect(await developer.listProjects()).toEqual([]);
    await expect(tester.listProjects()).rejects.toMatchObject({
      appError: { code: 'project.access_denied' },
    });

    const invitation = await owner.createProjectInvitation(
      { projectId: project.id, inviteeUserId: 'user-zhoumingbo' },
      'private-project:invite',
    );
    expect(invitation.status).toBe('PENDING');
    expect(await developer.listProjects()).toEqual([]);
    expect((await developer.listReceivedProjectInvitations())[0]?.id).toBe(
      invitation.id,
    );
    await expect(
      owner.createProjectInvitation(
        { projectId: project.id, inviteeUserId: 'user-zhoumingbo' },
        'private-project:duplicate-invite',
      ),
    ).rejects.toMatchObject({
      appError: { code: 'project.invitation_conflict' },
    });
    await expect(
      tester.respondProjectInvitation(
        { invitationId: invitation.id, action: 'ACCEPT' },
        'private-project:tester-accept',
      ),
    ).rejects.toMatchObject({
      appError: { code: 'project.access_denied' },
    });

    const accepted = await developer.respondProjectInvitation(
      { invitationId: invitation.id, action: 'ACCEPT' },
      'private-project:accept',
    );
    expect(accepted.status).toBe('ACCEPTED');
    expect(
      (
        await developer.respondProjectInvitation(
          { invitationId: invitation.id, action: 'ACCEPT' },
          'private-project:accept',
        )
      ).status,
    ).toBe('ACCEPTED');
    await expect(
      developer.respondProjectInvitation(
        { invitationId: invitation.id, action: 'ACCEPT' },
        'private-project:accept-again',
      ),
    ).rejects.toMatchObject({
      appError: { code: 'project.invitation_invalid' },
    });
    expect((await developer.listProjects())[0]?.memberRole).toBe('DEVELOPER');

    const collaboration = await owner.getProjectCollaboration(project.id);
    expect(collaboration.members.map((member) => member.role)).toEqual([
      'OWNER',
      'DEVELOPER',
    ]);
    expect(collaboration.auditEvents.map((event) => event.type)).toEqual([
      'project.created',
      'project.invitation_created',
      'project.invitation_accepted',
    ]);
    await expect(
      developer.createProjectInvitation(
        { projectId: project.id, inviteeUserId: 'user-tianguohui' },
        'private-project:developer-invite',
      ),
    ).rejects.toMatchObject({
      appError: { code: 'project.access_denied' },
    });

    await handle.close();
    handle = await startControlPlane({ homeDirectory: home, port: 0 });
    owner = new HttpControlPlaneAdapter({
      baseUrl: handle.address(),
      actor: {
        kind: 'user',
        userId: 'user-xujiequan',
        accountType: 'DEVELOPER',
      },
    });
    developer = new HttpControlPlaneAdapter({
      baseUrl: handle.address(),
      actor: {
        kind: 'user',
        userId: 'user-zhoumingbo',
        accountType: 'DEVELOPER',
      },
    });
    expect((await developer.listProjects())[0]?.id).toBe(project.id);
    await owner.removeProjectMember(
      { projectId: project.id, userId: 'user-zhoumingbo' },
      'private-project:remove-member',
    );
    expect(await developer.listProjects()).toEqual([]);
  });

  test('supports rejecting and revoking a pending project invitation', async () => {
    home = await mkdtemp(join(tmpdir(), 'apt-control-plane-'));
    handle = await startControlPlane({ homeDirectory: home, port: 0 });
    const owner = new HttpControlPlaneAdapter({
      baseUrl: handle.address(),
      actor: {
        kind: 'user',
        userId: 'user-xujiequan',
        accountType: 'DEVELOPER',
      },
    });
    const developer = new HttpControlPlaneAdapter({
      baseUrl: handle.address(),
      actor: {
        kind: 'user',
        userId: 'user-zhoumingbo',
        accountType: 'DEVELOPER',
      },
    });
    const project = await owner.createProject(
      { slug: 'invitation-states', title: '邀请状态项目' },
      'invitation-states:create',
    );
    const revokedInvitation = await owner.createProjectInvitation(
      { projectId: project.id, inviteeUserId: 'user-zhoumingbo' },
      'invitation-states:invite-revoke',
    );
    expect(
      (
        await owner.revokeProjectInvitation(
          revokedInvitation.id,
          'invitation-states:revoke',
        )
      ).status,
    ).toBe('REVOKED');
    await expect(
      developer.respondProjectInvitation(
        { invitationId: revokedInvitation.id, action: 'ACCEPT' },
        'invitation-states:accept-revoked',
      ),
    ).rejects.toMatchObject({
      appError: { code: 'project.invitation_invalid' },
    });

    const rejectedInvitation = await owner.createProjectInvitation(
      { projectId: project.id, inviteeUserId: 'user-zhoumingbo' },
      'invitation-states:invite-reject',
    );
    expect(
      (
        await developer.respondProjectInvitation(
          { invitationId: rejectedInvitation.id, action: 'REJECT' },
          'invitation-states:reject',
        )
      ).status,
    ).toBe('REJECTED');
    await expect(
      owner.revokeProjectInvitation(
        rejectedInvitation.id,
        'invitation-states:revoke-rejected',
      ),
    ).rejects.toMatchObject({
      appError: { code: 'project.invitation_invalid' },
    });
  });

  test('manages a private engineering catalog with role-scoped technical configuration', async () => {
    home = await mkdtemp(join(tmpdir(), 'apt-control-plane-'));
    handle = await startControlPlane({ homeDirectory: home, port: 0 });
    let owner = developerClient(handle.address(), 'user-xujiequan');
    let member = developerClient(handle.address(), 'user-zhoumingbo');
    const project = await owner.createProject(
      { slug: 'engineering-catalog', title: '工程目录项目' },
      'engineering-catalog:project',
    );
    const invitation = await owner.createProjectInvitation(
      { projectId: project.id, inviteeUserId: 'user-zhoumingbo' },
      'engineering-catalog:invite',
    );
    await member.respondProjectInvitation(
      { invitationId: invitation.id, action: 'ACCEPT' },
      'engineering-catalog:accept',
    );

    const web = await owner.createEngineering(
      engineeringInput(project.id, {
        slug: 'admin-web',
        displayName: '管理后台 Web',
        type: 'FRONTEND',
        ownerUserId: 'user-xujiequan',
        memberUserIds: ['user-zhoumingbo'],
        deploymentType: 'LOCAL_SCRIPT',
      }),
      'engineering-catalog:web',
    );
    const server = await owner.createEngineering(
      engineeringInput(project.id, {
        slug: 'admin-server',
        displayName: '管理后台服务',
        type: 'BACKEND',
        ownerUserId: 'user-xujiequan',
        memberUserIds: [],
        deploymentType: 'CI_CD',
      }),
      'engineering-catalog:server',
    );
    const memberOwned = await owner.createEngineering(
      engineeringInput(project.id, {
        slug: 'member-service',
        displayName: '成员负责的服务',
        type: 'BACKEND',
        ownerUserId: 'user-zhoumingbo',
        memberUserIds: [],
        deploymentType: 'CI_CD',
      }),
      'engineering-catalog:member-owned',
    );
    await expect(
      owner.createEngineering(
        engineeringInput(project.id, {
          slug: 'admin-web',
          displayName: '重复标识',
          type: 'FRONTEND',
          ownerUserId: 'user-xujiequan',
          memberUserIds: [],
          deploymentType: 'CI_CD',
        }),
        'engineering-catalog:duplicate-slug',
      ),
    ).rejects.toMatchObject({
      appError: { code: 'engineering.slug_conflict' },
    });
    await expect(
      owner.createEngineering(
        {
          ...engineeringInput(project.id, {
            slug: 'tester-owned',
            displayName: '测试账号负责',
            type: 'BACKEND',
            ownerUserId: 'user-xujiequan',
            memberUserIds: [],
            deploymentType: 'CI_CD',
          }),
          ownerUserId: 'user-tianguohui',
        },
        'engineering-catalog:invalid-owner',
      ),
    ).rejects.toMatchObject({
      appError: { code: 'engineering.member_invalid' },
    });
    await expect(
      owner.updateEngineering(
        {
          engineeringId: web.id,
          slug: web.slug,
          displayName: web.displayName,
          type: web.type,
          repositoryUrl: web.repositoryUrl,
          ownerUserId: 'user-xujiequan',
          memberUserIds: ['user-zhoumingbo'],
          environments: [
            {
              ...environmentInput(web.environments[0]!),
              id: server.environments[0]!.id,
            },
          ],
        },
        'engineering-catalog:foreign-environment',
      ),
    ).rejects.toMatchObject({
      appError: {
        code: 'engineering.environment_invalid',
        message: '测试环境“测试环境”不属于当前工程，请刷新后重试',
      },
    });
    const otherProject = await owner.createProject(
      { slug: 'engineering-catalog-other', title: '另一个项目' },
      'engineering-catalog:other-project',
    );
    await owner.createEngineering(
      engineeringInput(otherProject.id, {
        slug: 'admin-web',
        displayName: '复用标识工程',
        type: 'FRONTEND',
        ownerUserId: 'user-xujiequan',
        memberUserIds: [],
        deploymentType: 'CI_CD',
      }),
      'engineering-catalog:reused-slug',
    );

    expect(
      (await owner.listEngineerings(project.id)).map((item) => item.type),
    ).toEqual(['FRONTEND', 'BACKEND', 'BACKEND']);
    const memberCatalog = await member.listEngineerings(project.id);
    expect(memberCatalog.find((item) => item.id === web.id)).toMatchObject({
      memberRole: 'MEMBER',
      canViewTechnicalConfiguration: true,
      canManage: false,
    });
    expect(memberCatalog.find((item) => item.id === server.id)).toMatchObject({
      memberRole: null,
      canViewTechnicalConfiguration: false,
      canManage: false,
    });
    expect((await member.getEngineering(web.id)).repositoryUrl).toBe(
      'https://git.example.com/party/admin-web.git',
    );
    await expect(member.getEngineering(server.id)).rejects.toMatchObject({
      appError: { code: 'engineering.access_denied' },
    });
    await expect(
      member.updateEngineering(
        {
          engineeringId: web.id,
          slug: web.slug,
          displayName: web.displayName,
          type: web.type,
          repositoryUrl: web.repositoryUrl,
          ownerUserId: 'user-xujiequan',
          memberUserIds: ['user-zhoumingbo'],
          environments: web.environments.map(environmentInput),
        },
        'engineering-catalog:member-update',
      ),
    ).rejects.toMatchObject({
      appError: { code: 'engineering.access_denied' },
    });
    const memberOwnedDetail = await member.getEngineering(memberOwned.id);
    expect(
      (
        await member.updateEngineering(
          {
            engineeringId: memberOwnedDetail.id,
            slug: memberOwnedDetail.slug,
            displayName: '成员已更新服务',
            type: memberOwnedDetail.type,
            repositoryUrl: memberOwnedDetail.repositoryUrl,
            ownerUserId: 'user-zhoumingbo',
            memberUserIds: [],
            environments: memberOwnedDetail.environments.map(environmentInput),
          },
          'engineering-catalog:owner-update',
        )
      ).displayName,
    ).toBe('成员已更新服务');
    await expect(
      owner.removeProjectMember(
        { projectId: project.id, userId: 'user-zhoumingbo' },
        'engineering-catalog:remove-active-member',
      ),
    ).rejects.toMatchObject({
      appError: { code: 'project.member_removal_blocked' },
    });

    await handle.close();
    handle = await startControlPlane({ homeDirectory: home, port: 0 });
    owner = developerClient(handle.address(), 'user-xujiequan');
    member = developerClient(handle.address(), 'user-zhoumingbo');
    expect((await owner.getEngineering(web.id)).environments[0]).toMatchObject({
      slug: 'test',
      deploymentType: 'LOCAL_SCRIPT',
      localScriptCommand: 'bun run deploy:test',
      manualConfirmationRequired: false,
    });
    expect((await member.getEngineering(web.id)).members).toHaveLength(2);

    const unused = await owner.createEngineering(
      engineeringInput(project.id, {
        slug: 'unused-tool',
        displayName: '未使用工具',
        type: 'FRONTEND',
        ownerUserId: 'user-xujiequan',
        memberUserIds: [],
        deploymentType: 'CI_CD',
      }),
      'engineering-catalog:unused',
    );
    await owner.deleteEngineering(
      unused.id,
      'engineering-catalog:delete-unused',
    );
    expect(
      (await owner.listEngineerings(project.id)).some(
        (item) => item.id === unused.id,
      ),
    ).toBe(false);
  });

  test('pairs one developer Agent per engineering without exposing local paths', async () => {
    home = await mkdtemp(join(tmpdir(), 'apt-control-plane-binding-'));
    let currentTime = new Date('2026-07-22T08:00:00.000Z');
    handle = await startControlPlane({
      homeDirectory: home,
      port: 0,
      runnerOfflineAfterMs: 20_000,
      now: () => currentTime,
    });
    let owner = developerClient(handle.address(), 'user-xujiequan');
    let member = developerClient(handle.address(), 'user-zhoumingbo');
    let anonymous = new HttpControlPlaneAdapter({ baseUrl: handle.address() });
    const project = await owner.createProject(
      { slug: 'engineering-bindings', title: 'Agent 绑定' },
      'engineering-bindings:project',
    );
    const invitation = await owner.createProjectInvitation(
      { projectId: project.id, inviteeUserId: 'user-zhoumingbo' },
      'engineering-bindings:invite',
    );
    await member.respondProjectInvitation(
      { invitationId: invitation.id, action: 'ACCEPT' },
      'engineering-bindings:accept',
    );
    const web = await owner.createEngineering(
      engineeringInput(project.id, {
        slug: 'binding-web',
        displayName: '绑定前端',
        type: 'FRONTEND',
        ownerUserId: 'user-xujiequan',
        memberUserIds: ['user-zhoumingbo'],
        deploymentType: 'LOCAL_SCRIPT',
      }),
      'engineering-bindings:web',
    );
    const api = await owner.createEngineering(
      engineeringInput(project.id, {
        slug: 'binding-api',
        displayName: '绑定后端',
        type: 'BACKEND',
        ownerUserId: 'user-xujiequan',
        memberUserIds: [],
        deploymentType: 'CI_CD',
      }),
      'engineering-bindings:api',
    );
    const expiredEngineering = await owner.createEngineering(
      engineeringInput(project.id, {
        slug: 'binding-expired',
        displayName: '过期票据工程',
        type: 'FRONTEND',
        ownerUserId: 'user-xujiequan',
        memberUserIds: [],
        deploymentType: 'CI_CD',
      }),
      'engineering-bindings:expired',
    );

    const runnerOne = crypto.randomUUID();
    const firstTicket = await owner.createEngineeringBindingTicket(web.id);
    const competingTicket = await owner.createEngineeringBindingTicket(web.id);
    const first = await anonymous.claimEngineeringBinding({
      ticket: firstTicket.ticket,
      runnerId: runnerOne,
      runnerName: '徐捷泉的 Agent',
      repositoryName: 'zj-soil-web',
    });
    expect(first.engineeringId).toBe(web.id);
    expect(first.repositoryName).toBe('zj-soil-web');
    expect(first.runner.availability).toBe('online');
    await expect(
      anonymous.claimEngineeringBinding({
        ticket: firstTicket.ticket,
        runnerId: runnerOne,
        runnerName: '重复消费',
      }),
    ).rejects.toMatchObject({
      appError: { code: 'engineering.binding_invalid' },
    });
    await expect(
      owner.createEngineeringBindingTicket(web.id),
    ).rejects.toMatchObject({
      appError: { code: 'engineering.binding_conflict' },
    });
    await expect(
      anonymous.claimEngineeringBinding({
        ticket: competingTicket.ticket,
        runnerId: crypto.randomUUID(),
        runnerName: '徐捷泉的新 Agent',
      }),
    ).rejects.toMatchObject({
      appError: { code: 'engineering.binding_conflict' },
    });

    const secondTicket = await owner.createEngineeringBindingTicket(api.id);
    const second = await anonymous.claimEngineeringBinding({
      ticket: secondTicket.ticket,
      runnerId: runnerOne,
      runnerName: '徐捷泉的 Agent',
    });
    expect(second.runner.id).toBe(runnerOne);
    expect(
      JSON.stringify(await owner.listEngineeringBindings(web.id)),
    ).not.toContain('/Users/');

    const memberTicket = await member.createEngineeringBindingTicket(web.id);
    await expect(
      anonymous.claimEngineeringBinding({
        ticket: memberTicket.ticket,
        runnerId: runnerOne,
        runnerName: '冒用 Agent',
      }),
    ).rejects.toMatchObject({
      appError: { code: 'engineering.binding_conflict' },
    });
    const runnerTwo = crypto.randomUUID();
    const memberBinding = await anonymous.claimEngineeringBinding({
      ticket: memberTicket.ticket,
      runnerId: runnerTwo,
      runnerName: '周明波的 Agent',
      repositoryName: 'zj-soil-web',
    });
    expect(memberBinding.developer.id).toBe('user-zhoumingbo');
    expect(memberBinding.repositoryName).toBe('zj-soil-web');
    expect(await owner.listEngineeringBindings(web.id)).toHaveLength(2);
    await expect(
      member.createEngineeringBindingTicket(web.id),
    ).rejects.toMatchObject({
      appError: { code: 'engineering.binding_conflict' },
    });
    await expect(
      member.createEngineeringBindingTicket(api.id),
    ).rejects.toMatchObject({
      appError: { code: 'engineering.access_denied' },
    });

    currentTime = new Date('2026-07-22T08:00:21.000Z');
    expect(
      (await owner.listEngineeringBindings(web.id)).find(
        (binding) => binding.id === first.id,
      )?.runner.availability,
    ).toBe('offline');
    await handle.close();
    handle = await startControlPlane({
      homeDirectory: home,
      port: 0,
      runnerOfflineAfterMs: 20_000,
      now: () => currentTime,
    });
    owner = developerClient(handle.address(), 'user-xujiequan');
    member = developerClient(handle.address(), 'user-zhoumingbo');
    anonymous = new HttpControlPlaneAdapter({ baseUrl: handle.address() });
    const persistedBindings = await owner.listEngineeringBindings(web.id);
    expect(persistedBindings).toHaveLength(2);
    expect(persistedBindings.some((binding) => binding.id === first.id)).toBe(
      true,
    );

    currentTime = new Date('2026-07-22T08:11:00.000Z');
    const expired = await owner.createEngineeringBindingTicket(
      expiredEngineering.id,
    );
    currentTime = new Date('2026-07-22T08:21:01.000Z');
    await expect(
      anonymous.claimEngineeringBinding({
        ticket: expired.ticket,
        runnerId: crypto.randomUUID(),
        runnerName: '过期票据 Agent',
      }),
    ).rejects.toMatchObject({
      appError: { code: 'engineering.binding_invalid' },
    });
  });

  test('rejects sensitive engineering configuration values', async () => {
    home = await mkdtemp(join(tmpdir(), 'apt-control-plane-'));
    handle = await startControlPlane({ homeDirectory: home, port: 0 });
    const owner = developerClient(handle.address(), 'user-xujiequan');
    const project = await owner.createProject(
      { slug: 'engineering-secrets', title: '敏感配置检查' },
      'engineering-secrets:project',
    );
    await expect(
      owner.createEngineering(
        {
          ...engineeringInput(project.id, {
            slug: 'unsafe-command',
            displayName: '不安全命令',
            type: 'FRONTEND',
            ownerUserId: 'user-xujiequan',
            memberUserIds: [],
            deploymentType: 'LOCAL_SCRIPT',
          }),
          environments: [
            {
              slug: 'test',
              displayName: '测试环境',
              deploymentType: 'LOCAL_SCRIPT',
              localScriptCommand: 'TOKEN=plain-text-secret bun run deploy',
            },
          ],
        },
        'engineering-secrets:command',
      ),
    ).rejects.toThrow('部署命令包含疑似明文凭据');
    await expect(
      owner.createEngineering(
        {
          ...engineeringInput(project.id, {
            slug: 'unsafe-repository',
            displayName: '不安全仓库',
            type: 'BACKEND',
            ownerUserId: 'user-xujiequan',
            memberUserIds: [],
            deploymentType: 'CI_CD',
          }),
          repositoryUrl: 'https://user:password@git.example.com/repo.git',
        },
        'engineering-secrets:repository',
      ),
    ).rejects.toThrow('仓库地址不能包含凭据');
    expect(
      JSON.stringify(await owner.listEngineerings(project.id)),
    ).not.toContain('plain-text-secret');
  });

  test('locks referenced engineering slugs, preserves snapshots, and archives used engineering', async () => {
    home = await mkdtemp(join(tmpdir(), 'apt-control-plane-'));
    handle = await startControlPlane({ homeDirectory: home, port: 0 });
    let owner = developerClient(handle.address(), 'user-xujiequan');
    const project = await owner.createProject(
      { slug: 'engineering-history', title: '工程历史' },
      'engineering-history:project',
    );
    const engineering = await owner.createEngineering(
      engineeringInput(project.id, {
        slug: 'history-web',
        displayName: '历史名称',
        type: 'FRONTEND',
        ownerUserId: 'user-xujiequan',
        memberUserIds: [],
        deploymentType: 'LOCAL_SCRIPT',
      }),
      'engineering-history:create',
    );
    await handle.close();
    handle = null;
    const store = await ControlPlaneStore.open(
      join(home, 'control-plane', 'state.sqlite'),
      { attachmentsDirectory: join(home, 'control-plane', 'attachments') },
    );
    const snapshot = store.snapshotEngineeringForSubmission(
      engineering.id,
      engineering.environments[0]!.id,
      developerActor('user-xujiequan'),
    );
    store.close();
    expect(snapshot.displayName).toBe('历史名称');

    handle = await startControlPlane({ homeDirectory: home, port: 0 });
    owner = developerClient(handle.address(), 'user-xujiequan');
    const current = await owner.getEngineering(engineering.id);
    const renamed = await owner.updateEngineering(
      {
        engineeringId: current.id,
        slug: current.slug,
        displayName: '新的显示名称',
        type: current.type,
        repositoryUrl: current.repositoryUrl,
        ownerUserId: 'user-xujiequan',
        memberUserIds: [],
        environments: current.environments.map(environmentInput),
      },
      'engineering-history:rename',
    );
    expect(renamed.displayName).toBe('新的显示名称');
    expect(snapshot.displayName).toBe('历史名称');
    await expect(
      owner.updateEngineering(
        {
          engineeringId: renamed.id,
          slug: 'changed-slug',
          displayName: renamed.displayName,
          type: renamed.type,
          repositoryUrl: renamed.repositoryUrl,
          ownerUserId: 'user-xujiequan',
          memberUserIds: [],
          environments: renamed.environments.map(environmentInput),
        },
        'engineering-history:change-slug',
      ),
    ).rejects.toMatchObject({
      appError: { code: 'engineering.referenced' },
    });
    await expect(
      owner.deleteEngineering(
        engineering.id,
        'engineering-history:delete-referenced',
      ),
    ).rejects.toMatchObject({
      appError: { code: 'engineering.referenced' },
    });
    expect(
      (
        await owner.setEngineeringArchived(
          engineering.id,
          true,
          'engineering-history:archive',
        )
      ).archivedAt,
    ).not.toBeNull();
    expect(await owner.listEngineerings(project.id, false)).toEqual([]);
    expect(
      (
        await owner.setEngineeringArchived(
          engineering.id,
          false,
          'engineering-history:restore',
        )
      ).archivedAt,
    ).toBeNull();
  });

  test('creates, persists, and reads a bug with attachment content', async () => {
    home = await mkdtemp(join(tmpdir(), 'apt-control-plane-'));
    handle = await startControlPlane({ homeDirectory: home, port: 0 });
    let client = new HttpControlPlaneAdapter({ baseUrl: handle.address() });
    const project = await client.createProject(
      { slug: 'checkout', title: '结算服务' },
      'project:checkout',
    );
    const attachmentContent = Buffer.from('{"order":"A-01"}');
    const created = await client.createBug(
      {
        projectId: project.id,
        title: '支付完成后订单仍显示待付款',
        operationPath: '购物车 → 提交订单 → 支付',
        actualResult: '支付成功，但订单状态未更新',
        expectedResult: '订单应显示已付款',
        supplementalDescription: null,
        attachments: [
          {
            fileName: 'response.json',
            mediaType: 'application/json',
            sizeBytes: attachmentContent.byteLength,
            contentBase64: attachmentContent.toString('base64'),
          },
        ],
      },
      'bug:checkout-payment-status',
    );
    expect(created.shortId).toBe('BUG-0001');
    expect(created.status).toBe('waiting_for_repair');
    expect(JSON.stringify(created)).not.toContain(home);
    const attachment = await client.getBugAttachment(
      created.attachments[0]!.id,
    );
    expect(Buffer.from(attachment.contentBase64, 'base64')).toEqual(
      attachmentContent,
    );

    await handle.close();
    handle = await startControlPlane({ homeDirectory: home, port: 0 });
    client = new HttpControlPlaneAdapter({ baseUrl: handle.address() });
    const [persisted] = await client.listBugs(project.id);
    expect(persisted?.title).toBe(created.title);
    expect((await client.getBug(created.id)).events[0]?.type).toBe(
      'bug.created',
    );
  });

  test('rejects an invalid attachment without creating a bug', async () => {
    home = await mkdtemp(join(tmpdir(), 'apt-control-plane-'));
    handle = await startControlPlane({ homeDirectory: home, port: 0 });
    const client = new HttpControlPlaneAdapter({ baseUrl: handle.address() });
    const project = await client.createProject(
      { slug: 'billing', title: null },
      'project:billing',
    );
    await expect(
      client.createBug(
        {
          projectId: project.id,
          title: '账单导出失败',
          operationPath: '账单 → 导出',
          actualResult: '下载失败',
          expectedResult: '应下载文件',
          attachments: [
            {
              fileName: 'evidence.json',
              mediaType: 'application/json',
              sizeBytes: 99,
              contentBase64: Buffer.from('{}').toString('base64'),
            },
          ],
        },
        'bug:invalid-attachment',
      ),
    ).rejects.toBeInstanceOf(ControlPlaneClientError);
    expect(await client.listBugs(project.id)).toHaveLength(0);
  });

  test('keeps a fixed deadline, closes at capacity, and deduplicates enqueue', async () => {
    home = await mkdtemp(join(tmpdir(), 'apt-control-plane-'));
    let currentTime = new Date('2026-07-21T02:00:00.000Z');
    handle = await startControlPlane({
      homeDirectory: home,
      port: 0,
      now: () => currentTime,
      repairDispatchMaxBugs: 3,
      repairDispatchDelayMs: 120_000,
    });
    const client = new HttpControlPlaneAdapter({ baseUrl: handle.address() });
    const { projectId } = await createExecutableProject(client);
    const bugs = await Promise.all(
      [1, 2, 3, 4].map((sequence) =>
        createBug(client, projectId, `倒计时缺陷 ${sequence}`),
      ),
    );

    const first = await client.enqueueBugForRepair(bugs[0]!.id, 'repair:first');
    expect(first.dispatch.closesAt).toBe('2026-07-21T02:02:00.000Z');
    currentTime = new Date('2026-07-21T02:00:30.000Z');
    const [second, repeated] = await Promise.all([
      client.enqueueBugForRepair(bugs[1]!.id, 'repair:second'),
      client.enqueueBugForRepair(bugs[0]!.id, 'repair:first'),
    ]);
    expect(second.dispatch.closesAt).toBe(first.dispatch.closesAt);
    expect(repeated.dispatch.members).toHaveLength(2);

    await client.returnBugToWaiting(bugs[1]!.id, 'repair:return-second');
    const readded = await client.enqueueBugForRepair(
      bugs[1]!.id,
      'repair:readd-second',
    );
    expect(readded.dispatch.members.map((bug) => bug.id)).toEqual(
      bugs.slice(0, 2).map((bug) => bug.id),
    );

    const third = await client.enqueueBugForRepair(bugs[2]!.id, 'repair:third');
    expect(third.dispatch.state).toBe('queued');
    expect(third.dispatch.members.map((bug) => bug.id)).toEqual(
      bugs.slice(0, 3).map((bug) => bug.id),
    );
    const fourth = await client.enqueueBugForRepair(
      bugs[3]!.id,
      'repair:fourth',
    );
    expect(fourth.dispatch.id).not.toBe(first.dispatch.id);
    expect(fourth.dispatch.members).toHaveLength(1);
    expect(fourth.dispatch.config).toEqual({ maxBugs: 3, delayMs: 120_000 });
  });

  test('persists countdown and uses a config snapshot after restart', async () => {
    home = await mkdtemp(join(tmpdir(), 'apt-control-plane-'));
    let currentTime = new Date('2026-07-21T03:00:00.000Z');
    handle = await startControlPlane({
      homeDirectory: home,
      port: 0,
      now: () => currentTime,
      repairDispatchDelayMs: 120_000,
    });
    let client = new HttpControlPlaneAdapter({ baseUrl: handle.address() });
    const { projectId } = await createExecutableProject(client);
    const firstBug = await createBug(client, projectId, '重启前缺陷');
    const secondBug = await createBug(client, projectId, '重启后缺陷');
    const original = await client.enqueueBugForRepair(
      firstBug.id,
      'repair:before-restart',
    );

    await handle.close();
    currentTime = new Date('2026-07-21T03:01:59.000Z');
    handle = await startControlPlane({
      homeDirectory: home,
      port: 0,
      now: () => currentTime,
      repairDispatchDelayMs: 10_000,
    });
    client = new HttpControlPlaneAdapter({ baseUrl: handle.address() });
    let [persisted] = await client.listRepairDispatches(projectId);
    expect(persisted?.state).toBe('collecting');
    expect(persisted?.closesAt).toBe(original.dispatch.closesAt);
    expect(persisted?.config.delayMs).toBe(120_000);

    currentTime = new Date('2026-07-21T03:02:01.000Z');
    [persisted] = await client.listRepairDispatches(projectId);
    expect(persisted?.state).toBe('queued');
    const next = await client.enqueueBugForRepair(
      secondBug.id,
      'repair:after-restart',
    );
    expect(next.dispatch.config.delayMs).toBe(10_000);
    expect(next.dispatch.closesAt).toBe('2026-07-21T03:02:11.000Z');
  });

  test('supports immediate close, queued removal, and one claimed group per runner', async () => {
    home = await mkdtemp(join(tmpdir(), 'apt-control-plane-'));
    handle = await startControlPlane({ homeDirectory: home, port: 0 });
    const client = new HttpControlPlaneAdapter({ baseUrl: handle.address() });
    const { projectId, runnerId } = await createExecutableProject(client);
    const bugs = await Promise.all(
      [1, 2, 3].map((sequence) =>
        createBug(client, projectId, `队列缺陷 ${sequence}`),
      ),
    );
    const first = await client.enqueueBugForRepair(bugs[0]!.id, 'queue:1');
    await client.enqueueBugForRepair(bugs[1]!.id, 'queue:2');
    const closed = await client.closeRepairDispatch(
      first.dispatch.id,
      'close:first',
    );
    expect(closed.state).toBe('queued');
    const removed = await client.returnBugToWaiting(
      bugs[1]!.id,
      'return:second',
    );
    expect(removed.bug.status).toBe('waiting_for_repair');
    expect(removed.dispatch?.members.map((bug) => bug.id)).toEqual([
      bugs[0]!.id,
    ]);

    const second = await client.enqueueBugForRepair(bugs[2]!.id, 'queue:3');
    await client.closeRepairDispatch(second.dispatch.id, 'close:second');
    const claimed = await client.claimRepairDispatch(runnerId);
    const repeatedClaim = await client.claimRepairDispatch(runnerId);
    expect(claimed?.id).toBe(first.dispatch.id);
    expect(repeatedClaim?.id).toBe(claimed?.id);
    expect(
      (await client.listRepairDispatches(projectId)).find(
        (dispatch) => dispatch.id === second.dispatch.id,
      )?.state,
    ).toBe('queued');
    await expect(
      client.returnBugToWaiting(bugs[0]!.id, 'return:claimed'),
    ).rejects.toBeInstanceOf(ControlPlaneClientError);
  });

  test('executes a claimed repair dispatch with versioned attempts and durable results', async () => {
    home = await mkdtemp(join(tmpdir(), 'apt-control-plane-'));
    handle = await startControlPlane({
      homeDirectory: home,
      port: 0,
      repairInfrastructureRetries: 0,
    });
    let client = new HttpControlPlaneAdapter({ baseUrl: handle.address() });
    const { projectId, runnerId } = await createExecutableProject(client);
    const first = await createBug(client, projectId, '可修复缺陷');
    const second = await createBug(client, projectId, '无法安全修复的缺陷');
    const queued = await client.enqueueBugForRepair(
      first.id,
      `repair:${crypto.randomUUID()}`,
    );
    await client.enqueueBugForRepair(
      second.id,
      `repair:${crypto.randomUUID()}`,
    );
    await client.closeRepairDispatch(
      queued.dispatch.id,
      `close:${crypto.randomUUID()}`,
    );

    const claim = await client.acquireRepairDispatch(runnerId);
    expect(claim).not.toBeNull();
    expect(claim?.items).toHaveLength(2);
    expect(new Set(claim?.items.map((item) => item.attemptId)).size).toBe(2);
    expect(claim?.items[0]?.prompt.templateName).toBe('bug-repair-start');
    expect(claim?.items[0]?.prompt.templateVersion).toBe('1.0.0');
    expect(claim?.items[0]?.prompt.text).toContain('{{REPOSITORY_PATH}}');
    expect(claim?.items[0]?.prompt.text).not.toContain(home);
    await expect(
      client.renewRepairDispatchLease({
        runnerId,
        dispatchId: claim!.dispatch.id,
        leaseToken: 'x'.repeat(24),
      }),
    ).rejects.toBeInstanceOf(ControlPlaneClientError);

    const firstItem = claim!.items[0]!;
    const secondItem = claim!.items[1]!;
    const started = await client.startRepairAttempt({
      runnerId,
      dispatchId: claim!.dispatch.id,
      attemptId: firstItem.attemptId,
      leaseToken: claim!.leaseToken,
    });
    expect(started.attempt.state).toBe('running');
    expect(started.bug.repairState).toBe('running');
    const firstFinished = await client.finishRepairAttempt({
      runnerId,
      dispatchId: claim!.dispatch.id,
      attemptId: firstItem.attemptId,
      leaseToken: claim!.leaseToken,
      outcome: {
        kind: 'result',
        sessionId: 'session-ready',
        result: {
          status: 'ready',
          summary: '缺陷已修复',
          changes: [{ path: 'src/fix.ts', summary: '修正状态更新' }],
          checks: [{ name: 'unit', status: 'passed', summary: '通过' }],
          candidateCommit: 'deadbeef',
        },
      },
    });
    expect(firstFinished.bug.status).toBe('repair_ready');
    expect(firstFinished.dispatchCompleted).toBe(false);

    await client.startRepairAttempt({
      runnerId,
      dispatchId: claim!.dispatch.id,
      attemptId: secondItem.attemptId,
      leaseToken: claim!.leaseToken,
    });
    const secondFinished = await client.finishRepairAttempt({
      runnerId,
      dispatchId: claim!.dispatch.id,
      attemptId: secondItem.attemptId,
      leaseToken: claim!.leaseToken,
      outcome: {
        kind: 'execution_failure',
        sessionId: 'session-failed',
        message: 'Codex CLI 最终结果无法解析',
      },
    });
    expect(secondFinished.bug.status).toBe('repairing');
    expect(secondFinished.bug.repairState).toBe('failed');
    expect(secondFinished.dispatchCompleted).toBe(true);

    const readyDetail = await client.getBug(first.id);
    const failedDetail = await client.getBug(second.id);
    expect(readyDetail.repairAttempt).toMatchObject({
      state: 'ready',
      templateName: 'bug-repair-start',
      templateVersion: '1.0.0',
      sessionId: 'session-ready',
      result: { status: 'ready', candidateCommit: 'deadbeef' },
    });
    expect(failedDetail.repairAttempt).toMatchObject({
      state: 'failed',
      sessionId: 'session-failed',
      failureMessage: 'Codex CLI 最终结果无法解析',
      result: null,
    });
    expect(await client.listRepairDispatches(projectId)).toEqual([]);
    const queuedAfterCompletion = await createBug(
      client,
      projectId,
      '等待重启恢复的缺陷',
    );
    const queuedDispatch = await client.enqueueBugForRepair(
      queuedAfterCompletion.id,
      `repair:${crypto.randomUUID()}`,
    );
    await client.closeRepairDispatch(
      queuedDispatch.dispatch.id,
      `close:${crypto.randomUUID()}`,
    );

    await handle.close();
    handle = await startControlPlane({ homeDirectory: home, port: 0 });
    client = new HttpControlPlaneAdapter({ baseUrl: handle.address() });
    expect((await client.getBug(first.id)).repairAttempt).toMatchObject({
      state: 'ready',
      sessionId: 'session-ready',
      result: { status: 'ready', candidateCommit: 'deadbeef' },
    });
    expect(
      (await client.listRepairDispatches(projectId)).find(
        (dispatch) => dispatch.id === queuedDispatch.dispatch.id,
      )?.state,
    ).toBe('queued');
  });

  test('keeps resume context isolated per bug inside one repair dispatch', async () => {
    home = await mkdtemp(join(tmpdir(), 'apt-control-plane-'));
    handle = await startControlPlane({
      homeDirectory: home,
      port: 0,
      repairInfrastructureRetries: 0,
    });
    const client = new HttpControlPlaneAdapter({ baseUrl: handle.address() });
    const { projectId, runnerId } = await createExecutableProject(client);
    const continuedBug = await createBug(client, projectId, '需要补充的缺陷');
    const ordinaryBug = await createBug(client, projectId, '新的普通缺陷');
    const firstDispatch = await client.enqueueBugForRepair(
      continuedBug.id,
      'repair:continued:first',
    );
    await client.closeRepairDispatch(
      firstDispatch.dispatch.id,
      'repair:continued:close',
    );
    const firstClaim = await client.acquireRepairDispatch(runnerId);
    const firstItem = firstClaim!.items[0]!;
    await client.startRepairAttempt({
      runnerId,
      dispatchId: firstClaim!.dispatch.id,
      attemptId: firstItem.attemptId,
      leaseToken: firstClaim!.leaseToken,
    });
    await client.finishRepairAttempt({
      runnerId,
      dispatchId: firstClaim!.dispatch.id,
      attemptId: firstItem.attemptId,
      leaseToken: firstClaim!.leaseToken,
      outcome: {
        kind: 'result',
        sessionId: 'session-continued',
        result: {
          status: 'needs_input',
          summary: '需要更多信息',
          reason: '缺少稳定复现条件',
          changes: [],
          checks: [],
        },
      },
    });

    const continued = await client.continueBugRepair(
      {
        bugId: continuedBug.id,
        feedback: '仅属于续修 Bug 的补充信息',
        reassign: false,
      },
      'repair:continued:resume',
    );
    const ordinary = await client.enqueueBugForRepair(
      ordinaryBug.id,
      'repair:ordinary',
    );
    expect(ordinary.dispatch.id).toBe(continued.dispatch.id);
    await client.closeRepairDispatch(
      continued.dispatch.id,
      'repair:mixed:close',
    );

    const mixedClaim = await client.acquireRepairDispatch(runnerId);
    const continuedItem = mixedClaim!.items.find(
      (item) => item.bug.id === continuedBug.id,
    );
    const ordinaryItem = mixedClaim!.items.find(
      (item) => item.bug.id === ordinaryBug.id,
    );
    expect(continuedItem?.prompt.templateName).toBe('bug-repair-resume');
    expect(continuedItem?.resumeSessionId).toBe('session-continued');
    expect(continuedItem?.prompt.text).toContain('仅属于续修 Bug 的补充信息');
    expect(ordinaryItem?.prompt.templateName).toBe('bug-repair-start');
    expect(ordinaryItem?.resumeSessionId).toBeNull();
    expect(ordinaryItem?.prompt.text).not.toContain(
      '仅属于续修 Bug 的补充信息',
    );
  });

  test('enforces the five attachment limit across the full bug history', async () => {
    home = await mkdtemp(join(tmpdir(), 'apt-control-plane-'));
    handle = await startControlPlane({ homeDirectory: home, port: 0 });
    const client = new HttpControlPlaneAdapter({ baseUrl: handle.address() });
    const { projectId, runnerId } = await createExecutableProject(client);
    const evidence = Buffer.from('evidence');
    const bug = await client.createBug(
      {
        projectId,
        title: '附件上限缺陷',
        operationPath: '打开页面并操作',
        actualResult: '出现错误',
        expectedResult: '操作成功',
        attachments: Array.from({ length: 5 }, (_, index) => ({
          fileName: `evidence-${index}.txt`,
          mediaType: 'text/plain' as const,
          sizeBytes: evidence.byteLength,
          contentBase64: evidence.toString('base64'),
        })),
      },
      'bug:attachment-limit',
    );
    const dispatch = await client.enqueueBugForRepair(
      bug.id,
      'attachment:repair',
    );
    await client.closeRepairDispatch(dispatch.dispatch.id, 'attachment:close');
    const claim = await client.acquireRepairDispatch(runnerId);
    const item = claim!.items[0]!;
    await client.startRepairAttempt({
      runnerId,
      dispatchId: claim!.dispatch.id,
      attemptId: item.attemptId,
      leaseToken: claim!.leaseToken,
    });
    await client.finishRepairAttempt({
      runnerId,
      dispatchId: claim!.dispatch.id,
      attemptId: item.attemptId,
      leaseToken: claim!.leaseToken,
      outcome: {
        kind: 'result',
        sessionId: 'attachment-session',
        result: {
          status: 'ready',
          summary: '已修复',
          changes: [],
          checks: [],
          candidateCommit: 'deadbeef',
        },
      },
    });
    const deployment = await client.enqueueBugForDeployment(
      bug.id,
      'attachment:deployment',
    );
    await client.closeDeploymentBatch(
      deployment.batch.id,
      'attachment:deployment:close',
    );
    const deploymentClaim = await client.acquireDeploymentBatch(runnerId);
    await client.startDeploymentAttempt({
      runnerId,
      batchId: deploymentClaim!.batch.id,
      attemptId: deploymentClaim!.attemptId,
      leaseToken: deploymentClaim!.leaseToken,
    });
    await client.finishDeploymentAttempt({
      runnerId,
      batchId: deploymentClaim!.batch.id,
      attemptId: deploymentClaim!.attemptId,
      leaseToken: deploymentClaim!.leaseToken,
      outcome: {
        kind: 'result',
        sessionId: 'deployment-session',
        result: {
          status: 'deployed',
          summary: '已部署到测试环境',
          checks: [],
          reason: null,
          deployedCommit: 'cafebabe',
        },
      },
    });

    await expect(
      client.verifyBugFailed(
        {
          bugId: bug.id,
          feedback: '仍然可复现',
          attachments: [
            {
              fileName: 'extra.txt',
              mediaType: 'text/plain',
              sizeBytes: evidence.byteLength,
              contentBase64: evidence.toString('base64'),
            },
          ],
        },
        'attachment:verify',
      ),
    ).rejects.toBeInstanceOf(ControlPlaneClientError);
    const detail = await client.getBug(bug.id);
    expect(detail.attachments).toHaveLength(5);
    expect(detail.verificationFeedbacks).toHaveLength(0);
    expect(detail.status).toBe('waiting_for_verification');

    const verified = await client.verifyBugFailed(
      {
        bugId: bug.id,
        feedback: '仍然可复现，请继续修复',
        attachments: [],
      },
      'attachment:verify:without-new-attachment',
    );
    expect(verified.bug.status).toBe('repairing');
    const verifiedDetail = await client.getBug(bug.id);
    expect(verifiedDetail.verificationFeedbacks).toHaveLength(1);
    await client.closeRepairDispatch(
      verified.dispatch.id,
      'attachment:verify:close',
    );
    const resumedClaim = await client.acquireRepairDispatch(runnerId);
    const resumedItem = resumedClaim!.items[0]!;
    expect(resumedItem.resumeSessionId).toBe('attachment-session');
    expect(resumedItem.sourceDeployedCommit).toBe('cafebabe');
    expect(resumedItem.prompt.templateName).toBe('bug-repair-resume');
    expect(resumedItem.prompt.text).toContain('仍然可复现，请继续修复');
    expect(resumedItem.prompt.text).toContain('cafebabe');

    await client.startRepairAttempt({
      runnerId,
      dispatchId: resumedClaim!.dispatch.id,
      attemptId: resumedItem.attemptId,
      leaseToken: resumedClaim!.leaseToken,
    });
    await client.finishRepairAttempt({
      runnerId,
      dispatchId: resumedClaim!.dispatch.id,
      attemptId: resumedItem.attemptId,
      leaseToken: resumedClaim!.leaseToken,
      outcome: {
        kind: 'result',
        sessionId: 'attachment-session',
        result: {
          status: 'ready',
          summary: '续修完成',
          changes: [],
          checks: [],
          candidateCommit: 'feedface',
        },
      },
    });
    const redeployment = await client.enqueueBugForDeployment(
      bug.id,
      'attachment:redeployment',
    );
    await client.closeDeploymentBatch(
      redeployment.batch.id,
      'attachment:redeployment:close',
    );
    const redeploymentClaim = await client.acquireDeploymentBatch(runnerId);
    await client.startDeploymentAttempt({
      runnerId,
      batchId: redeploymentClaim!.batch.id,
      attemptId: redeploymentClaim!.attemptId,
      leaseToken: redeploymentClaim!.leaseToken,
    });
    await client.finishDeploymentAttempt({
      runnerId,
      batchId: redeploymentClaim!.batch.id,
      attemptId: redeploymentClaim!.attemptId,
      leaseToken: redeploymentClaim!.leaseToken,
      outcome: {
        kind: 'result',
        sessionId: 'redeployment-session',
        result: {
          status: 'deployed',
          summary: '已重新部署到测试环境',
          checks: [],
          reason: null,
          deployedCommit: 'facefeed',
        },
      },
    });
    await client.verifyBugPassed(bug.id, 'attachment:verify:passed');
    expect((await client.getBug(bug.id)).canReopenRepair).toBe(false);
    await expect(
      client.continueBugRepair(
        {
          bugId: bug.id,
          feedback: '尚未清理时不能重开',
          reassign: false,
        },
        'attachment:reopen:before-cleanup',
      ),
    ).rejects.toBeInstanceOf(ControlPlaneClientError);
    await client.finishCleanup(
      {
        runnerId,
        kind: 'bug',
        id: bug.id,
        success: true,
        summary: '本地上下文已清理',
        sessionId: 'cleanup-session',
      },
      'attachment:cleanup',
    );
    expect((await client.getBug(bug.id)).canReopenRepair).toBe(true);
    const reopened = await client.continueBugRepair(
      {
        bugId: bug.id,
        feedback: '清理后重开原 Bug',
        reassign: false,
      },
      'attachment:reopen',
    );
    await client.closeRepairDispatch(
      reopened.dispatch.id,
      'attachment:reopen:close',
    );
    const reopenedClaim = await client.acquireRepairDispatch(runnerId);
    expect(reopenedClaim!.items[0]!.resumeSessionId).toBeNull();
    expect((await client.getBug(bug.id)).canReopenRepair).toBe(false);
    const reopenedItem = reopenedClaim!.items[0]!;
    await client.startRepairAttempt({
      runnerId,
      dispatchId: reopenedClaim!.dispatch.id,
      attemptId: reopenedItem.attemptId,
      leaseToken: reopenedClaim!.leaseToken,
    });
    await client.finishRepairAttempt({
      runnerId,
      dispatchId: reopenedClaim!.dispatch.id,
      attemptId: reopenedItem.attemptId,
      leaseToken: reopenedClaim!.leaseToken,
      outcome: {
        kind: 'result',
        sessionId: 'session-after-cleanup',
        result: {
          status: 'ready',
          summary: '重开修复完成',
          changes: [],
          checks: [],
          candidateCommit: 'abcdef1',
        },
      },
    });
    const reopenedDeployment = await client.enqueueBugForDeployment(
      bug.id,
      'attachment:reopen:deployment',
    );
    await client.closeDeploymentBatch(
      reopenedDeployment.batch.id,
      'attachment:reopen:deployment:close',
    );
    const reopenedDeploymentClaim =
      await client.acquireDeploymentBatch(runnerId);
    await client.startDeploymentAttempt({
      runnerId,
      batchId: reopenedDeploymentClaim!.batch.id,
      attemptId: reopenedDeploymentClaim!.attemptId,
      leaseToken: reopenedDeploymentClaim!.leaseToken,
    });
    await client.finishDeploymentAttempt({
      runnerId,
      batchId: reopenedDeploymentClaim!.batch.id,
      attemptId: reopenedDeploymentClaim!.attemptId,
      leaseToken: reopenedDeploymentClaim!.leaseToken,
      outcome: {
        kind: 'result',
        sessionId: 'deployment-after-cleanup',
        result: {
          status: 'deployed',
          summary: '重开修复已部署到测试环境',
          checks: [],
          reason: null,
          deployedCommit: 'abcdef2',
        },
      },
    });
    await client.verifyBugPassed(bug.id, 'attachment:reopen:verify');
    const completedAgain = await client.getBug(bug.id);
    expect(completedAgain.repairAttempts).toHaveLength(3);
    expect(completedAgain.canReopenRepair).toBe(false);
    expect(
      (await client.listCleanupTargets(runnerId)).some(
        (target) => target.kind === 'bug' && target.id === bug.id,
      ),
    ).toBe(true);
    await client.finishCleanup(
      {
        runnerId,
        kind: 'bug',
        id: bug.id,
        success: true,
        summary: '新一代本地上下文已清理',
        sessionId: 'cleanup-session-second',
      },
      'attachment:cleanup:second',
    );
    expect((await client.getBug(bug.id)).canReopenRepair).toBe(true);
  });

  test('loads repair dispatch config from env before the backend file', async () => {
    home = await mkdtemp(join(tmpdir(), 'apt-control-plane-'));
    await mkdir(join(home, 'control-plane'), { recursive: true });
    await writeFile(
      join(home, 'control-plane', 'config.json'),
      JSON.stringify({ repairDispatch: { maxBugs: 2, delayMs: 5_000 } }),
    );
    handle = await startControlPlane({
      homeDirectory: home,
      port: 0,
      env: {
        AGENT_PARTY_TIME_REPAIR_DISPATCH_MAX_BUGS: '3',
        AGENT_PARTY_TIME_REPAIR_DISPATCH_DELAY_MS: '7000',
      },
    });
    const client = new HttpControlPlaneAdapter({ baseUrl: handle.address() });
    const { projectId } = await createExecutableProject(client);
    const bug = await createBug(client, projectId, '配置优先级缺陷');
    const result = await client.enqueueBugForRepair(bug.id, 'repair:config');
    expect(result.dispatch.config).toEqual({ maxBugs: 3, delayMs: 7_000 });
  });
});

async function createExecutableProject(client: HttpControlPlaneAdapter) {
  const project = await client.createProject(
    { slug: `project-${crypto.randomUUID().slice(0, 8)}`, title: null },
    `project:${crypto.randomUUID()}`,
  );
  const runnerId = crypto.randomUUID();
  await client.registerRunner({ runnerId, name: 'Test Runner' });
  await client.setProjectDefaultRunner(project.id, runnerId);
  return { projectId: project.id, runnerId };
}

function developerActor(userId: 'user-xujiequan' | 'user-zhoumingbo') {
  return { kind: 'user', userId, accountType: 'DEVELOPER' } as const;
}

function developerClient(
  baseUrl: string,
  userId: 'user-xujiequan' | 'user-zhoumingbo',
) {
  return new HttpControlPlaneAdapter({
    baseUrl,
    actor: developerActor(userId),
  });
}

function engineeringInput(
  projectId: string,
  options: {
    slug: string;
    displayName: string;
    type: 'FRONTEND' | 'BACKEND';
    ownerUserId: 'user-xujiequan' | 'user-zhoumingbo';
    memberUserIds: Array<'user-xujiequan' | 'user-zhoumingbo'>;
    deploymentType: 'LOCAL_SCRIPT' | 'CI_CD';
  },
): CreateEngineeringCommand {
  return {
    projectId,
    slug: options.slug,
    displayName: options.displayName,
    type: options.type,
    repositoryUrl: `https://git.example.com/party/${options.slug}.git`,
    ownerUserId: options.ownerUserId,
    memberUserIds: options.memberUserIds,
    environments: [
      {
        slug: 'test',
        displayName: '测试环境',
        deploymentType: options.deploymentType,
        localScriptCommand:
          options.deploymentType === 'LOCAL_SCRIPT'
            ? 'bun run deploy:test'
            : null,
      },
    ],
  };
}

function environmentInput(environment: EngineeringEnvironmentSummary) {
  return {
    id: environment.id,
    slug: environment.slug,
    displayName: environment.displayName,
    deploymentType: environment.deploymentType,
    localScriptCommand: environment.localScriptCommand,
  };
}

async function createBug(
  client: HttpControlPlaneAdapter,
  projectId: string,
  title: string,
) {
  const input: CreateBugCommand = {
    projectId,
    title,
    operationPath: '打开页面并操作',
    actualResult: '出现错误',
    expectedResult: '操作成功',
    attachments: [],
  };
  return client.createBug(input, `bug:${crypto.randomUUID()}`);
}
