import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const pagePath = join(import.meta.dir, 'page.tsx');
const controlsPath = join(import.meta.dir, 'project-settings-controls.tsx');
const createEnvironmentsPath = join(
  import.meta.dir,
  'engineering-create-environments.tsx',
);
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
    expect(controls).toContain('aria-controls="project-create-form"');
    expect(controls).toContain('id="project-create-form"');
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

  test('项目页不改造共享账号区域并保留邀请弹窗深链', async () => {
    const page = await readFile(pagePath, 'utf8');
    const controls = await readFile(controlsPath, 'utf8');
    const actions = await readFile(actionsPath, 'utf8');
    expect(controls).not.toContain('document.querySelector');
    expect(controls).not.toContain('createPortal');
    expect(controls).not.toContain('project-account-menu');
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
    expect(page).toContain('<EngineeringCreateEnvironments');
    expect(page).toContain('name="memberUserId"');
    expect(page).toContain("mode === 'edit'");
    expect(page).toContain('取消编辑');
    expect(page).not.toContain('完成编辑');
    expect(page).toContain('href={engineeringCreateHref(projectId)}');
    expect(page).toContain('href={engineeringHref(projectId, item.id)}');
    expect(page).toContain(
      'href={engineeringEditHref(projectId, engineeringId)}',
    );
    expect(page.match(/replace/g)?.length).toBeGreaterThanOrEqual(6);
    expect(page).not.toContain('name="repositoryUrl"');
    expect(page).toContain('等待首次本机 Agent 绑定确认仓库');
    expect(page).toContain(
      '<DialogFeedback error={error} success={success} />',
    );
    expect(effects).toContain("event.key === 'Escape'");
    expect(effects).toContain('event.target === overlay');
    expect(page).toContain('tabIndex={-1}');
    expect(effects).toContain("document.body.style.overflow = 'hidden'");
  });

  test('工程弹窗提交后保留当前目录、新建、详情或编辑上下文', async () => {
    const actions = await readFile(engineeringActionsPath, 'utf8');
    expect(actions).toContain(
      'redirectWithError(engineeringCreatePath(projectId), error)',
    );
    expect(actions).toContain(
      'redirectWithError(engineeringEditPath(projectId, engineeringId), error)',
    );
    expect(actions).toContain('engineeringPath(projectId, engineering.id)');
    expect(actions).toContain('redirect(path, RedirectType.replace)');
    expect(actions.match(/redirectReplacingHistory\(/g)?.length).toBe(10);
    expect(
      actions.match(/engineeringEditPath\(projectId, engineeringId\)/g)?.length,
    ).toBeGreaterThanOrEqual(11);
  });
  test('新建工程一次提交成员与可增删的多个测试环境', async () => {
    const page = await readFile(pagePath, 'utf8');
    const actions = await readFile(engineeringActionsPath, 'utf8');
    const environments = await readFile(createEnvironmentsPath, 'utf8');
    expect(page).toContain('creatorMembershipMutationId');
    expect(page).toContain('工程成员 / 选填');
    expect(page).toContain('initialMutationId={randomUUID()}');
    expect(environments).toContain('测试环境与更新方式');
    expect(environments).toContain('添加测试环境');
    expect(environments).toContain('removeEnvironment');
    expect(environments).toContain('name="environmentKey"');
    expect(environments).toContain('environmentMutationId:${environment.key}');
    expect(environments).toContain('environmentName:${environment.key}');
    expect(environments).toContain('deploymentKind:${environment.key}');
    expect(actions).toContain('createEngineeringSetup');
    expect(actions).toContain("stringFields(formData, 'memberUserId')");
    expect(actions).toContain("stringFields(formData, 'environmentKey')");
    expect(actions).toContain('creatorMembershipMutationId');
    expect(actions).toContain('environments:');
  });

  test('新建项目按钮覆盖默认、展开、悬停与焦点状态', async () => {
    const css = await readFile(cssPath, 'utf8');
    expect(css).toContain('.project-settings__primary-action {');
    expect(css).toContain("[aria-expanded='true']");
    expect(css).toContain('.project-settings__primary-action:hover');
    expect(css).toContain('.project-settings button:focus-visible');
    expect(css).toContain('.project-settings__toolbar-actions,');
  });

  test('共享 CookingShell 下项目画布保持全宽且弹窗操作区可响应换行', async () => {
    const css = await readFile(cssPath, 'utf8');
    expect(css).toContain('/* /cooking/projects restoration');
    expect(css).toContain('width: 100%');
    expect(css).toContain('.dialog-actions {');
    expect(css).toContain('display: flex');
    expect(css).toContain('margin-inline: 0');
    expect(css).toContain('.engineering-detail > .engineering-editor {');
    expect(css).toContain('overflow: visible');
  });
});
