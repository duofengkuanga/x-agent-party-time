import { createHash, randomBytes } from 'node:crypto';
import type { AppDatabase } from '@/server/database';
import { PlatformError } from '@/server/errors';
import {
  DisplayNameSchema,
  UserIdSchema,
  UserSchema,
  UsernameSchema,
  type User,
} from './contract';
import { hashPassword, verifyPassword } from './password';

type UserRow = {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  created_at: string;
};

type SessionUserRow = UserRow & {
  expires_at: string;
};

export type SeedUserInput = {
  id: string;
  username: string;
  displayName: string;
  password: string;
};

export type SessionToken = {
  token: string;
  expiresAt: string;
};

export class AuthService {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async seedUser(input: SeedUserInput): Promise<User> {
    const id = UserIdSchema.parse(input.id);
    const username = UsernameSchema.parse(input.username.toLowerCase());
    const displayName = DisplayNameSchema.parse(input.displayName);
    if (!input.password)
      throw new PlatformError('VALIDATION_FAILED', '开发 Seed 密码不能为空');

    const existing = this.db
      .prepare(
        `SELECT id, username, display_name, password_hash, created_at
         FROM platform_user
         WHERE id = ? OR username = ? COLLATE NOCASE`,
      )
      .get(id, username) as UserRow | undefined;

    if (existing) {
      if (existing.id !== id || existing.username.toLowerCase() !== username)
        throw new PlatformError(
          'RESOURCE_CONFLICT',
          `Seed 用户 ${username} 与现有用户冲突`,
        );
      return mapUser(existing);
    }

    const createdAt = this.now().toISOString();
    const passwordHash = await hashPassword(input.password);
    this.db
      .prepare(
        `INSERT INTO platform_user(id, username, display_name, password_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, username, displayName, passwordHash, createdAt);
    return UserSchema.parse({ id, username, displayName, createdAt });
  }

  async authenticate(username: string, password: string): Promise<User | null> {
    const normalized = username.trim().toLowerCase();
    const parsedUsername = UsernameSchema.safeParse(normalized);
    if (!parsedUsername.success || !password) return null;

    const row = this.db
      .prepare(
        `SELECT id, username, display_name, password_hash, created_at
         FROM platform_user
         WHERE username = ? COLLATE NOCASE`,
      )
      .get(parsedUsername.data) as UserRow | undefined;
    if (!row || !(await verifyPassword(password, row.password_hash)))
      return null;
    return mapUser(row);
  }

  createSession(userId: string, durationMs: number): SessionToken {
    UserIdSchema.parse(userId);
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0)
      throw new PlatformError('VALIDATION_FAILED', 'Session 有效期无效');

    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + durationMs).toISOString();
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM platform_session WHERE expires_at <= ?')
        .run(createdAt.toISOString());
      this.db
        .prepare(
          `INSERT INTO platform_session(token_hash, user_id, expires_at, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(tokenHash, userId, expiresAt, createdAt.toISOString());
    })();
    return { token, expiresAt };
  }

  currentUser(token: string | undefined): User | null {
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.password_hash, u.created_at,
                s.expires_at
         FROM platform_session s
         JOIN platform_user u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(hashToken(token)) as SessionUserRow | undefined;
    if (!row) return null;

    if (Date.parse(row.expires_at) <= this.now().getTime()) {
      this.db
        .prepare('DELETE FROM platform_session WHERE token_hash = ?')
        .run(hashToken(token));
      return null;
    }
    return mapUser(row);
  }

  revokeSession(token: string | undefined): void {
    if (!token) return;
    this.db
      .prepare('DELETE FROM platform_session WHERE token_hash = ?')
      .run(hashToken(token));
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function mapUser(row: UserRow): User {
  return UserSchema.parse({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    createdAt: row.created_at,
  });
}
