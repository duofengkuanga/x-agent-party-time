'use client';

import { useState } from 'react';
import { createEnvironmentAction } from '@/app/actions/projects/engineering';
import { AutoSaveForm } from '../components/autoSaveForm';

export function NewEnvironmentRow({
  engineeringId,
}: {
  engineeringId: string;
}) {
  const [adding, setAdding] = useState(false);
  return adding ? (
    <AutoSaveForm
      className="environment-direct-form environment-direct-form--new"
      flushOnUnmount={false}
      lockWhileSaving
      onSaved={() => setAdding(false)}
      save={createEnvironmentAction}
    >
      <input name="engineeringId" type="hidden" value={engineeringId} />
      <label className="environment-direct-name">
        <span>环境名称</span>
        <input
          aria-label="新环境名称"
          autoFocus
          maxLength={120}
          name="name"
          placeholder="新环境名称"
          required
        />
      </label>
      <label>
        <span>环境标识</span>
        <input
          maxLength={40}
          name="environmentIdentifier"
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
          placeholder="例如 84"
          required
        />
      </label>
      <div className="environment-direct-form__hint">
        <small>填写完整后自动添加</small>
        <button onClick={() => setAdding(false)} type="button">
          取消
        </button>
      </div>
    </AutoSaveForm>
  ) : (
    <button
      className="environment-add"
      onClick={() => setAdding(true)}
      type="button"
    >
      ＋ 添加环境
    </button>
  );
}
