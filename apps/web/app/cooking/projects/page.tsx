import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ProjectSetup } from '@/components/project-setup';
import { DEMO_USERS } from '@/lib/auth/core';
import { requireCurrentUser } from '@/lib/auth/server';

export const metadata: Metadata = {
  title: '项目与工程 — Agent Party Time',
  description: '管理协作提测项目、成员、工程配置与本机 Agent 绑定。',
};

export default async function ProjectSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const user = await requireCurrentUser();
  if (user.accountType !== 'DEVELOPER') redirect('/cooking');

  const { project } = await searchParams;

  return (
    <ProjectSetup
      currentUser={user}
      initialProjectId={project}
      registeredDevelopers={DEMO_USERS.filter(
        (candidate) => candidate.accountType === 'DEVELOPER',
      ).map(({ password: _password, ...candidate }) => candidate)}
    />
  );
}
