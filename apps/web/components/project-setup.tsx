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
import {
  ProjectCollaborationDialog,
  ProjectInvitationInbox,
} from '@/components/project-collaboration-dialog';
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
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [theme, setTheme] = useState<'paper' | 'night'>('paper');
  const [showInvitations, setShowInvitations] = useState(false);
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
    const nextSlug = slug.trim();
    const nextTitle = title.trim();
    if (!nextSlug) return;
    startCreating(async () => {
      try {
        const response = await fetch('/api/control-plane/projects', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `web-project:${crypto.randomUUID()}`,
          },
          body: JSON.stringify({
            slug: nextSlug,
            title: nextTitle || null,
          }),
        });
        const result = (await response.json()) as {
          project?: ProjectSummary;
          error?: string;
        };
        if (!response.ok || !result.project)
          throw new Error(result.error ?? '项目创建失败');
        setSlug('');
        setTitle('');
        setShowCreate(false);
        setError(null);
        await refresh(true);
        setEngineeringProject(result.project);
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
            <button
              className="project-settings__quiet-action"
              onClick={() => setShowInvitations(true)}
              type="button"
            >
              项目邀请
            </button>
            <button
              aria-expanded={showCreate}
              className="project-settings__primary-action"
              onClick={() => setShowCreate((current) => !current)}
              type="button"
            >
              {showCreate ? '取消' : '新建项目'}
            </button>
          </div>
        </header>

        <section className="project-settings__content">
          {showCreate ? (
            <form className="project-settings__create" onSubmit={submit}>
              <div>
                <span>新建项目</span>
                <p>先建立协作边界，随后添加工程并完成本机绑定。</p>
              </div>
              <label>
                <span>项目名称</span>
                <input
                  autoComplete="off"
                  maxLength={120}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="例如：商城重构"
                  value={title}
                />
              </label>
              <label>
                <span>项目标识</span>
                <input
                  autoComplete="off"
                  onChange={(event) => setSlug(event.target.value)}
                  pattern="[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?"
                  placeholder="storefront-rebuild"
                  required
                  value={slug}
                />
              </label>
              <button disabled={isCreating} type="submit">
                {isCreating ? '创建中…' : '创建并配置工程'}
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
            <div className="project-settings__empty">
              <span>暂无项目</span>
              <h2>从一个项目开始。</h2>
              <p>项目创建后，可继续添加工程、配置测试环境并绑定本机 Agent。</p>
              <button onClick={() => setShowCreate(true)} type="button">
                新建项目
              </button>
            </div>
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
                    <p>/{project.slug}</p>
                  </div>
                  <div className="project-settings__row-actions">
                    <button
                      onClick={() => setCollaborationProject(project)}
                      type="button"
                    >
                      成员
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

      {showInvitations ? (
        <ProjectInvitationInbox
          onChanged={() => refresh(true).then(() => undefined)}
          onClose={() => setShowInvitations(false)}
        />
      ) : null}
    </main>
  );
}
