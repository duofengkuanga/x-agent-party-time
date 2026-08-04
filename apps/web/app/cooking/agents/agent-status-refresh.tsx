'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export function AgentStatusRefresh() {
  const router = useRouter();

  useEffect(() => {
    const interval = window.setInterval(() => router.refresh(), 1_000);
    return () => window.clearInterval(interval);
  }, [router]);

  return null;
}
