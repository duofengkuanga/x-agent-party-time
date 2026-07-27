import { redirect } from 'next/navigation';
import { requireCurrentUser } from '@/server/auth/server';
import { submissionService } from '@/features/cooking/application/server';
import { SubmissionWorkspace } from '@/features/cooking/submissions/presentation/submission-workspace';

export default async function CookingHomePage() {
  const user = await requireCurrentUser();
  const submissions = submissionService().listSubmissions(user.id);
  const active = submissions.find(
    ({ submission }) => submission.status === 'ACTIVE',
  );
  if (active) redirect(`/cooking/${active.submission.id}`);
  return (
    <SubmissionWorkspace
      currentUser={user}
      initialSnapshot={null}
      initialSubmissions={submissions}
    />
  );
}
