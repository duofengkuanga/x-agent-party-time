'use client';

import { useState } from 'react';
import { createEnvironmentAction } from '@/app/actions/projects/engineering';
import { AutoSaveForm } from '../components/autoSaveForm';
import { DeploymentFields } from './deploymentFields';

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
        <input
          aria-label="新环境名称"
          autoFocus
          maxLength={120}
          name="name"
          placeholder="新环境名称"
          required
        />
      </label>
      <DeploymentFields compact />
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
