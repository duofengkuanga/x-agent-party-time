import { redirect } from 'next/navigation';
import { PartyDashboard } from '@/components/party-dashboard';
import { requireCurrentUser } from '@/lib/auth/server';
import { demoChannels, demoFeed, demoTasks } from '@/lib/demo-data';

export default async function Home() {
  const user = await requireCurrentUser();
  if (user.accountType === 'TESTER') redirect('/cooking');

  return (
    <PartyDashboard
      currentUser={user}
      initialChannels={demoChannels}
      initialFeed={demoFeed}
      initialTasks={demoTasks}
    />
  );
}
