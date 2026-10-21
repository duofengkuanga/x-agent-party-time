'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export function ProjectDialogEffects({ closeHref }: { closeHref: string }) {
  const router = useRouter();

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const overlay = document.querySelector<HTMLElement>('.repair-overlay');
    const dialog = overlay?.querySelector<HTMLElement>('[role="dialog"]');

    function close() {
      router.replace(closeHref);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }

    function closeOnBackdrop(event: MouseEvent) {
      if (event.target === overlay) close();
    }

    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', closeOnEscape);
    overlay?.addEventListener('mousedown', closeOnBackdrop);
    dialog?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeOnEscape);
      overlay?.removeEventListener('mousedown', closeOnBackdrop);
    };
  }, [closeHref, router]);

  return null;
}
