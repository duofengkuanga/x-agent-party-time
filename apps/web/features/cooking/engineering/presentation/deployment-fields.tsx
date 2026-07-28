'use client';

import { useState } from 'react';
import type { DeploymentMethod } from '../contract';

export function DeploymentFields({
  deployment,
}: {
  deployment?: DeploymentMethod;
}) {
  const [kind, setKind] = useState<DeploymentMethod['kind']>(
    deployment?.kind ?? 'LOCAL_SCRIPT',
  );
  return (
    <>
      <label>
        <span>更新方式</span>
        <select
          name="deploymentKind"
          onChange={(event) =>
            setKind(event.target.value === 'CI_CD' ? 'CI_CD' : 'LOCAL_SCRIPT')
          }
          value={kind}
        >
          <option value="LOCAL_SCRIPT">本地脚本自动更新</option>
          <option value="CI_CD">CI/CD 人工确认</option>
        </select>
      </label>
      {kind === 'LOCAL_SCRIPT' ? (
        <label className="field-wide">
          <span>部署命令</span>
          <input
            defaultValue={
              deployment?.kind === 'LOCAL_SCRIPT' ? deployment.command : ''
            }
            name="command"
            placeholder="例如：bun run deploy:test"
            required
          />
          <small>
            不要填写令牌、密码或密钥；请在 Runner 本机使用环境变量。
          </small>
        </label>
      ) : (
        <p className="engineering-environment-note">
          外部 CI/CD 完成构建与部署后，由开发人员回到系统确认结果。
        </p>
      )}
    </>
  );
}
