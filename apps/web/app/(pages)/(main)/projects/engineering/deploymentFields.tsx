'use client';

import { useState } from 'react';
import type { DeploymentMethod } from '../../../../../contracts/projects/engineering';

export function DeploymentFields({
  commandName = 'command',
  compact = false,
  deployment,
  kindName = 'deploymentKind',
  scriptCommand,
  scriptCommandName = 'scriptCommand',
}: {
  commandName?: string;
  compact?: boolean;
  deployment?: DeploymentMethod;
  kindName?: string;
  scriptCommand?: string;
  scriptCommandName?: string;
}) {
  const [kind, setKind] = useState<DeploymentMethod['kind']>(
    deployment?.kind ?? 'LOCAL_SCRIPT',
  );
  const [command, setCommand] = useState(
    deployment?.kind === 'LOCAL_SCRIPT'
      ? deployment.command
      : (scriptCommand ?? ''),
  );
  return (
    <>
      {kind === 'CI_CD' ? (
        <input name={scriptCommandName} type="hidden" value={command} />
      ) : null}
      {compact ? (
        <div
          className="deployment-kind-choice"
          role="radiogroup"
          aria-label="更新方式"
        >
          {(
            [
              { value: 'LOCAL_SCRIPT', label: '脚本部署' },
              { value: 'CI_CD', label: '持续集成' },
            ] as const
          ).map((option) => (
            <label key={option.value}>
              <input
                type="radio"
                name={kindName}
                value={option.value}
                checked={kind === option.value}
                onChange={() => setKind(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      ) : (
        <label>
          <span>更新方式</span>
          <select
            name={kindName}
            onChange={(event) =>
              setKind(event.target.value === 'CI_CD' ? 'CI_CD' : 'LOCAL_SCRIPT')
            }
            value={kind}
          >
            <option value="LOCAL_SCRIPT">本地脚本自动更新</option>
            <option value="CI_CD">CI/CD 人工确认</option>
          </select>
        </label>
      )}
      {kind === 'LOCAL_SCRIPT' ? (
        <label className="field-wide">
          <span>部署命令</span>
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            maxLength={4000}
            name={commandName}
            placeholder="例如：bun run deploy:test"
            required
          />
          <small>
            {compact
              ? '由本机 Agent 执行，密钥使用环境变量'
              : '不要填写令牌、密码或密钥；请在 Agent 本机使用环境变量。'}
          </small>
        </label>
      ) : compact ? (
        <div className="engineering-environment-note">
          <strong>由外部流水线部署</strong>
          <span>完成后由负责人确认结果</span>
        </div>
      ) : (
        <p className="engineering-environment-note">
          外部 CI/CD 完成构建与部署后，由开发人员回到系统确认结果。
        </p>
      )}
    </>
  );
}
