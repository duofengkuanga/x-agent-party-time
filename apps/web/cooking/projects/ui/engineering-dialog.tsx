import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { engineeringService, projectService } from '@/cooking/runtime/services';
import {
  addEngineeringMemberAction,
  createEngineeringAction,
  removeEngineeringMemberAction,
} from '@/cooking/engineering/server/actions';
import { engineeringViewPath as engineeringViewHref } from '@/cooking/projects/ui/route-state';
import { EngineeringCreateEnvironments } from './engineering-create-environments';
import { Dialog } from './dialog';
import {
  DialogFeedback,
  ProjectFields,
  EngineeringTaskHeading,
  EngineeringFields,
} from './settings-fields';
import {
  EngineeringEnvironmentManagement,
  EngineeringInformationManagement,
  EngineeringDetail,
} from './engineering-settings';

import {
  engineeringCreateHref,
  engineeringHref,
  settingsHref,
} from './settings-links';

export function EngineeringDialog({
  bindingRequestId,
  engineeringId,
  error,
  mode,
  projectId,
  success,
  userId,
}: {
  bindingRequestId?: string;
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
    <Dialog title="工程目录" kicker={project.project.name}>
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
      ) : selected ? (
        <EngineeringDetail
          bindingRequestId={bindingRequestId}
          engineeringId={selected.id}
          projectId={projectId}
          userId={userId}
        />
      ) : (
        <div className="engineering-catalog">
          <div className="engineering-catalog__intro">
            {owner ? (
              <Link
                className="repair-primary"
                href={engineeringCreateHref(projectId)}
                replace
              >
                新建工程
              </Link>
            ) : null}
          </div>
          {items.length
            ? [
                { label: '前端工程', type: 'FRONTEND' as const },
                { label: '后端工程', type: 'BACKEND' as const },
              ].map((group) => {
                const groupItems = items.filter(
                  (item) => item.type === group.type,
                );
                if (!groupItems.length) return null;
                return (
                  <section className="engineering-group" key={group.type}>
                    <div className="collaboration-section-title">
                      <span>{group.label}</span>
                      <small>{groupItems.length} 个</small>
                    </div>
                    <div className="engineering-list">
                      {groupItems.map((item) => {
                        const currentUserIsEngineeringMember = engineering
                          .listMembers(userId, item.id)
                          .some(({ user }) => user.id === userId);
                        const currentUserRelation = owner
                          ? '项目所有者'
                          : currentUserIsEngineeringMember
                            ? '工程成员'
                            : '项目成员';
                        return (
                          <article className="engineering-card" key={item.id}>
                            <div className="engineering-card__copy">
                              <strong>{item.name}</strong>
                              <small>
                                {item.identifier} · {currentUserRelation}
                              </small>
                            </div>
                            <nav
                              aria-label={`${item.name}管理`}
                              className="engineering-card__actions"
                            >
                              {owner ? (
                                <>
                                  <Link
                                    href={engineeringViewHref(
                                      projectId,
                                      item.id,
                                      'members',
                                    )}
                                    replace
                                  >
                                    成员管理
                                  </Link>
                                  <Link
                                    href={engineeringViewHref(
                                      projectId,
                                      item.id,
                                      'environments',
                                    )}
                                    replace
                                  >
                                    环境管理
                                  </Link>
                                  <Link
                                    href={engineeringViewHref(
                                      projectId,
                                      item.id,
                                      'information',
                                    )}
                                    replace
                                  >
                                    信息管理
                                  </Link>
                                </>
                              ) : null}
                              <Link
                                href={engineeringHref(projectId, item.id)}
                                replace
                              >
                                详情
                              </Link>
                            </nav>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                );
              })
            : null}
        </div>
      )}
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
        <Link href={settingsHref(projectId, 'engineering')} replace>
          返回目录
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
