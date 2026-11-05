'use client';

import { useState, type ReactNode } from 'react';
import { ChoiceSelect } from '../../components/choiceSelect';
import { messageOf } from '../../components/actionError';
import { useAutoSaveFlush } from '../components/autoSaveForm';
import { NewEnvironmentRow } from './newEnvironmentRow';

export function EnvironmentSelect({
  environments,
  engineeringId,
}: {
  environments: Array<{
    id: string;
    name: string;
    key: string;
    editor?: ReactNode;
  }>;
  engineeringId?: string;
}) {
  const [selectedId, setSelectedId] = useState(environments.at(0)?.id);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flush = useAutoSaveFlush();
  const selected =
    environments.find(({ id }) => id === selectedId) ?? environments.at(0);

  async function selectEnvironment(id: string, nextEditing = editing) {
    setPending(true);
    setError(null);
    try {
      if (await flush()) {
        setSelectedId(id);
        setEditing(nextEditing);
      }
    } catch (error) {
      setError(messageOf(error, '修改尚未保存，请重试。'));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="environment-selector">
      <span className="engineering-field-label">测试环境</span>
      <div className="environment-selector__toolbar">
        {selected ? (
          <>
            <div className="collab-choice-field">
              <ChoiceSelect
                disabled={pending}
                label="测试环境"
                onChange={(id) => void selectEnvironment(id)}
                options={environments.map(({ id, name }) => ({
                  value: id,
                  label: name,
                }))}
                value={selected.id}
              />
            </div>
            <small className="environment-selector__key">
              标识 <code>{selected.key}</code>
            </small>
            {selected.editor ? (
              <button
                aria-expanded={editing}
                className="environment-edit"
                disabled={pending}
                onClick={() => void selectEnvironment(selected.id, !editing)}
                type="button"
              >
                {editing ? '收起编辑' : '编辑环境'}
              </button>
            ) : null}
          </>
        ) : (
          <span className="environment-selector__empty">还没有测试环境</span>
        )}
        {engineeringId ? (
          <NewEnvironmentRow engineeringId={engineeringId} />
        ) : null}
      </div>
      {editing && selected?.editor ? (
        <div className="environment-selector__editor" key={selected.id}>
          {selected.editor}
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
