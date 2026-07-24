'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from 'react';
import type { ProjectSummary } from '@agent-party-time/shared/control-plane';
import { CookingAccountMenu } from '@/components/cooking-account-menu';
import { EngineeringCatalogDialog } from '@/components/engineering-catalog-dialog';
import { ProjectCollaborationDialog } from '@/components/project-collaboration-dialog';
import type { CurrentUser } from '@/lib/auth/core';

interface ProjectsResponse {
  items?: ProjectSummary[];
  error?: string;
}

export function ProjectSetup({
  currentUser,
  registeredDevelopers,
  initialProjectId,
}: {
  currentUser: CurrentUser;
  registeredDevelopers: CurrentUser[];
  initialProjectId?: string;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [title, setTitle] = useState('');
  const [inviteeUserIds, setInviteeUserIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [theme, setTheme] = useState<'paper' | 'night'>('paper');
  const [collaborationProject, setCollaborationProject] =
    useState<ProjectSummary | null>(null);
  const [engineeringProject, setEngineeringProject] =
    useState<ProjectSummary | null>(null);
  const [isCreating, startCreating] = useTransition();
  const initialProjectHandled = useRef(false);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch('/api/control-plane/projects', {
        cache: 'no-store',
      });
      const result = (await response.json()) as ProjectsResponse;
      if (!response.ok) throw new Error(result.error ?? '无法读取项目');
      setProjects(result.items ?? []);
      setError(null);
      return result.items ?? [];
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : '无法读取项目',
      );
      return [];
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (
      initialProjectHandled.current ||
      loading ||
      !initialProjectId ||
      projects.length === 0
    )
      return;
    initialProjectHandled.current = true;
    const project = projects.find(
      (candidate) => candidate.id === initialProjectId,
    );
    if (project) setEngineeringProject(project);
  }, [initialProjectId, loading, projects]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle) return;
    startCreating(async () => {
      try {
        const response = await fetch('/api/control-plane/projects', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `web-project:${crypto.randomUUID()}`,
          },
          body: JSON.stringify({
            title: nextTitle,
            inviteeUserIds,
          }),
        });
        const result = (await response.json()) as {
          project?: ProjectSummary;
          error?: string;
        };
        if (!response.ok || !result.project)
          throw new Error(result.error ?? '项目创建失败');
        setTitle('');
        setInviteeUserIds([]);
        setShowCreate(false);
        setError(null);
        await refresh(true);
        if (inviteeUserIds.length > 0) setCollaborationProject(result.project);
        else setEngineeringProject(result.project);
      } catch (requestError) {
        setError(
          requestError instanceof Error ? requestError.message : '项目创建失败',
        );
      }
    });
  }

  return (
    <main className="collab-shell project-settings-shell" data-theme={theme}>
      <header className="collab-topbar">
        <div className="brand-lockup">
          <Link className="brand" href="/cooking">
            Agent Party <span className="stamp">Time</span>
          </Link>
          <span
            aria-label="agents talk, humans watch"
            className="brand-note brand-note--manifesto"
          >
            <strong>agents</strong>
            <b>talk,</b>
            <strong>humans</strong>
            <b>watch</b>
          </span>
        </div>
        <div className="collab-topbar__actions">
          <button
            aria-label={theme === 'paper' ? '切换暗夜主题' : '切换纸张主题'}
            className="collab-quiet-button"
            onClick={() =>
              setTheme((current) => (current === 'paper' ? 'night' : 'paper'))
            }
            type="button"
          >
            {theme === 'paper' ? '暗色' : '浅色'}
          </button>
          <CookingAccountMenu
            currentArea="projects"
            currentUser={currentUser}
            onProjectInvitationsChanged={() =>
              refresh(true).then(() => undefined)
            }
          />
        </div>
      </header>

      <div className="project-settings">
        <header className="project-settings__hero">
          <div className="project-settings__intro">
            <h1>项目与工程</h1>
            <p>
              在这里维护项目成员、工程环境和 Agent 绑定；提测仍在工作台完成。
            </p>
          </div>
          <div className="project-settings__toolbar-actions">
            {projects.length > 0 || showCreate ? (
              <button
                aria-expanded={showCreate}
                className="project-settings__primary-action"
                onClick={() => setShowCreate((current) => !current)}
                type="button"
              >
                {showCreate ? '取消' : '新建项目'}
              </button>
            ) : null}
          </div>
        </header>

        <section className="project-settings__content">
          {showCreate ? (
            <form className="project-settings__create" onSubmit={submit}>
              <div>
                <span>新建项目</span>
                <p>填写项目名称，并可同时邀请开发人员加入协作。</p>
              </div>
              <label>
                <span>项目名称</span>
                <input
                  autoComplete="off"
                  maxLength={120}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="例如：商城重构"
                  required
                  value={title}
                />
              </label>
              <fieldset className="project-settings__invitees">
                <legend>邀请开发人员 / 选填</legend>
                <p>对方接受邀请后，才能被选为工程负责人或工程成员。</p>
                <div>
                  {registeredDevelopers
                    .filter((developer) => developer.id !== currentUser.id)
                    .map((developer) => (
                      <label key={developer.id}>
                        <input
                          checked={inviteeUserIds.includes(developer.id)}
                          onChange={(event) =>
                            setInviteeUserIds((current) =>
                              event.target.checked
                                ? [...current, developer.id]
                                : current.filter((id) => id !== developer.id),
                            )
                          }
                          type="checkbox"
                        />
                        <span>
                          <strong>{developer.displayName}</strong>
                          <small>@{developer.username}</small>
                        </span>
                      </label>
                    ))}
                </div>
              </fieldset>
              <button disabled={isCreating} type="submit">
                {isCreating
                  ? '创建中…'
                  : inviteeUserIds.length > 0
                    ? '创建项目并发送邀请'
                    : '创建并配置工程'}
              </button>
            </form>
          ) : null}

          {error ? (
            <p className="project-settings__error" role="alert">
              {error}
            </p>
          ) : null}

          {loading ? (
            <div className="project-settings__empty">
              <span>加载中</span>
              <p>正在读取项目…</p>
            </div>
          ) : projects.length === 0 ? (
            showCreate ? null : (
              <div className="project-settings__empty">
                <span>暂无项目</span>
                <h2>从一个项目开始。</h2>
                <p>
                  项目创建后，可继续添加工程、配置测试环境并绑定本机 Agent。
                </p>
                <button onClick={() => setShowCreate(true)} type="button">
                  新建项目
                </button>
              </div>
            )
          ) : (
            <ol className="project-settings__list">
              {projects.map((project) => (
                <li key={project.id}>
                  <div className="project-settings__project-copy">
                    <span>
                      {project.memberRole === 'OWNER'
                        ? '项目负责人'
                        : '项目成员'}
                    </span>
                    <h2>{project.title ?? project.slug}</h2>
                  </div>
                  <div className="project-settings__row-actions">
                    <button
                      onClick={() => setCollaborationProject(project)}
                      type="button"
                    >
                      成员与邀请
                    </button>
                    <button
                      className="project-settings__row-primary"
                      onClick={() => setEngineeringProject(project)}
                      type="button"
                    >
                      工程与 Agent
                    </button>
                    <Link href="/cooking">提测</Link>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {collaborationProject ? (
        <ProjectCollaborationDialog
          currentUser={currentUser}
          developers={registeredDevelopers}
          onChanged={() => refresh(true).then(() => undefined)}
          onClose={() => setCollaborationProject(null)}
          project={collaborationProject}
        />
      ) : null}

      {engineeringProject ? (
        <EngineeringCatalogDialog
          currentUser={currentUser}
          onClose={() => setEngineeringProject(null)}
          project={engineeringProject}
        />
      ) : null}
    </main>
  );
}
