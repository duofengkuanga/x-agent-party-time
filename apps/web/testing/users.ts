import type { User } from '@/platform/auth/contract';
import type { AuthService } from '@/platform/auth/service';

type TestPerson = [username: string, displayName: string, id?: string];

export function seedTestUser(
  auth: AuthService,
  [username, displayName, id = username]: TestPerson,
  password = 'password',
): Promise<User> {
  return auth.seedUser({ id, username, displayName, password });
}

/** Seed named users in insertion order; omitted IDs match usernames. */
export async function seedUsers<K extends string>(
  auth: AuthService,
  people: Record<K, TestPerson>,
  password = 'password',
): Promise<Record<K, User>> {
  const users = {} as Record<K, User>;
  for (const key of Object.keys(people) as K[])
    users[key] = await seedTestUser(auth, people[key], password);
  return users;
}
