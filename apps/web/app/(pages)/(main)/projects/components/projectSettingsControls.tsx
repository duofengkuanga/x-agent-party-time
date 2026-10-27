'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { createProjectAction } from '@/app/actions/projects/projects';
import type { ProjectSummary } from '@/contracts/projects/project';
import { projectSettingsPath } from './routeState';
import { useProjectNavigation } from './autoSaveForm';

export function ProjectSettingsControls({
  children,
  mutationId,
  projects,
  selectedProjectId,
}: {
  children: ReactNode;
  mutationId: string;
  projects: ProjectSummary[];
  selectedProjectId?: string;
}) {
  const navigation = useProjectNavigation();
  const switching = Boolean(
    navigation && navigation.projectId !== selectedProjectId,
  );
  const highlightedProjectId = navigation?.projectId ?? selectedProjectId;
  const loadingProject = projects.find(
    ({ project }) => project.id === navigation?.projectId,
  );
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch] = useState('');
  useEffect(() => {
    setShowCreate(false);
    setSearch('');
  }, [selectedProjectId]);
  const matchingProjects = projects.filter(({ project }) =>
    project.name
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );

  return (
    <main className="project-settings project-settings-shell">
      <aside className="project-settings__sidebar" aria-label="项目列表">
        <header className="project-settings__sidebar-heading">
          <h1>
            我的项目 <span>{projects.length}</span>
          </h1>
          <button
            aria-controls="project-create-form"
            aria-expanded={showCreate}
            className="project-settings__primary-action"
            onClick={() => setShowCreate((current) => !current)}
            type="button"
          >
            {showCreate ? '取消' : '新建项目'}
          </button>
        </header>
        {showCreate ? (
          <form
            action={createProjectAction}
            className="project-settings__create"
            id="project-create-form"
          >
            <input name="mutationId" type="hidden" value={mutationId} />
            <label>
              <span>项目名称</span>
              <input
                autoComplete="off"
                maxLength={120}
                name="name"
                placeholder="例如：商城重构"
                required
              />
            </label>
            <CreateProjectButton />
          </form>
        ) : null}
        {projects.length ? (
          <>
            <label className="project-settings__search">
              <span>搜索项目</span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索项目名称"
              />
            </label>
            <nav aria-label="切换项目">
              <ol className="project-settings__list">
                {matchingProjects.map(({ project }) => (
                  <li key={project.id}>
                    <Link
                      aria-current={
                        highlightedProjectId === project.id ? 'page' : undefined
                      }
                      data-project-id={project.id}
                      href={projectSettingsPath({ projectId: project.id })}
                      scroll={false}
                    >
                      <span
                        className="project-settings__project-mark"
                        aria-hidden="true"
                      >
                        {project.name.slice(0, 1)}
                      </span>
                      <span className="project-settings__project-copy">
                        <strong>{project.name}</strong>
                      </span>
                      <span
                        className="project-settings__selected-mark"
                        aria-hidden="true"
                      >
                        ›
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
              {!matchingProjects.length ? (
                <p className="project-settings__search-empty" role="status">
                  没有找到“{search}”对应的项目。
                </p>
              ) : null}
            </nav>
          </>
        ) : (
          <p className="project-settings__search-empty">
            创建项目后，在这里切换。
          </p>
        )}
      </aside>
      <section
        className="project-settings__content"
        aria-label="项目与工程信息"
        aria-busy={switching}
        key={selectedProjectId}
      >
        {switching ? (
          <div className="project-loading">
            <h2>{loadingProject?.project.name}</h2>
            <p role="status">
              {navigation?.phase === 'saving'
                ? '正在保存当前修改…'
                : '正在加载项目内容…'}
            </p>
            <div className="project-loading__skeleton" aria-hidden="true">
              <span />
              <span />
              <div />
              <div />
            </div>
          </div>
        ) : null}
        <div
          className="project-settings__loaded"
          hidden={switching}
          inert={switching}
        >
          {children}
          {!projects.length ? (
            <div className="project-settings__empty">
              <h2>从一个项目开始</h2>
              <p>把成员、工程和测试环境放在一起，随后绑定你的本机 Agent。</p>
              <button onClick={() => setShowCreate(true)} type="button">
                新建项目
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function CreateProjectButton() {
  const { pending } = useFormStatus();
  return (
    <button disabled={pending} type="submit">
      {pending ? '正在创建…' : '创建项目'}
    </button>
  );
}
