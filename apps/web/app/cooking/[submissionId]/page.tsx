import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { requireCurrentUser } from '@/server/auth/server';
import { PlatformError } from '@/server/errors';
import { workspaceService } from '@/features/cooking/application/server';
import { SubmissionIdSchema } from '@/features/cooking/submissions/contract';
import {
  SIDEBAR_COOKIE_NAME,
  readSidebarWidth,
} from '@/features/cooking/shared/sidebar-width';
import { SubmissionWorkspace } from '@/features/cooking/submissions/presentation/submission-workspace';

export default async function SubmissionWorkspacePage({
  params,
}: {
  params: Promise<{ submissionId: string }>;
}) {
  const user = await requireCurrentUser();
  const cookieStore = await cookies();
  const initialSidebarWidth = readSidebarWidth(
    cookieStore.get(SIDEBAR_COOKIE_NAME)?.value,
  );
  const parsedId = SubmissionIdSchema.safeParse((await params).submissionId);
  if (!parsedId.success) notFound();
  try {
    const snapshot = workspaceService().getWorkspace(user.id, parsedId.data);
    return (
      <SubmissionWorkspace
        currentUser={user}
        initialSnapshot={snapshot}
        initialSubmissions={snapshot.submissions}
        initialSidebarWidth={initialSidebarWidth}
      />
    );
  } catch (error) {
    if (error instanceof PlatformError && error.code === 'NOT_FOUND')
      notFound();
    throw error;
  }
}
