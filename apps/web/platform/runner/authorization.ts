import { randomBytes } from 'node:crypto';
import type { AppDatabase } from '@/platform/database';
import { PlatformError } from '@/platform/errors';
import {
  RunnerAuthorizationClaimResponseSchema,
  RunnerAuthorizationCreateRequestSchema,
  RunnerAuthorizationIssueSchema,
  RunnerAuthorizationRequestIdSchema,
  RunnerAuthorizationVerifierSchema,
  RunnerCredentialSchema,
  RunnerNameSchema,
  type RunnerAuthorizationClaimResponse,
  type RunnerAuthorizationIssue,
} from './contract';
import { hashSecret, mapRunner, type RunnerRow } from './runner-storage';

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

const DEFAULT_AUTHORIZATION_DURATION_MS = 5 * 60 * 1_000;
const MIN_AUTHORIZATION_POLL_MS = 750;

export class RunnerAuthorizationRequests {
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => Date,
    private readonly createId: () => string,
    private readonly credential: () => string,
  ) {}

  createAuthorizationRequest(
    inputValue: unknown,
    durationMs: number = DEFAULT_AUTHORIZATION_DURATION_MS,
  ): RunnerAuthorizationIssue {
    const input = RunnerAuthorizationCreateRequestSchema.parse(inputValue);
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0)
      throw new PlatformError('VALIDATION_FAILED', '授权请求有效期无效');
    const now = this.now();
    const recentSince = new Date(now.getTime() - 60_000).toISOString();
    const recent = this.db.get(
      `SELECT COUNT(*) count
         FROM platform_runner_authorization_request
         WHERE created_at >= ?`,
      recentSince,
    ) as { count: number };
    if (recent.count >= 100)
      throw new PlatformError('RESOURCE_CONFLICT', '授权请求过于频繁，请稍后重试');
    const duplicate = this.db.get(
      `SELECT COUNT(*) count
         FROM platform_runner_authorization_request
         WHERE installation_id = ? AND state = 'PENDING' AND expires_at > ?`,
      input.installationId,
      now.toISOString(),
    ) as { count: number };
    if (duplicate.count >= 3)
      throw new PlatformError('RESOURCE_CONFLICT', '这台 Agent 的待处理授权请求过多');
    const requestId = randomBytes(24).toString('base64url');
    const expiresAt = new Date(now.getTime() + durationMs).toISOString();
    this.db.run(
      `INSERT INTO platform_runner_authorization_request(
           id, installation_id, verifier_hash, fingerprint, suggested_name, approved_name,
           owner_user_id, state, approval_token_hash, expires_at,
           approved_at, consumed_at, last_polled_at, poll_count, created_at
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'PENDING', NULL, ?, NULL, NULL, NULL, 0, ?)`,
      [
        requestId,
        input.installationId,
        input.verifierHash,
        input.fingerprint,
        input.suggestedName,
        expiresAt,
        now.toISOString(),
      ],
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
    const update = this.db.run(
      `UPDATE platform_runner_authorization_request
         SET approval_token_hash = ?, owner_user_id = COALESCE(owner_user_id, ?)
         WHERE id = ? AND state = 'PENDING'
           AND (owner_user_id IS NULL OR owner_user_id = ?)`,
      [hashSecret(approvalToken), ownerUserId, requestId, ownerUserId],
    );
    if (update.changes !== 1)
      throw new PlatformError('PERMISSION_DENIED', '这台 Agent 已由其他账号处理');
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
      const update = this.db.run(
        `UPDATE platform_runner_authorization_request
           SET state = 'APPROVED', approved_name = ?, approved_at = ?,
               approval_token_hash = NULL
           WHERE id = ? AND state = 'PENDING' AND owner_user_id = ?`,
        [name, approvedAt, requestId, ownerUserId],
      );
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
      const update = this.db.run(
        `UPDATE platform_runner_authorization_request
           SET state = 'REJECTED', approval_token_hash = NULL
           WHERE id = ? AND state = 'PENDING' AND owner_user_id = ?`,
        [requestId, ownerUserId],
      );
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
        now.getTime() - Date.parse(row.last_polled_at) < MIN_AUTHORIZATION_POLL_MS
      )
        return RunnerAuthorizationClaimResponseSchema.parse({
          state: 'WAITING',
          retryAfterMs: MIN_AUTHORIZATION_POLL_MS,
        });
      this.db.run(
        `UPDATE platform_runner_authorization_request
           SET last_polled_at = ?, poll_count = poll_count + 1
           WHERE id = ?`,
        [now.toISOString(), requestId],
      );
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

      const credential = RunnerCredentialSchema.parse(this.credential());
      const credentialHash = hashSecret(credential);
      const existing = this.db.get(
        `SELECT id, owner_user_id, name, credential_hash, version,
                  last_seen_at, revoked_at, created_at
           FROM platform_runner
           WHERE owner_user_id = ? AND installation_id = ?`,
        row.owner_user_id,
        row.installation_id,
      ) as RunnerRow | undefined;
      const runnerId = existing?.id ?? this.createId();
      const stored = this.db.get<RunnerRow>(
        `INSERT INTO platform_runner(
           id, owner_user_id, installation_id, name, credential_hash,
           version, last_seen_at, revoked_at, created_at
         ) VALUES (?, ?, ?, ?, ?, 1, NULL, NULL, ?)
         ON CONFLICT(owner_user_id, installation_id)
           WHERE installation_id IS NOT NULL
         DO UPDATE SET name = excluded.name,
                       credential_hash = excluded.credential_hash,
                       version = platform_runner.version + 1,
                       available_slots = 3,
                       last_seen_at = NULL, revoked_at = NULL
         WHERE platform_runner.version = ? RETURNING *`,
        runnerId,
        row.owner_user_id,
        row.installation_id,
        row.approved_name,
        credentialHash,
        now.toISOString(),
        existing?.version ?? 0,
      );
      if (!stored) throw new PlatformError('STALE_STATE', 'Agent 已更新，请重试授权');
      const consumed = this.db.run(
        `UPDATE platform_runner_authorization_request
           SET state = 'CONSUMED', consumed_at = ?
           WHERE id = ? AND state = 'APPROVED'`,
        [now.toISOString(), requestId],
      );
      if (consumed.changes !== 1)
        throw new PlatformError('STALE_STATE', 'Agent 授权凭据已经领取');
      return RunnerAuthorizationClaimResponseSchema.parse({
        state: 'AUTHORIZED',
        runner: mapRunner(stored),
        credential,
      });
    })();
  }

  private authorizationRequest(requestId: string): AuthorizationRequestRow {
    const row = this.db.get(
      `SELECT id, installation_id, verifier_hash, fingerprint, suggested_name, approved_name,
                owner_user_id, state, approval_token_hash, expires_at,
                approved_at, consumed_at, last_polled_at, poll_count, created_at
         FROM platform_runner_authorization_request WHERE id = ?`,
      requestId,
    ) as AuthorizationRequestRow | undefined;
    if (!row) throw new PlatformError('NOT_FOUND', 'Agent 授权请求不存在或已失效');
    return row;
  }

  private requirePendingAuthorization(
    row: AuthorizationRequestRow,
    ownerUserId: string,
    approvalToken: string,
  ): void {
    if (row.state !== 'PENDING' || Date.parse(row.expires_at) <= this.now().getTime())
      throw new PlatformError('INVALID_TRANSITION', 'Agent 授权请求已失效');
    if (
      row.owner_user_id !== ownerUserId ||
      !row.approval_token_hash ||
      row.approval_token_hash !== hashSecret(approvalToken)
    )
      throw new PlatformError('PERMISSION_DENIED', 'Agent 授权确认无效');
  }
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
