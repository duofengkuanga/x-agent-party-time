import { currentUser } from '@/app/auth';

export async function GET() {
  const user = await currentUser();
  if (!user)
    return Response.json(
      { error: { code: 'NOT_AUTHENTICATED', message: '请先登录。' } },
      { status: 401 },
    );
  return Response.json({ user });
}
