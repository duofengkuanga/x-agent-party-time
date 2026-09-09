import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { requireCurrentUser } from '@/platform/auth/server';
import { PlatformError } from '@/platform/errors';
import { workspaceService } from '@/cooking/runtime/services';
import { SubmissionIdSchema } from '@/cooking/submissions/contract';
import {
  SIDEBAR_COOKIE_NAME,
  readSidebarWidth,
} from '@/cooking/shared/ui/sidebar-width';
import { SubmissionWorkspace } from '@/cooking/submissions/ui/submission-workspace';

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
