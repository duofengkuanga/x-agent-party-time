'use client';

import { useState } from 'react';
import { createClientId } from '@/app/(pages)/(main)/components/clientId';
import { DeploymentFields } from '@/app/(pages)/(main)/projects/engineering/deploymentFields';

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
      { key: createClientId(), name: '' },
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
    <section className="engineering-join-environments">
      <header>
        <h3>环境配置</h3>
        <button onClick={addEnvironment} type="button">
          ＋ 添加环境
        </button>
      </header>

      {environments.map((environment, index) => (
        <article className="engineering-join-environment" key={environment.key}>
          <input name="environmentKey" type="hidden" value={environment.key} />
          <input
            name={`environmentMutationId:${environment.key}`}
            type="hidden"
            value={environment.key}
          />
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
            compact
            commandName={`command:${environment.key}`}
            kindName={`deploymentKind:${environment.key}`}
            scriptCommandName={`scriptCommand:${environment.key}`}
          />
          {environments.length > 1 ? (
            <button
              aria-label={`移除环境 ${index + 1}`}
              className="engineering-remove-environment"
              onClick={() => removeEnvironment(environment.key)}
              type="button"
            >
              ×
            </button>
          ) : null}
        </article>
      ))}
    </section>
  );
}
