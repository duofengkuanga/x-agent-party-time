import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AppDatabase } from '@/server/database';
import { PlatformError } from '@/server/errors';
import {
  PairingCodeIssueSchema,
  PairingCodeSchema,
  RunnerAuthorizationClaimResponseSchema,
  RunnerAuthorizationCreateRequestSchema,
  RunnerAuthorizationIssueSchema,
  RunnerAuthorizationRequestIdSchema,
  RunnerAuthorizationVerifierSchema,
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

type AuthorizationRequestRow = {
  id: string;
  installation_id: string;
  verifier_hash: string;
  fingerprint: string;
  suggested_name: string;
  approved_name: string | null;
  owner_user_id: string | null;
  state: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CONSUMED';
  approval_token_hash: string | null;
  expires_at: string;
  approved_at: string | null;
  consumed_at: string | null;
  last_polled_at: string | null;
  poll_count: number;
  created_at: string;
};

export type RunnerAuthorizationBrowserView = {
  requestId: string;
  fingerprint: string;
  suggestedName: string;
  state: AuthorizationRequestRow['state'] | 'EXPIRED';
  expiresAt: string;
  createdAt: string;
};

export type RunnerAuthorizationApproval = RunnerAuthorizationBrowserView & {
  approvalToken: string | null;
};

export type RunnerSecrets = {
  pairingCode: () => string;
  credential: () => string;
};

const DEFAULT_PAIRING_DURATION_MS = 5 * 60 * 1_000;
const DEFAULT_AUTHORIZATION_DURATION_MS = 5 * 60 * 1_000;
const MIN_AUTHORIZATION_POLL_MS = 750;
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

  createAuthorizationRequest(
    inputValue: unknown,
    durationMs: number = DEFAULT_AUTHORIZATION_DURATION_MS,
  ): RunnerAuthorizationIssue {
    const input = RunnerAuthorizationCreateRequestSchema.parse(inputValue);
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0)
      throw new PlatformError('VALIDATION_FAILED', '授权请求有效期无效');
    const now = this.now();
    const recentSince = new Date(now.getTime() - 60_000).toISOString();
    const recent = this.db
      .prepare(
        `SELECT COUNT(*) count
         FROM platform_runner_authorization_request
         WHERE created_at >= ?`,
      )
      .get(recentSince) as { count: number };
    if (recent.count >= 100)
      throw new PlatformError(
        'RESOURCE_CONFLICT',
        '授权请求过于频繁，请稍后重试',
      );
    const duplicate = this.db
      .prepare(
        `SELECT COUNT(*) count
         FROM platform_runner_authorization_request
         WHERE installation_id = ? AND state = 'PENDING' AND expires_at > ?`,
      )
      .get(input.installationId, now.toISOString()) as { count: number };
    if (duplicate.count >= 3)
      throw new PlatformError(
        'RESOURCE_CONFLICT',
        '这台 Agent 的待处理授权请求过多',
      );
    const requestId = randomBytes(24).toString('base64url');
    const expiresAt = new Date(now.getTime() + durationMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO platform_runner_authorization_request(
           id, installation_id, verifier_hash, fingerprint, suggested_name, approved_name,
           owner_user_id, state, approval_token_hash, expires_at,
           approved_at, consumed_at, last_polled_at, poll_count, created_at
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'PENDING', NULL, ?, NULL, NULL, NULL, 0, ?)`,
      )
      .run(
        requestId,
        input.installationId,
        input.verifierHash,
        input.fingerprint,
        input.suggestedName,
        expiresAt,
        now.toISOString(),
      );
    return RunnerAuthorizationIssueSchema.parse({ requestId, expiresAt });
  }

  prepareAuthorizationApproval(
    ownerUserId: string,
    requestIdInput: string,
  ): RunnerAuthorizationApproval {
    const requestId = RunnerAuthorizationRequestIdSchema.parse(requestIdInput);
    const row = this.authorizationRequest(requestId);
    const view = authorizationBrowserView(row, this.now());
    if (view.state !== 'PENDING') return { ...view, approvalToken: null };
    const approvalToken = randomBytes(32).toString('base64url');
    const update = this.db
      .prepare(
        `UPDATE platform_runner_authorization_request
         SET approval_token_hash = ?, owner_user_id = COALESCE(owner_user_id, ?)
         WHERE id = ? AND state = 'PENDING'
           AND (owner_user_id IS NULL OR owner_user_id = ?)`,
      )
      .run(hashSecret(approvalToken), ownerUserId, requestId, ownerUserId);
    if (update.changes !== 1)
      throw new PlatformError(
        'PERMISSION_DENIED',
        '这台 Agent 已由其他账号处理',
      );
    return { ...view, approvalToken };
  }

  approveAuthorization(
    ownerUserId: string,
    requestIdInput: string,
    approvalToken: string,
    nameInput: string,
  ): RunnerAuthorizationBrowserView {
    const requestId = RunnerAuthorizationRequestIdSchema.parse(requestIdInput);
    const name = RunnerNameSchema.parse(nameInput);
    return this.db.transaction(() => {
      const row = this.authorizationRequest(requestId);
      this.requirePendingAuthorization(row, ownerUserId, approvalToken);
      const approvedAt = this.now().toISOString();
      const update = this.db
        .prepare(
          `UPDATE platform_runner_authorization_request
           SET state = 'APPROVED', approved_name = ?, approved_at = ?,
               approval_token_hash = NULL
           WHERE id = ? AND state = 'PENDING' AND owner_user_id = ?`,
        )
        .run(name, approvedAt, requestId, ownerUserId);
      if (update.changes !== 1)
        throw new PlatformError('STALE_STATE', 'Agent 授权请求已更新');
      return authorizationBrowserView(
        {
          ...row,
          state: 'APPROVED',
          approved_name: name,
          approved_at: approvedAt,
        },
        this.now(),
      );
    })();
  }

  rejectAuthorization(
    ownerUserId: string,
    requestIdInput: string,
    approvalToken: string,
  ): RunnerAuthorizationBrowserView {
    const requestId = RunnerAuthorizationRequestIdSchema.parse(requestIdInput);
    return this.db.transaction(() => {
      const row = this.authorizationRequest(requestId);
      this.requirePendingAuthorization(row, ownerUserId, approvalToken);
      const update = this.db
        .prepare(
          `UPDATE platform_runner_authorization_request
           SET state = 'REJECTED', approval_token_hash = NULL
           WHERE id = ? AND state = 'PENDING' AND owner_user_id = ?`,
        )
        .run(requestId, ownerUserId);
      if (update.changes !== 1)
        throw new PlatformError('STALE_STATE', 'Agent 授权请求已更新');
      return authorizationBrowserView(
        { ...row, state: 'REJECTED', approval_token_hash: null },
        this.now(),
      );
    })();
  }

  claimAuthorization(
    requestIdInput: string,
    verifierInput: string,
  ): RunnerAuthorizationClaimResponse {
    const requestId = RunnerAuthorizationRequestIdSchema.parse(requestIdInput);
    const verifier = RunnerAuthorizationVerifierSchema.parse(verifierInput);
    return this.db.transaction(() => {
      const row = this.authorizationRequest(requestId);
      const now = this.now();
      if (
        row.verifier_hash !== hashSecret(verifier) ||
        Date.parse(row.expires_at) <= now.getTime()
      )
        return RunnerAuthorizationClaimResponseSchema.parse({
          state: 'REJECTED',
          message: 'Agent 授权请求无效或已过期',
        });
      if (row.state !== 'PENDING' && row.state !== 'APPROVED')
        return RunnerAuthorizationClaimResponseSchema.parse({
          state: 'REJECTED',
          message:
            row.state === 'REJECTED'
              ? '用户暂未连接这台 Agent'
              : 'Agent 授权凭据已经领取',
        });
      if (
        row.last_polled_at &&
        now.getTime() - Date.parse(row.last_polled_at) <
          MIN_AUTHORIZATION_POLL_MS
      )
        return RunnerAuthorizationClaimResponseSchema.parse({
          state: 'WAITING',
          retryAfterMs: MIN_AUTHORIZATION_POLL_MS,
        });
      this.db
        .prepare(
          `UPDATE platform_runner_authorization_request
           SET last_polled_at = ?, poll_count = poll_count + 1
           WHERE id = ?`,
        )
        .run(now.toISOString(), requestId);
      if (row.state === 'PENDING') {
        return RunnerAuthorizationClaimResponseSchema.parse({
          state: 'WAITING',
          retryAfterMs: 1_000,
        });
      }
      if (!row.owner_user_id || !row.approved_name)
        return RunnerAuthorizationClaimResponseSchema.parse({
          state: 'REJECTED',
          message: 'Agent 授权请求无效',
        });

      const credential = RunnerCredentialSchema.parse(
        this.secrets.credential(),
      );
      const existing = this.db
        .prepare(
          `SELECT id, owner_user_id, name, credential_hash, version,
                  last_seen_at, revoked_at, created_at
           FROM platform_runner
           WHERE owner_user_id = ? AND installation_id = ?`,
        )
        .get(row.owner_user_id, row.installation_id) as RunnerRow | undefined;
      const runnerId = existing?.id ?? this.createId();
      const version = existing ? existing.version + 1 : 1;
      if (existing) {
        const update = this.db
          .prepare(
            `UPDATE platform_runner
             SET name = ?, credential_hash = ?, version = ?,
                 available_slots = 3, last_seen_at = NULL, revoked_at = NULL
             WHERE id = ? AND version = ?`,
          )
          .run(
            row.approved_name,
            hashSecret(credential),
            version,
            existing.id,
            existing.version,
          );
        if (update.changes !== 1)
          throw new PlatformError('STALE_STATE', 'Agent 已更新，请重试授权');
      } else {
        this.db
          .prepare(
            `INSERT INTO platform_runner(
               id, owner_user_id, installation_id, name, credential_hash,
               version, last_seen_at, revoked_at, created_at
             ) VALUES (?, ?, ?, ?, ?, 1, NULL, NULL, ?)`,
          )
          .run(
            runnerId,
            row.owner_user_id,
            row.installation_id,
            row.approved_name,
            hashSecret(credential),
            now.toISOString(),
          );
      }
      const consumed = this.db
        .prepare(
          `UPDATE platform_runner_authorization_request
           SET state = 'CONSUMED', consumed_at = ?
           WHERE id = ? AND state = 'APPROVED'`,
        )
        .run(now.toISOString(), requestId);
      if (consumed.changes !== 1)
        throw new PlatformError('STALE_STATE', 'Agent 授权凭据已经领取');
      return RunnerAuthorizationClaimResponseSchema.parse({
        state: 'AUTHORIZED',
        runner: {
          id: runnerId,
          ownerUserId: row.owner_user_id,
          name: row.approved_name,
          version,
          lastSeenAt: null,
          revokedAt: null,
          createdAt: existing?.created_at ?? now.toISOString(),
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

  heartbeat(credential: string | undefined, availableSlots = 3): Runner {
    const runner = this.authenticateCredential(credential);
    const lastSeenAt = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE platform_runner
         SET last_seen_at = ?, available_slots = ?
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(lastSeenAt, availableSlots, runner.id);
    return RunnerSchema.parse({ ...runner, lastSeenAt });
  }

  revokeSelf(credential: string | undefined): Runner {
    const runner = this.authenticateCredential(credential);
    return this.revokeRunner(runner.ownerUserId, runner.id, runner.version);
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

  reactivateRunner(
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
      if (!row.revoked_at) return mapRunner(row);
      if (row.version !== expectedVersion)
        throw new PlatformError('STALE_STATE', 'Agent 已更新，请刷新后重试');
      const update = this.db
        .prepare(
          `UPDATE platform_runner
           SET revoked_at = NULL, last_seen_at = NULL, version = version + 1
           WHERE id = ? AND owner_user_id = ? AND version = ?
             AND revoked_at IS NOT NULL`,
        )
        .run(runnerId, ownerUserId, expectedVersion);
      if (update.changes !== 1)
        throw new PlatformError('STALE_STATE', 'Agent 已更新，请刷新后重试');
      return RunnerSchema.parse({
        ...mapRunner(row),
        lastSeenAt: null,
        revokedAt: null,
        version: row.version + 1,
      });
    })();
  }

  private authorizationRequest(requestId: string): AuthorizationRequestRow {
    const row = this.db
      .prepare(
        `SELECT id, installation_id, verifier_hash, fingerprint, suggested_name, approved_name,
                owner_user_id, state, approval_token_hash, expires_at,
                approved_at, consumed_at, last_polled_at, poll_count, created_at
         FROM platform_runner_authorization_request WHERE id = ?`,
      )
      .get(requestId) as AuthorizationRequestRow | undefined;
    if (!row)
      throw new PlatformError('NOT_FOUND', 'Agent 授权请求不存在或已失效');
    return row;
  }

  private requirePendingAuthorization(
    row: AuthorizationRequestRow,
    ownerUserId: string,
    approvalToken: string,
  ): void {
    if (
      row.state !== 'PENDING' ||
      Date.parse(row.expires_at) <= this.now().getTime()
    )
      throw new PlatformError('INVALID_TRANSITION', 'Agent 授权请求已失效');
    if (
      row.owner_user_id !== ownerUserId ||
      !row.approval_token_hash ||
      row.approval_token_hash !== hashSecret(approvalToken)
    )
      throw new PlatformError('PERMISSION_DENIED', 'Agent 授权确认无效');
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
  return new PlatformError('NOT_AUTHENTICATED', 'Agent 授权凭据无效或已撤销');
}

function authorizationBrowserView(
  row: AuthorizationRequestRow,
  now: Date,
): RunnerAuthorizationBrowserView {
  return {
    requestId: row.id,
    fingerprint: row.fingerprint,
    suggestedName: row.approved_name ?? row.suggested_name,
    state:
      Date.parse(row.expires_at) <= now.getTime() &&
      !['CONSUMED', 'REJECTED'].includes(row.state)
        ? 'EXPIRED'
        : row.state,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}
