import type { Metadata } from 'next';
import { CollaborativeSubmissionWorkspace } from '@/components/collaborative-submission-workspace';
import { DEMO_USERS } from '@/lib/auth/core';
import { requireCurrentUser } from '@/lib/auth/server';

export const metadata: Metadata = {
  title: '协作提测 — Agent Party Time',
  description: '多工程协作提测、Codex 修复、更新与验证工作台。',
};

export default async function CookingPage() {
  const user = await requireCurrentUser();
  return (
    <CollaborativeSubmissionWorkspace
      currentUser={user}
      registeredUsers={DEMO_USERS.map(
        ({ password: _password, ...candidate }) => candidate,
      )}
    />
  );
}
