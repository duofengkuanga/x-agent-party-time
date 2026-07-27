'use client';

import { useActionState } from 'react';
import { issueRunnerPairingCodeAction, type PairingCodeState } from './actions';

const INITIAL_STATE: PairingCodeState = {
  code: null,
  expiresAt: null,
  error: null,
};

export function PairingCodeForm() {
  const [state, action, pending] = useActionState(
    issueRunnerPairingCodeAction,
    INITIAL_STATE,
  );
  return (
    <div className="pairing-card">
      <form action={action}>
        <button disabled={pending} type="submit">
          {pending ? '正在生成…' : '生成一次性配对码'}
        </button>
      </form>
      {state.error ? (
        <p className="notice notice-error">{state.error}</p>
      ) : null}
      {state.code && state.expiresAt ? (
        <div className="pairing-result" role="status">
          <span>本机 Runner 配对码</span>
          <strong>{state.code}</strong>
          <p>
            请在 {new Date(state.expiresAt).toLocaleTimeString('zh-CN')}{' '}
            前使用。 配对成功后此码立即失效。
          </p>
        </div>
      ) : null}
    </div>
  );
}
