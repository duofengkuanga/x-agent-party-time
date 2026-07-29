'use client';

import { useState } from 'react';
import {
  reactivateRunnerAction,
  revokeRunnerAction,
} from '@/server/runner/actions';

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
  if (disabled)
    return (
      <form action={reactivateRunnerAction} className="agent-revoke">
        <input name="runnerId" type="hidden" value={runnerId} />
        <input name="expectedVersion" type="hidden" value={expectedVersion} />
        <strong>此 Agent 已停用</strong>
        <p>重新启用后，本机 Agent 可继续连接，已有工程绑定保持不变。</p>
        <button type="submit">重新启用</button>
      </form>
    );

  return (
    <form action={revokeRunnerAction} className="agent-revoke">
      <input name="runnerId" type="hidden" value={runnerId} />
      <input name="expectedVersion" type="hidden" value={expectedVersion} />
      <strong>停用 Agent</strong>
      <p>停用后该 Agent 不再领取任务，已有工程绑定仍会保留。</p>
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
      <button disabled={!confirmed} type="submit">
        确认停用
      </button>
    </form>
  );
}
