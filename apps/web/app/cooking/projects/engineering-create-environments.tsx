'use client';

import { useState } from 'react';
import { DeploymentFields } from '@/features/cooking/engineering/presentation/deployment-fields';

type EnvironmentDraft = {
  key: string;
  name: string;
};

export function EngineeringCreateEnvironments({
  initialMutationId,
}: {
  initialMutationId: string;
}) {
  const [environments, setEnvironments] = useState<EnvironmentDraft[]>([
    { key: initialMutationId, name: '测试环境' },
  ]);

  function addEnvironment() {
    setEnvironments((current) => [
      ...current,
      { key: crypto.randomUUID(), name: '' },
    ]);
  }

  function removeEnvironment(key: string) {
    setEnvironments((current) =>
      current.length === 1
        ? current
        : current.filter((environment) => environment.key !== key),
    );
  }

  return (
    <section className="engineering-environments">
      <div className="collaboration-section-title engineering-environments__title">
        <div>
          <span>测试环境与更新方式</span>
          <small>{environments.length} 个，创建工程时一起保存</small>
        </div>
        <button onClick={addEnvironment} type="button">
          添加测试环境
        </button>
      </div>

      {environments.map((environment, index) => (
        <article key={environment.key}>
          <input name="environmentKey" type="hidden" value={environment.key} />
          <input
            name={`environmentMutationId:${environment.key}`}
            type="hidden"
            value={environment.key}
          />
          <header className="engineering-environment-card__header field-wide">
            <strong>测试环境 {index + 1}</strong>
            {environments.length > 1 ? (
              <button
                aria-label={`移除测试环境 ${index + 1}`}
                className="engineering-remove-environment"
                onClick={() => removeEnvironment(environment.key)}
                type="button"
              >
                移除
              </button>
            ) : null}
          </header>
          <label>
            <span>环境名称</span>
            <input
              defaultValue={environment.name}
              maxLength={120}
              name={`environmentName:${environment.key}`}
              placeholder={index === 0 ? undefined : '例如：预发布环境'}
              required
            />
          </label>
          <DeploymentFields
            commandName={`command:${environment.key}`}
            kindName={`deploymentKind:${environment.key}`}
          />
        </article>
      ))}
    </section>
  );
}
