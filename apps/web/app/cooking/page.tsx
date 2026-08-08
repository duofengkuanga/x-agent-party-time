import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireCurrentUser } from '@/server/auth/server';
import { submissionService } from '@/features/cooking/application/server';
import {
  SIDEBAR_COOKIE_NAME,
  readSidebarWidth,
} from '@/features/cooking/shared/sidebar-width';
import { SubmissionWorkspace } from '@/features/cooking/submissions/presentation/submission-workspace';

export default async function CookingHomePage() {
  const user = await requireCurrentUser();
  const cookieStore = await cookies();
  const initialSidebarWidth = readSidebarWidth(
    cookieStore.get(SIDEBAR_COOKIE_NAME)?.value,
  );
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
      initialSidebarWidth={initialSidebarWidth}
    />
  );
}
