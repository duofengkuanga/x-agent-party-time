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
        部署方式
        <select
          name="deploymentKind"
          onChange={(event) =>
            setKind(event.target.value === 'CI_CD' ? 'CI_CD' : 'LOCAL_SCRIPT')
          }
          value={kind}
        >
          <option value="LOCAL_SCRIPT">本地脚本</option>
          <option value="CI_CD">持续集成 / 持续交付</option>
        </select>
      </label>
      {kind === 'LOCAL_SCRIPT' ? (
        <label>
          本地部署命令
          <input
            defaultValue={
              deployment?.kind === 'LOCAL_SCRIPT' ? deployment.command : ''
            }
            name="command"
            placeholder="例如：bun run deploy:test"
            required
          />
        </label>
      ) : null}
    </>
  );
}
