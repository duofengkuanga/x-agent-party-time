'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  engineeringSettingsPath,
  projectSettingsPath,
} from '../components/routeState';
import { EngineeringCreateModal } from './engineeringCreateModal';

export function EngineeringCreateControl({
  children,
  initialEngineeringId,
  projectId,
}: {
  children: ReactNode;
  initialEngineeringId?: string;
  projectId: string;
}) {
  const search = useSearchParams();
  const router = useRouter();
  const requestedEngineering = search.get('engineering');
  const creating = requestedEngineering === 'new';
  const success = search.get('success');
  const [open, setOpen] = useState(creating);
  const [generation, setGeneration] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const returnEngineering = useRef(initialEngineeringId);
  useEffect(() => {
    setOpen(creating);
  }, [creating, requestedEngineering, projectId]);
  useEffect(() => {
    if (success !== '工程已加入') return;
    setOpen(false);
    setGeneration((current) => current + 1);
  }, [success]);
  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className="project-engineering-create-trigger"
        onClick={() => {
          if (requestedEngineering && requestedEngineering !== 'new')
            returnEngineering.current = requestedEngineering;
          setOpen(true);
        }}
        ref={trigger}
        type="button"
      >
        加入工程
      </button>
      <EngineeringCreateModal
        onClose={() => {
          setOpen(false);
          trigger.current?.focus();
          if (creating)
            router.replace(
              returnEngineering.current
                ? engineeringSettingsPath(projectId, returnEngineering.current)
                : projectSettingsPath({ projectId }),
              { scroll: false },
            );
        }}
        open={open}
      >
        <div key={generation}>{children}</div>
      </EngineeringCreateModal>
    </>
  );
}
