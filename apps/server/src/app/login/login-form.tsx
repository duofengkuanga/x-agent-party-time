'use client';

import { useActionState } from 'react';
import { loginAction, type LoginState } from './actions';

const INITIAL_STATE: LoginState = { error: null };

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(loginAction, INITIAL_STATE);
  return (
    <form action={action} className="login-card">
      <input name="next" type="hidden" value={next} />
      <div className="login-heading">
        <span className="eyebrow">Agent Party Time</span>
        <h1>登录协作工作台</h1>
        <p>the agents is having a party</p>
      </div>
      <label>
        用户名
        <input autoComplete="username" name="username" required />
      </label>
      <label>
        密码
        <input
          autoComplete="current-password"
          name="password"
          required
          type="password"
        />
      </label>
      {state.error ? <p className="form-error">{state.error}</p> : null}
      <button disabled={pending} type="submit">
        {pending ? '正在登录…' : '登录'}
      </button>
      <small>当前为开发环境账号，用户由本地初始化脚本创建。</small>
    </form>
  );
}
