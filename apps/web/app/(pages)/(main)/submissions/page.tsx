import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireCurrentUser } from '@/app/auth';
import { submissionService } from '@/server/runtime/services';
import {
  SIDEBAR_COOKIE_NAME,
  readSidebarWidth,
} from '@/app/(pages)/(main)/components/sidebarWidth';
import { SubmissionWorkspace } from '@/app/(pages)/(main)/submissions/components/submissionWorkspace';

export default async function SubmissionsPage() {
  const user = await requireCurrentUser();
  const cookieStore = await cookies();
  const initialSidebarWidth = readSidebarWidth(
    cookieStore.get(SIDEBAR_COOKIE_NAME)?.value,
  );
  const submissions = submissionService().listSubmissions(user.id);
  const active = submissions.find(
    ({ submission }) => submission.status === 'ACTIVE',
  );
  if (active) redirect(`/submissions/${active.submission.id}`);
  return (
    <SubmissionWorkspace
      currentUser={user}
      initialSnapshot={null}
      initialSubmissions={submissions}
      initialSidebarWidth={initialSidebarWidth}
    />
  );
}
