import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { engineeringService, projectService } from '@/server/runtime/services';
import {
  addEngineeringMemberAction,
  createEngineeringAction,
  removeEngineeringMemberAction,
} from '@/app/actions/projects/engineering';
import { projectPanelPath } from '@/app/(pages)/(main)/projects/components/routeState';
import { EngineeringCreateEnvironments } from './engineeringCreateEnvironments';
import { Dialog } from '../components/dialog';
import {
  DialogFeedback,
  ProjectFields,
  EngineeringTaskHeading,
  EngineeringFields,
} from './settingsFields';
import {
  EngineeringEnvironmentManagement,
  EngineeringInformationManagement,
} from './engineeringSettings';

export function EngineeringDialog({
  engineeringId,
  error,
  mode,
  projectId,
  success,
  userId,
}: {
  engineeringId?: string;
  error?: string;
  mode?: string;
  projectId: string;
  success?: string;
  userId: string;
}) {
  const projects = projectService();
  const engineering = engineeringService();
  const project = projects.getProject(userId, projectId);
  const items = engineering.listEngineering(userId, projectId);
  const members = projects.listMembers(userId, projectId);
  const selected =
    engineeringId && engineeringId !== 'new'
      ? items.find((candidate) => candidate.id === engineeringId)
      : undefined;
  const owner = project.membership.role === 'OWNER';

  return (
    <Dialog
      title={engineeringId === 'new' ? '新建工程' : '编辑工程'}
      kicker={project.project.name}
      closeHref={projectPanelPath(projectId, 'engineering')}
    >
      <DialogFeedback error={error} success={success} />
      {engineeringId === 'new' && owner ? (
        <EngineeringCreateForm
          projectId={projectId}
          projectMembers={members}
          userId={userId}
        />
      ) : selected && mode === 'members' && owner ? (
        <EngineeringMemberManagement
          engineeringId={selected.id}
          projectId={projectId}
          projectMembers={members}
          userId={userId}
        />
      ) : selected && mode === 'environments' && owner ? (
        <EngineeringEnvironmentManagement
          engineeringId={selected.id}
          projectId={projectId}
          userId={userId}
        />
      ) : selected && mode === 'information' && owner ? (
        <EngineeringInformationManagement
          engineeringId={selected.id}
          projectId={projectId}
          userId={userId}
        />
      ) : null}
    </Dialog>
  );
}

function EngineeringCreateForm({
  projectId,
  projectMembers,
  userId,
}: {
  projectId: string;
  projectMembers: ReturnType<ReturnType<typeof projectService>['listMembers']>;
  userId: string;
}) {
  const additionalMembers = projectMembers.filter(
    ({ user }) => user.id !== userId,
  );
  return (
    <form action={createEngineeringAction} className="engineering-editor">
      <div className="engineering-editor__heading">
        <div>
          <strong>新建工程</strong>
          <small>配置工程成员与测试环境；仓库由首次本机 Agent 绑定确认。</small>
        </div>
      </div>
      <ProjectFields projectId={projectId} />
      <input
        name="creatorMembershipMutationId"
        type="hidden"
        value={randomUUID()}
      />
      <div className="engineering-editor__grid">
        <label className="field-wide">
          <span>工程名称</span>
          <input
            autoComplete="off"
            maxLength={120}
            name="name"
            placeholder="例如：商城前端"
            required
          />
        </label>
        <label>
          <span>工程归属</span>
          <select defaultValue="" name="type" required>
            <option disabled value="">
              请选择
            </option>
            <option value="FRONTEND">前端</option>
            <option value="BACKEND">后端</option>
          </select>
        </label>
        <label>
          <span>稳定标识</span>
          <input
            aria-describedby="engineering-create-identifier-format"
            autoComplete="off"
            maxLength={40}
            name="identifier"
            pattern="[a-z\p{Script=Han}][a-z0-9\p{Script=Han}]*(?:-[a-z0-9\p{Script=Han}]+)*"
            placeholder="例如：大屏或 soil-dashboard"
            required
          />
          <small id="engineering-create-identifier-format">
            支持中文、小写字母、数字和单个连字符，需以中文或小写字母开头。
          </small>
        </label>
        <div className="engineering-editor__setup-note field-wide">
          <span>仓库识别</span>
          <strong>首次创建本机 Agent 绑定后自动确认</strong>
          <small>
            这里不填写远程仓库地址，避免网页配置与本机实际仓库不一致。
          </small>
        </div>
        {additionalMembers.length ? (
          <fieldset className="field-wide">
            <legend>工程成员 / 选填</legend>
            {additionalMembers.map(({ user }) => (
              <label className="inline-check" key={user.id}>
                <input name="memberUserId" type="checkbox" value={user.id} />
                <span>
                  {user.displayName} · @{user.username}
                </span>
                <input
                  name={`memberMutationId:${user.id}`}
                  type="hidden"
                  value={randomUUID()}
                />
              </label>
            ))}
          </fieldset>
        ) : null}
      </div>

      <EngineeringCreateEnvironments initialMutationId={randomUUID()} />

      <div className="dialog-actions">
        <Link href={projectPanelPath(projectId, 'engineering')} replace>
          返回项目
        </Link>
        <button className="repair-primary" type="submit">
          创建工程
        </button>
      </div>
    </form>
  );
}

function EngineeringMemberManagement({
  engineeringId,
  projectId,
  projectMembers,
  userId,
}: {
  engineeringId: string;
  projectId: string;
  projectMembers: ReturnType<ReturnType<typeof projectService>['listMembers']>;
  userId: string;
}) {
  const workspace = engineeringService().getWorkspace(userId, engineeringId);
  const assigned = new Set(workspace.members.map(({ user }) => user.id));
  const availableMembers = projectMembers.filter(
    ({ user }) => !assigned.has(user.id),
  );

  return (
    <div className="engineering-task">
      <EngineeringTaskHeading
        label="成员管理"
        name={workspace.engineering.name}
        projectId={projectId}
      />

      <section className="engineering-task__section">
        <div className="engineering-task__section-title">
          <strong>工程成员</strong>
          <small>{workspace.members.length} 人</small>
        </div>
        <ul className="engineering-member-list">
          {workspace.members.map(({ membership, user }) => (
            <li key={user.id}>
              <span>
                <strong>{user.displayName}</strong>
                <small>@{user.username}</small>
              </span>
              <form action={removeEngineeringMemberAction}>
                <EngineeringFields
                  engineeringId={engineeringId}
                  projectId={projectId}
                />
                <input name="userId" type="hidden" value={user.id} />
                <input
                  name="expectedVersion"
                  type="hidden"
                  value={membership.version}
                />
                <button type="submit">移出工程</button>
              </form>
            </li>
          ))}
        </ul>
      </section>

      {availableMembers.length ? (
        <section className="engineering-task__section engineering-member-add">
          <div className="engineering-task__section-title">
            <strong>添加成员</strong>
            <small>从项目成员中选择</small>
          </div>
          <form action={addEngineeringMemberAction}>
            <EngineeringFields
              engineeringId={engineeringId}
              projectId={projectId}
            />
            <label>
              <span>项目成员</span>
              <select name="userId" required>
                {availableMembers.map(({ user }) => (
                  <option key={user.id} value={user.id}>
                    {user.displayName}（@{user.username}）
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">添加成员</button>
          </form>
        </section>
      ) : (
        <p className="engineering-task__empty">所有项目成员都已加入工程。</p>
      )}
    </div>
  );
}
