import { randomBytes, randomUUID } from 'node:crypto';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import {
  PairingCodeIssueSchema,
  PairingCodeSchema,
  RunnerCredentialSchema,
  RunnerNameSchema,
  RunnerPairingResultSchema,
  RunnerSchema,
  RunnerStatusSchema,
  type PairingCodeIssue,
  type RunnerAuthorizationClaimResponse,
  type RunnerAuthorizationIssue,
  type Runner,
  type RunnerPairingResult,
  type RunnerStatus,
} from './contract';
import {
  RunnerAuthorizationRequests,
  type RunnerAuthorizationApproval,
  type RunnerAuthorizationBrowserView,
} from './authorization';
import { hashSecret, mapRunner, type RunnerRow } from './runner-storage';

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
  private readonly authorizations: RunnerAuthorizationRequests;

  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    private readonly secrets: RunnerSecrets = DEFAULT_SECRETS,
    private readonly offlineAfterMs: number = DEFAULT_OFFLINE_AFTER_MS,
    private readonly hasActiveExecutions: (runnerId: string) => boolean = () =>
      false,
  ) {
    this.authorizations = new RunnerAuthorizationRequests(
      db,
      now,
      createId,
      () => secrets.credential(),
    );
  }

  issuePairingCode(
    ownerUserId: string,
    durationMs: number = DEFAULT_PAIRING_DURATION_MS,
  ): PairingCodeIssue {
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0)
      throw new PlatformError('VALIDATION_FAILED', '配对码有效期无效');
    const code = PairingCodeSchema.parse(this.secrets.pairingCode());
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + durationMs).toISOString();
    this.db.run(
      `INSERT INTO platform_runner_pairing_code(
           id, owner_user_id, code_hash, expires_at, used_at, created_at
         ) VALUES (?, ?, ?, ?, NULL, ?)`,
      [
        this.createId(),
        ownerUserId,
        hashSecret(code),
        expiresAt,
        createdAt.toISOString(),
      ],
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
      const pairing = this.db.get(
        `SELECT id, owner_user_id, code_hash, expires_at, used_at, created_at
           FROM platform_runner_pairing_code WHERE code_hash = ?`,
        codeHash,
      ) as PairingCodeRow | undefined;
      const now = this.now();
      if (
        !pairing ||
        pairing.used_at ||
        Date.parse(pairing.expires_at) <= now.getTime()
      )
        throw invalidPairingCode();
      const use = this.db.run(
        `UPDATE platform_runner_pairing_code SET used_at = ?
           WHERE id = ? AND used_at IS NULL`,
        [now.toISOString(), pairing.id],
      );
      if (use.changes !== 1) throw invalidPairingCode();

      const credential = RunnerCredentialSchema.parse(
        this.secrets.credential(),
      );
      const runnerId = this.createId();
      const stored = this.db.get<RunnerRow>(
        `INSERT INTO platform_runner(
             id, owner_user_id, name, credential_hash, version,
             last_seen_at, revoked_at, created_at
           ) VALUES (?, ?, ?, ?, 1, NULL, NULL, ?) RETURNING *`,
        runnerId,
        pairing.owner_user_id,
        name,
        hashSecret(credential),
        now.toISOString(),
      );
      return RunnerPairingResultSchema.parse({
        runner: mapRunner(stored!),
        credential,
      });
    })();
  }

  createAuthorizationRequest(
    inputValue: unknown,
    durationMs?: number,
  ): RunnerAuthorizationIssue {
    return this.authorizations.createAuthorizationRequest(
      inputValue,
      durationMs,
    );
  }

  prepareAuthorizationApproval(
    ownerUserId: string,
    requestIdInput: string,
  ): RunnerAuthorizationApproval {
    return this.authorizations.prepareAuthorizationApproval(
      ownerUserId,
      requestIdInput,
    );
  }

  approveAuthorization(
    ownerUserId: string,
    requestIdInput: string,
    approvalToken: string,
    nameInput: string,
  ): RunnerAuthorizationBrowserView {
    return this.authorizations.approveAuthorization(
      ownerUserId,
      requestIdInput,
      approvalToken,
      nameInput,
    );
  }

  rejectAuthorization(
    ownerUserId: string,
    requestIdInput: string,
    approvalToken: string,
  ): RunnerAuthorizationBrowserView {
    return this.authorizations.rejectAuthorization(
      ownerUserId,
      requestIdInput,
      approvalToken,
    );
  }

  claimAuthorization(
    requestIdInput: string,
    verifierInput: string,
  ): RunnerAuthorizationClaimResponse {
    return this.authorizations.claimAuthorization(
      requestIdInput,
      verifierInput,
    );
  }

  authenticateCredential(credentialInput: string | undefined): Runner {
    const parsed = RunnerCredentialSchema.safeParse(credentialInput);
    if (!parsed.success) throw invalidCredential();
    const row = this.db.get(
      `SELECT id, owner_user_id, name, credential_hash, version,
                last_seen_at, revoked_at, created_at
         FROM platform_runner WHERE credential_hash = ?`,
      hashSecret(parsed.data),
    ) as RunnerRow | undefined;
    if (!row || row.revoked_at) throw invalidCredential();
    return mapRunner(row);
  }

  heartbeat(credential: string | undefined, availableSlots = 3): Runner {
    const runner = this.authenticateCredential(credential);
    const lastSeenAt = this.now().toISOString();
    this.db.run(
      `UPDATE platform_runner
         SET last_seen_at = ?, available_slots = ?
         WHERE id = ? AND revoked_at IS NULL`,
      [lastSeenAt, availableSlots, runner.id],
    );
    return RunnerSchema.parse({ ...runner, lastSeenAt });
  }

  revokeSelf(credential: string | undefined): Runner {
    const runner = this.authenticateCredential(credential);
    return this.revokeRunner(runner.ownerUserId, runner.id, runner.version);
  }

  listRunners(ownerUserId: string): RunnerStatus[] {
    const now = this.now().getTime();
    return this.db
      .all(
        `SELECT id, owner_user_id, name, credential_hash, version,
                last_seen_at, revoked_at, created_at
         FROM platform_runner
         WHERE owner_user_id = ?
         ORDER BY revoked_at IS NOT NULL, created_at DESC, id`,
        ownerUserId,
      )
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
    return this.setRevoked(ownerUserId, runnerId, expectedVersion, true);
  }

  reactivateRunner(
    ownerUserId: string,
    runnerId: string,
    expectedVersion: number,
  ): Runner {
    return this.setRevoked(ownerUserId, runnerId, expectedVersion, false);
  }

  private setRevoked(
    ownerUserId: string,
    runnerId: string,
    expectedVersion: number,
    revoke: boolean,
  ): Runner {
    return this.db.transaction(() => {
      const row = this.db.get(
        `SELECT id, owner_user_id, name, credential_hash, version,
                  last_seen_at, revoked_at, created_at
           FROM platform_runner
           WHERE id = ? AND owner_user_id = ?`,
        runnerId,
        ownerUserId,
      ) as RunnerRow | undefined;
      if (!row) throw new PlatformError('NOT_FOUND', 'Agent 不存在或无权访问');
      if (Boolean(row.revoked_at) === revoke) return mapRunner(row);
      if (row.version !== expectedVersion)
        throw new PlatformError('STALE_STATE', 'Agent 已更新，请刷新后重试');
      if (revoke && this.hasActiveExecutions(runnerId))
        throw new PlatformError(
          'RESOURCE_CONFLICT',
          'Agent 仍有活动执行，暂时不能停用',
        );
      const revokedAt = revoke ? this.now().toISOString() : null;
      const updated = this.db.get<RunnerRow>(
        `UPDATE platform_runner
           SET revoked_at = ?,
               last_seen_at = CASE WHEN ? = 1 THEN last_seen_at ELSE NULL END,
               version = version + 1
           WHERE id = ? AND owner_user_id = ? AND version = ?
             AND revoked_at IS ${revoke ? 'NULL' : 'NOT NULL'} RETURNING *`,
        revokedAt,
        Number(revoke),
        runnerId,
        ownerUserId,
        expectedVersion,
      );
      if (!updated)
        throw new PlatformError('STALE_STATE', 'Agent 已更新，请刷新后重试');
      return mapRunner(updated);
    })();
  }
}

function invalidPairingCode(): PlatformError {
  return new PlatformError('AUTHENTICATION_FAILED', '配对码无效或已过期');
}

function invalidCredential(): PlatformError {
  return new PlatformError('NOT_AUTHENTICATED', 'Agent 授权凭据无效或已撤销');
}
