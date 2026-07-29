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
    expect(controls).toContain('hasProjects ? (');
    expect(controls).toContain('<section className="project-settings__hero">');
    expect(controls).toContain('<div className="project-settings__empty">');
    expect(controls).toContain('<h1>我的项目</h1>');
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

  test('普通项目成员打开成员面板时不读取或展示负责人邀请信息', async () => {
    const page = await readFile(pagePath, 'utf8');
    const collaboration = page
      .split('function CollaborationDialog')[1]
      .split('function ProjectSettingsDialog')[0];
    expect(collaboration).toContain(
      "const owner = summary.membership.role === 'OWNER';",
    );
    expect(collaboration).toContain(
      'const invitations = owner\n    ? projects.listProjectInvitations(userId, projectId)\n    : [];',
    );
    expect(collaboration).toMatch(
      /\{owner \? \(\s*<section>\s*<div className="collaboration-section-title">\s*<span>待处理邀请<\/span>/u,
    );
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

  test('工程目录提供四个聚焦入口并保留单弹窗层级', async () => {
    const page = await readFile(pagePath, 'utf8');
    const effects = await readFile(effectsPath, 'utf8');
    expect(page).toContain('· 成员与邀请');
    expect(page).toContain("engineeringId === 'new'");
    expect(page).toContain('<EngineeringCreateForm');
    expect(page).toContain('projectMembers={members}');
    expect(page).toContain('<EngineeringCreateEnvironments');
    expect(page).toContain('name="memberUserId"');
    expect(page).toContain("mode === 'members'");
    expect(page).toContain("mode === 'environments'");
    expect(page).toContain("mode === 'information'");
    expect(page).toContain('function EngineeringMemberManagement');
    expect(page).toContain('function EngineeringEnvironmentManagement');
    expect(page).toContain('function EngineeringInformationManagement');
    expect(page).toContain('function EngineeringTaskHeading');
    expect(page.match(/<EngineeringTaskHeading/g)?.length).toBe(4);
    expect(page).toContain('成员管理');
    expect(page).toContain('环境管理');
    expect(page).toContain('信息管理');
    expect(page).toMatch(/>\s*详情\s*<\/Link>/u);
    expect(page).toContain("{ label: '前端工程', type: 'FRONTEND' as const }");
    expect(page).toContain("{ label: '后端工程', type: 'BACKEND' as const }");
    expect(page).toContain('item.identifier} · {currentUserRelation');
    expect(page).toContain('<div className="engineering-binding-disclosure">');
    expect(page).toContain('<section className="engineering-task__archive">');
    expect(page).toContain(
      '<section className="engineering-environment-create">',
    );
    expect(page).not.toContain(
      '<details className="engineering-binding-disclosure">',
    );
    expect(page).not.toContain(
      '<details className="engineering-task__archive">',
    );
    expect(page).not.toContain('编辑工程');
    expect(page).not.toContain('只展开当前需要修改的配置');
    expect(page).not.toContain('代码工程');
    expect(page).not.toContain('编辑配置');
    expect(page).not.toContain('还没有工程');
    expect(page).toContain('name="identifier"');
    expect(page).toContain('name="type"');
    expect(page).toContain('identifierLocked');
    expect(page).toContain('<dt>工程归属</dt>');
    expect(page).toContain('<dt>稳定标识</dt>');
    expect(page).toContain('href={engineeringCreateHref(projectId)}');
    expect(page).toContain('href={engineeringHref(projectId, item.id)}');
    expect(page).toContain('href={engineeringViewHref(');
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

  test('工程操作提交后返回各自的聚焦管理上下文', async () => {
    const actions = await readFile(engineeringActionsPath, 'utf8');
    expect(actions).toContain(
      'redirectWithError(engineeringCreatePath(projectId), error)',
    );
    expect(actions).toContain('engineeringPath(projectId, engineering.id)');
    expect(actions).toContain('redirect(path, RedirectType.replace)');
    expect(actions.match(/redirectReplacingHistory\(/g)?.length).toBe(10);
    expect(
      actions.match(
        /engineeringViewPath\(projectId, engineeringId, 'information'\)/g,
      )?.length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      actions.match(
        /engineeringViewPath\(projectId, engineeringId, 'members'\)/g,
      )?.length,
    ).toBeGreaterThanOrEqual(4);
    expect(
      actions.match(
        /engineeringViewPath\(projectId, engineeringId, 'environments'\)/g,
      )?.length,
    ).toBeGreaterThanOrEqual(6);
    expect(actions).not.toContain('mode=edit');
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

  test('环境管理一次提交可增删的多个测试环境', async () => {
    const page = await readFile(pagePath, 'utf8');
    const actions = await readFile(engineeringActionsPath, 'utf8');
    const environments = await readFile(createEnvironmentsPath, 'utf8');
    expect(page).toContain('saveContext="一起保存到当前工程"');
    expect(page).toContain('submitLabel="保存测试环境"');
    expect(page).toContain('className="engineering-environment-batch-form"');
    expect(environments).toContain('submitLabel?: string');
    expect(environments).toContain('engineering-environments__submit');
    expect(actions).toContain('engineeringService().createEnvironments(');
    expect(actions).toContain("stringFields(formData, 'environmentKey')");
  });

  test('新建项目按钮覆盖默认、展开、悬停与焦点状态', async () => {
    const css = await readFile(cssPath, 'utf8');
    expect(css).toContain('.project-settings__primary-action {');
    expect(css).toContain("[aria-expanded='true']");
    expect(css).toContain('.project-settings__primary-action:hover');
    expect(css).toContain('.project-settings button:focus-visible');
    expect(css).toContain('.project-settings__toolbar-actions,');
  });

  test('共享 CookingShell 下项目画布全宽且管理控件保持紧凑', async () => {
    const css = await readFile(cssPath, 'utf8');
    expect(css).toContain('/* /cooking/projects restoration');
    expect(css).toContain('width: 100%');
    expect(css).toContain('.dialog-actions {');
    expect(css).toContain('display: flex');
    expect(css).toContain('margin-inline: 0');
    expect(css).toContain('.engineering-card__actions {');
    expect(css).toContain('.engineering-card[href]:not(:disabled):hover');
    expect(css).toContain('.engineering-task__heading {');
    expect(css).toContain('.engineering-member-add form,');
    expect(css).toContain('.engineering-environment-row > form,');
    expect(css).toContain('height: 36px;');
  });
});
