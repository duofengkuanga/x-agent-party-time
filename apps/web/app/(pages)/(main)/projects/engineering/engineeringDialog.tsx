import { randomUUID } from 'node:crypto';
import { projectService } from '@/server/runtime/services';
import type { EngineeringWorkspace } from '@/contracts/projects/engineering';
import { createEngineeringAction } from '@/app/actions/projects/engineering';
import { EngineeringCreateEnvironments } from './engineeringCreateEnvironments';
import { EngineeringCreateCancel } from './engineeringCreateModal';
import { SaveButton } from '../components/saveButton';
import { EngineeringMemberToggle } from './engineeringMemberToggle';
import { DialogFeedback, ProjectFields } from './settingsFields';

export function EngineeringDialog({
  error,
  projectId,
  success,
  userId,
}: {
  error?: string;
  projectId: string;
  success?: string;
  userId: string;
}) {
  const projects = projectService();
  const project = projects.getProject(userId, projectId);
  if (project.membership.role !== 'OWNER') return null;
  const members = projects.listMembers(userId, projectId);

  return (
    <div className="project-inline-settings project-engineering-create">
      <DialogFeedback error={error} success={success} />
      <EngineeringCreateForm
        projectId={projectId}
        projectMembers={members}
        userId={userId}
      />
    </div>
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
  return (
    <form action={createEngineeringAction} className="engineering-editor">
      <ProjectFields projectId={projectId} />
      <input
        name="creatorMembershipMutationId"
        type="hidden"
        value={randomUUID()}
      />
      <div className="engineering-join-fields">
        <label>
          <span>工程名称</span>
          <input
            autoComplete="off"
            maxLength={120}
            name="name"
            placeholder="例如：soil-web"
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
            placeholder="例如：土壤前端"
            required
          />
          <small id="engineering-create-identifier-format">
            以中文或小写字母开头，可包含数字与单个连字符。
          </small>
        </label>
        <fieldset className="engineering-join-members">
          <legend>工程成员</legend>
          <div>
            {projectMembers.map(({ user }) => (
              <label key={user.id} title={`@${user.username}`}>
                <input
                  defaultChecked={user.id === userId}
                  disabled={user.id === userId}
                  name={user.id === userId ? undefined : 'memberUserId'}
                  type="checkbox"
                  value={user.id}
                />
                <span>
                  {user.displayName}
                  {user.id === userId ? '（你）' : ''}
                </span>
                {user.id !== userId ? (
                  <input
                    name={`memberMutationId:${user.id}`}
                    type="hidden"
                    value={randomUUID()}
                  />
                ) : null}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <EngineeringCreateEnvironments initialMutationId={randomUUID()} />

      <div className="dialog-actions">
        <EngineeringCreateCancel />
        <SaveButton className="repair-primary" pendingLabel="正在加入…">
          加入工程
        </SaveButton>
      </div>
    </form>
  );
}

export function EngineeringMemberManagement({
  workspace,
  projectMembers,
}: {
  workspace: EngineeringWorkspace;
  projectMembers: ReturnType<ReturnType<typeof projectService>['listMembers']>;
}) {
  const engineeringId = workspace.engineering.id;
  return (
    <div className="engineering-members-direct" aria-label="工程成员">
      {projectMembers.map(({ user }) => (
        <EngineeringMemberToggle
          key={user.id}
          engineeringId={engineeringId}
          userId={user.id}
          name={user.displayName}
          membership={
            workspace.members.find((member) => member.user.id === user.id)
              ?.membership
          }
        />
      ))}
    </div>
  );
}
