'use client';

import { useEffect, useState } from 'react';
import type { EngineeringMembership } from '@/contracts/projects/engineering';
import {
  addEngineeringMemberAction,
  removeEngineeringMemberAction,
} from '@/app/actions/projects/engineering';
import { createClientId } from '../../components/clientId';
import { messageOf } from '../../components/actionError';

export function EngineeringMemberToggle({
  engineeringId,
  userId,
  name,
  membership,
}: {
  engineeringId: string;
  userId: string;
  name: string;
  membership?: EngineeringMembership;
}) {
  const [current, setCurrent] = useState(membership);
  const [pending, setPending] = useState(false);
  const [checked, setChecked] = useState(Boolean(membership));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!pending) {
      setCurrent(membership);
      setChecked(Boolean(membership));
    }
  }, [membership]);

  async function change(next: boolean) {
    setChecked(next);
    setPending(true);
    setError(null);
    try {
      const data = new FormData();
      data.set('engineeringId', engineeringId);
      data.set('userId', userId);
      data.set('mutationId', createClientId());
      if (current) data.set('expectedVersion', String(current.version));
      if (next) {
        const result = await addEngineeringMemberAction(data);
        if (!result.ok) {
          setError(result.error.message);
          setChecked(Boolean(current));
        } else setCurrent(result.result);
      } else {
        const result = await removeEngineeringMemberAction(data);
        if (!result.ok) {
          setError(result.error.message);
          setChecked(Boolean(current));
        } else setCurrent(undefined);
      }
    } catch (error) {
      setChecked(Boolean(current));
      setError(messageOf(error, '成员变更未完成。'));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="engineering-member-toggle" aria-busy={pending}>
      <label>
        <input
          aria-label={`${name}的工程成员资格`}
          checked={checked}
          disabled={pending}
          onChange={(event) => void change(event.target.checked)}
          type="checkbox"
        />
        <span>{name}</span>
      </label>
      {pending ? <small role="status">保存中…</small> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
