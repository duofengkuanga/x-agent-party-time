'use client';

import { useState, type ReactNode } from 'react';
import { createProjectAction } from '@/features/cooking/projects/presentation/actions';

export function ProjectSettingsControls({
  children,
  error,
  hasProjects,
  mutationId,
  success,
}: {
  children: ReactNode;
  error?: string;
  hasProjects: boolean;
  mutationId: string;
  success?: string;
}) {
  const [showCreate, setShowCreate] = useState(false);

  return (
    <main className="project-settings project-settings-shell">
      {hasProjects ? (
        <section className="project-settings__hero">
          <div className="project-settings__intro">
            <h1>项目与工程</h1>
            <p>
              在这里维护项目成员、工程环境和 Agent 绑定；提测仍在工作台完成。
            </p>
          </div>
          <div className="project-settings__toolbar-actions">
            <button
              aria-controls="project-create-form"
              aria-expanded={showCreate}
              className="project-settings__primary-action"
              onClick={() => setShowCreate((current) => !current)}
              type="button"
            >
              {showCreate ? '取消' : '新建项目'}
            </button>
          </div>
        </section>
      ) : null}

      <section className="project-settings__content">
        {showCreate ? (
          <form
            action={createProjectAction}
            className="project-settings__create"
            id="project-create-form"
          >
            <input name="mutationId" type="hidden" value={mutationId} />
            <div>
              <span>新建项目</span>
              <p>先建立协作边界，随后添加工程并完成本机绑定。</p>
            </div>
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
            <button type="submit">创建并配置工程</button>
          </form>
        ) : null}

        {error ? (
          <p className="project-settings__error" role="alert">
            {error}
          </p>
        ) : null}
        {success ? <p className="notice notice-success">{success}</p> : null}

        {hasProjects ? (
          children
        ) : showCreate ? null : (
          <div className="project-settings__empty">
            <span>暂无项目</span>
            <h2>从一个项目开始。</h2>
            <p>项目创建后，可继续添加工程、配置测试环境并绑定本机 Agent。</p>
            <button onClick={() => setShowCreate(true)} type="button">
              新建项目
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
