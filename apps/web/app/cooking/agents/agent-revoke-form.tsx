'use client';

import { useState } from 'react';
import { revokeRunnerAction } from '@/server/runner/actions';

export function AgentRevokeForm({
  disabled,
  expectedVersion,
  runnerId,
}: {
  disabled: boolean;
  expectedVersion: number;
  runnerId: string;
}) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <form action={revokeRunnerAction} className="agent-revoke">
      <input name="runnerId" type="hidden" value={runnerId} />
      <input name="expectedVersion" type="hidden" value={expectedVersion} />
      <strong>{disabled ? '此 Agent 已停用' : '停用 Agent'}</strong>
      <p>
        {disabled
          ? '已停用的 Agent 不再领取任务。'
          : '停用后该 Agent 不再领取任务，已有工程绑定仍会保留。'}
      </p>
      {disabled ? null : (
        <label>
          <input
            checked={confirmed}
            name="confirmed"
            onChange={(event) => setConfirmed(event.target.checked)}
            type="checkbox"
            value="yes"
          />
          <span>我已了解影响</span>
        </label>
      )}
      <button disabled={disabled || !confirmed} type="submit">
        {disabled ? '已停用' : '确认停用'}
      </button>
    </form>
  );
}
