import { notFound } from 'next/navigation';
import { requireCurrentUser } from '@/platform/auth/server';
import { PlatformError } from '@/platform/errors';
import { workspaceService } from '@/modules/cooking/application/server';
import { SubmissionIdSchema } from '@/modules/cooking/submissions/contract';
import { SubmissionWorkspace } from '@/modules/cooking/submissions/presentation/submission-workspace';

export default async function SubmissionWorkspacePage({
  params,
}: {
  params: Promise<{ submissionId: string }>;
}) {
  const user = await requireCurrentUser();
  const parsedId = SubmissionIdSchema.safeParse((await params).submissionId);
  if (!parsedId.success) notFound();
  try {
    const snapshot = workspaceService().getWorkspace(user.id, parsedId.data);
    return (
      <SubmissionWorkspace
        currentUser={user}
        initialSnapshot={snapshot}
        initialSubmissions={snapshot.submissions}
      />
    );
  } catch (error) {
    if (error instanceof PlatformError && error.code === 'NOT_FOUND')
      notFound();
    throw error;
  }
}
