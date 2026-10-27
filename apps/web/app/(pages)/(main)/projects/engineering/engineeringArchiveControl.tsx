'use client';

import { useId, useRef, useState } from 'react';
import type { Engineering } from '@/contracts/projects/engineering';
import { archiveEngineeringAction } from '@/app/actions/projects/engineering';
import { SaveButton } from '../components/saveButton';

export function EngineeringArchiveControl({
  engineering,
  mutationId,
}: {
  engineering: Engineering;
  mutationId: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  function cancel() {
    setConfirming(false);
    trigger.current?.focus();
  }
  if (engineering.archivedAt)
    return (
      <button className="engineering-archive-trigger" disabled type="button">
        已归档
      </button>
    );
  return (
    <>
      <button
        aria-controls={panelId}
        aria-expanded={confirming}
        className="engineering-archive-trigger"
        onClick={() => setConfirming((current) => !current)}
        ref={trigger}
        type="button"
      >
        归档工程
      </button>
      {confirming ? (
        <section
          aria-label="归档工程确认"
          className="engineering-archive-confirmation"
          id={panelId}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancel();
            }
          }}
        >
          <div>
            <strong>归档“{engineering.name}”？</strong>
            <p>
              停止继续使用此工程，保留工程配置及历史提测记录。正在参与活动提测的工程不能归档。
            </p>
          </div>
          <form action={archiveEngineeringAction}>
            <input name="engineeringId" type="hidden" value={engineering.id} />
            <input
              name="projectId"
              type="hidden"
              value={engineering.projectId}
            />
            <input
              name="expectedVersion"
              type="hidden"
              value={engineering.version}
            />
            <input name="mutationId" type="hidden" value={mutationId} />
            <button onClick={cancel} type="button">
              取消
            </button>
            <SaveButton pendingLabel="正在归档…">确认归档</SaveButton>
          </form>
        </section>
      ) : null}
    </>
  );
}
