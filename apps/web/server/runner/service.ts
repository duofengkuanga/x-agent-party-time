import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AppDatabase } from '@/server/database';
import { PlatformError } from '@/server/errors';
import {
  PairingCodeIssueSchema,
  PairingCodeSchema,
  RunnerCredentialSchema,
  RunnerNameSchema,
  RunnerPairingResultSchema,
  RunnerSchema,
  RunnerStatusSchema,
  type PairingCodeIssue,
  type Runner,
  type RunnerPairingResult,
  type RunnerStatus,
} from './contract';

type RunnerRow = {
  id: string;
  owner_user_id: string;
  name: string;
  credential_hash: string;
  version: number;
  last_seen_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

type PairingCodeRow = {
  id: string;
  owner_user_id: string;
  code_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
};

export type RunnerSecrets = {
  pairingCode: () => string;
  credential: () => string;
};

const DEFAULT_PAIRING_DURATION_MS = 5 * 60 * 1_000;
const DEFAULT_OFFLINE_AFTER_MS = 30 * 1_000;

const DEFAULT_SECRETS: RunnerSecrets = {
  pairingCode: () => {
    const value = randomBytes(8).toString('hex').toUpperCase();
    return value.match(/.{4}/gu)!.join('-');
  },
  credential: () => randomBytes(32).toString('base64url'),
};

export class RunnerService {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    private readonly secrets: RunnerSecrets = DEFAULT_SECRETS,
    private readonly offlineAfterMs: number = DEFAULT_OFFLINE_AFTER_MS,
    private readonly hasActiveExecutions: (runnerId: string) => boolean = () =>
      false,
  ) {}

  issuePairingCode(
    ownerUserId: string,
    durationMs: number = DEFAULT_PAIRING_DURATION_MS,
  ): PairingCodeIssue {
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0)
      throw new PlatformError('VALIDATION_FAILED', '配对码有效期无效');
    const code = PairingCodeSchema.parse(this.secrets.pairingCode());
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + durationMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO platform_runner_pairing_code(
           id, owner_user_id, code_hash, expires_at, used_at, created_at
         ) VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        this.createId(),
        ownerUserId,
        hashSecret(code),
        expiresAt,
        createdAt.toISOString(),
      );
    return PairingCodeIssueSchema.parse({ code, expiresAt });
  }

  pair(codeInput: string, nameInput: string): RunnerPairingResult {
    const parsedCode = PairingCodeSchema.safeParse(
      codeInput.trim().toUpperCase(),
    );
    const name = RunnerNameSchema.parse(nameInput);
    if (!parsedCode.success) throw invalidPairingCode();
    const codeHash = hashSecret(parsedCode.data);

    return this.db.transaction(() => {
      const pairing = this.db
        .prepare(
          `SELECT id, owner_user_id, code_hash, expires_at, used_at, created_at
           FROM platform_runner_pairing_code WHERE code_hash = ?`,
        )
        .get(codeHash) as PairingCodeRow | undefined;
      const now = this.now();
      if (
        !pairing ||
        pairing.used_at ||
        Date.parse(pairing.expires_at) <= now.getTime()
      )
        throw invalidPairingCode();
      const use = this.db
        .prepare(
          `UPDATE platform_runner_pairing_code SET used_at = ?
           WHERE id = ? AND used_at IS NULL`,
        )
        .run(now.toISOString(), pairing.id);
      if (use.changes !== 1) throw invalidPairingCode();

      const credential = RunnerCredentialSchema.parse(
        this.secrets.credential(),
      );
      const runnerId = this.createId();
      this.db
        .prepare(
          `INSERT INTO platform_runner(
             id, owner_user_id, name, credential_hash, version,
             last_seen_at, revoked_at, created_at
           ) VALUES (?, ?, ?, ?, 1, NULL, NULL, ?)`,
        )
        .run(
          runnerId,
          pairing.owner_user_id,
          name,
          hashSecret(credential),
          now.toISOString(),
        );
      return RunnerPairingResultSchema.parse({
        runner: {
          id: runnerId,
          ownerUserId: pairing.owner_user_id,
          name,
          version: 1,
          lastSeenAt: null,
          revokedAt: null,
          createdAt: now.toISOString(),
        },
        credential,
      });
    })();
  }

  authenticateCredential(credentialInput: string | undefined): Runner {
    const parsed = RunnerCredentialSchema.safeParse(credentialInput);
    if (!parsed.success) throw invalidCredential();
    const row = this.db
      .prepare(
        `SELECT id, owner_user_id, name, credential_hash, version,
                last_seen_at, revoked_at, created_at
         FROM platform_runner WHERE credential_hash = ?`,
      )
      .get(hashSecret(parsed.data)) as RunnerRow | undefined;
    if (!row || row.revoked_at) throw invalidCredential();
    return mapRunner(row);
  }

  heartbeat(credential: string | undefined): Runner {
    const runner = this.authenticateCredential(credential);
    const lastSeenAt = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE platform_runner SET last_seen_at = ?
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(lastSeenAt, runner.id);
    return RunnerSchema.parse({ ...runner, lastSeenAt });
  }

  listRunners(ownerUserId: string): RunnerStatus[] {
    const now = this.now().getTime();
    return this.db
      .prepare(
        `SELECT id, owner_user_id, name, credential_hash, version,
                last_seen_at, revoked_at, created_at
         FROM platform_runner
         WHERE owner_user_id = ?
         ORDER BY revoked_at IS NOT NULL, created_at DESC, id`,
      )
      .all(ownerUserId)
      .map((row) => {
        const runner = mapRunner(row as RunnerRow);
        const online = Boolean(
          !runner.revokedAt &&
          runner.lastSeenAt &&
          now - Date.parse(runner.lastSeenAt) <= this.offlineAfterMs,
        );
        return RunnerStatusSchema.parse({ runner, online });
      });
  }

  revokeRunner(
    ownerUserId: string,
    runnerId: string,
    expectedVersion: number,
  ): Runner {
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT id, owner_user_id, name, credential_hash, version,
                  last_seen_at, revoked_at, created_at
           FROM platform_runner
           WHERE id = ? AND owner_user_id = ?`,
        )
        .get(runnerId, ownerUserId) as RunnerRow | undefined;
      if (!row) throw new PlatformError('NOT_FOUND', 'Agent 不存在或无权访问');
      if (row.revoked_at) return mapRunner(row);
      if (row.version !== expectedVersion)
        throw new PlatformError('STALE_STATE', 'Agent 已更新，请刷新后重试');
      if (this.hasActiveExecutions(runnerId))
        throw new PlatformError(
          'RESOURCE_CONFLICT',
          'Agent 仍有活动执行，暂时不能停用',
        );
      const revokedAt = this.now().toISOString();
      const update = this.db
        .prepare(
          `UPDATE platform_runner
           SET revoked_at = ?, version = version + 1
           WHERE id = ? AND owner_user_id = ? AND version = ?
             AND revoked_at IS NULL`,
        )
        .run(revokedAt, runnerId, ownerUserId, expectedVersion);
      if (update.changes !== 1)
        throw new PlatformError('STALE_STATE', 'Agent 已更新，请刷新后重试');
      return RunnerSchema.parse({
        ...mapRunner(row),
        revokedAt,
        version: row.version + 1,
      });
    })();
  }
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function mapRunner(row: RunnerRow): Runner {
  return RunnerSchema.parse({
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    version: row.version,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  });
}

function invalidPairingCode(): PlatformError {
  return new PlatformError('AUTHENTICATION_FAILED', '配对码无效或已过期');
}

function invalidCredential(): PlatformError {
  return new PlatformError('NOT_AUTHENTICATED', 'Runner 凭据无效或已撤销');
}
