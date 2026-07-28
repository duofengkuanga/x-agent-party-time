import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const pagePath = join(import.meta.dir, 'page.tsx');
const controlsPath = join(import.meta.dir, 'project-settings-controls.tsx');
const effectsPath = join(import.meta.dir, 'project-dialog-effects.tsx');
const cssPath = join(import.meta.dir, '../cooking.css');
const engineeringActionsPath = join(
  import.meta.dir,
  '../../../features/cooking/engineering/presentation/actions.ts',
);
const actionsPath = join(
  import.meta.dir,
  '../../../features/cooking/projects/presentation/actions.ts',
);

describe('项目与工程交互基线', () => {
  test('项目页保留 main 的主操作层级，不增加独立返回入口', async () => {
    const page = await readFile(pagePath, 'utf8');
    const controls = await readFile(controlsPath, 'utf8');
    expect(page).not.toContain('返回提测');
    expect(page).toContain('>提测</Link>');
    expect(controls).not.toContain('project-settings__quiet-action');
    expect(controls).toContain("{showCreate ? '取消' : '新建项目'}");
  });

  test('新建项目显式展开，并继续提交当前 Project 接口字段', async () => {
    const controls = await readFile(controlsPath, 'utf8');
    expect(controls).toContain('useState(false)');
    expect(controls).toContain('action={createProjectAction}');
    expect(controls).toContain('name="name"');
    expect(controls).not.toContain('name="slug"');
    expect(controls).toContain('showCreate ? null');
  });

  test('项目名称修改使用独立项目设置弹窗，不混入成员与邀请', async () => {
    const page = await readFile(pagePath, 'utf8');
    const actions = await readFile(actionsPath, 'utf8');
    const collaboration = page
      .split('function CollaborationDialog')[1]
      .split('function ProjectSettingsDialog')[0];
    expect(page).toContain("settingsHref(project.id, 'project')");
    expect(page).toContain("panel === 'project'");
    expect(page).toContain('function ProjectSettingsDialog');
    expect(page).toContain('保存项目名称');
    expect(collaboration).not.toContain('updateProjectAction');
    expect(collaboration).not.toContain('<span>项目名称</span>');
    expect(actions).toContain("projectSettingsPath(projectId, 'project')");
  });

  test('邀请通知恢复到账户区域并保留独立邀请弹窗深链', async () => {
    const page = await readFile(pagePath, 'utf8');
    const controls = await readFile(controlsPath, 'utf8');
    const actions = await readFile(actionsPath, 'utf8');
    expect(controls).toContain(
      "'.collab-topbar__actions .collab-account-menu'",
    );
    expect(controls).toContain('createPortal(accountNotifications');
    expect(page).toContain('collab-account-menu__notifications');
    expect(controls).toContain('collab-account-menu__count');
    expect(page).toContain('returnTo="/cooking/projects"');
    expect(page).toContain("panel === 'invitations'");
    expect(actions).toContain('invitationReturnPath');
  });

  test('成员和工程操作继续使用独立弹窗层级', async () => {
    const page = await readFile(pagePath, 'utf8');
    const effects = await readFile(effectsPath, 'utf8');
    expect(page).toContain('· 成员与邀请');
    expect(page).toContain("engineeringId === 'new'");
    expect(page).toContain('<EngineeringCreateForm');
    expect(page).toContain('projectMembers={members}');
    expect(page).toContain('name="environmentName"');
    expect(page).toContain('name="memberUserId"');
    expect(page).toContain("mode === 'edit'");
    expect(page).not.toContain('name="repositoryUrl"');
    expect(page).toContain('等待首次本机 Runner 绑定确认仓库');
    expect(page).toContain(
      '<DialogFeedback error={error} success={success} />',
    );
    expect(effects).toContain("event.key === 'Escape'");
    expect(effects).toContain('event.target === overlay');
    expect(page).toContain('tabIndex={-1}');
    expect(effects).toContain("document.body.style.overflow = 'hidden'");
  });
  test('新建工程沿用当前领域模型并一次提交成员与首个环境', async () => {
    const page = await readFile(pagePath, 'utf8');
    const actions = await readFile(engineeringActionsPath, 'utf8');
    expect(page).toContain('creatorMembershipMutationId');
    expect(page).toContain('environmentMutationId');
    expect(page).toContain('工程成员 / 选填');
    expect(page).toContain('首个测试环境与更新方式');
    expect(actions).toContain('createEngineeringSetup');
    expect(actions).toContain("stringFields(formData, 'memberUserId')");
    expect(actions).toContain('creatorMembershipMutationId');
    expect(actions).toContain('environment: {');
  });

  test('共享 CookingShell 下项目画布保持全宽且弹窗操作区可响应换行', async () => {
    const css = await readFile(cssPath, 'utf8');
    expect(css).toContain('/* /cooking/projects restoration');
    expect(css).toContain('width: 100%');
    expect(css).toContain('.dialog-actions {');
    expect(css).toContain('display: flex');
    expect(css).toContain('margin-inline: 0');
  });
});
