import type {
  BugDetail,
  DeploymentBatchSummary,
  RepairAttemptSummary,
  RepairResult,
} from '@agent-party-time/shared/control-plane';

export type PublicRepairResult = Omit<RepairResult, 'candidateCommit'>;

export interface PublicRepairAttempt extends Omit<
  RepairAttemptSummary,
  'runnerId' | 'sessionId' | 'result' | 'sourceDeployedCommit'
> {
  result: PublicRepairResult | null;
}

export type PublicVerificationFeedback = Omit<
  BugDetail['verificationFeedbacks'][number],
  'deployedCommit'
>;

export interface PublicBugDetail extends Omit<
  BugDetail,
  'repairAttempt' | 'repairAttempts' | 'verificationFeedbacks'
> {
  repairAttempt: PublicRepairAttempt | null;
  repairAttempts: PublicRepairAttempt[];
  verificationFeedbacks: PublicVerificationFeedback[];
}

export interface PublicDeploymentMember {
  bug: DeploymentBatchSummary['members'][number]['bug'];
}

export interface PublicDeploymentBatch extends Omit<
  DeploymentBatchSummary,
  'runnerId' | 'members' | 'deployedCommit'
> {
  members: PublicDeploymentMember[];
}

export function sanitizeBugDetail(detail: BugDetail): PublicBugDetail {
  return {
    ...detail,
    repairAttempt: detail.repairAttempt
      ? sanitizeRepairAttempt(detail.repairAttempt)
      : null,
    repairAttempts: detail.repairAttempts.map(sanitizeRepairAttempt),
    verificationFeedbacks: detail.verificationFeedbacks.map(
      ({ deployedCommit: _deployedCommit, ...feedback }) => feedback,
    ),
  };
}

export function sanitizeDeploymentBatch(
  batch: DeploymentBatchSummary,
): PublicDeploymentBatch {
  const {
    runnerId: _runnerId,
    deployedCommit: _deployedCommit,
    members,
    summary,
    reason,
    ...safeBatch
  } = batch;
  return {
    ...safeBatch,
    summary: summary ? sanitizePublicText(summary) : null,
    reason: reason ? sanitizePublicText(reason) : null,
    members: members.map(({ bug }) => ({ bug })),
  };
}

export function sanitizeRepairAttempt(
  attempt: RepairAttemptSummary,
): PublicRepairAttempt {
  const {
    runnerId: _runnerId,
    sessionId: _sessionId,
    sourceDeployedCommit: _sourceDeployedCommit,
    result,
    failureMessage,
    ...safeAttempt
  } = attempt;
  return {
    ...safeAttempt,
    failureMessage: failureMessage ? sanitizePublicText(failureMessage) : null,
    result: result ? sanitizeRepairResult(result) : null,
  };
}

function sanitizeRepairResult(result: RepairResult): PublicRepairResult {
  const { candidateCommit: _candidateCommit, ...safeResult } = result;
  return {
    ...safeResult,
    summary: sanitizePublicText(safeResult.summary),
    reason: safeResult.reason ? sanitizePublicText(safeResult.reason) : null,
    changes: safeResult.changes.map((change) => ({
      ...change,
      path: sanitizePath(change.path),
      summary: sanitizePublicText(change.summary),
    })),
    checks: safeResult.checks.map((check) => ({
      ...check,
      name: sanitizePublicText(check.name),
      summary: sanitizePublicText(check.summary),
    })),
  };
}

export function sanitizePublicText(text: string) {
  return text
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .split('\n')
    .map((line) =>
      looksLikeRawCliEvent(line)
        ? '[原始日志已隐藏]'
        : redactAbsolutePaths(line),
    )
    .join('\n');
}

function redactAbsolutePaths(text: string) {
  return text
    .replace(
      /(^|[\s("'`=])\/(?!\/)(?:[^\s"'`<>:,;)\]}]+\/)*[^\s"'`<>:,;)\]}]+/g,
      '$1[本地路径已隐藏]',
    )
    .replace(
      /\b[A-Za-z]:[\\/](?:[^\\/\s"'`<>:]+[\\/])*[^\\/\s"'`<>:]+/g,
      '[本地路径已隐藏]',
    );
}

function looksLikeRawCliEvent(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>;
    return typeof value.type === 'string';
  } catch {
    return false;
  }
}

function sanitizePath(path: string) {
  if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) return path;
  const name = path.split(/[\\/]/).filter(Boolean).at(-1);
  return name ? `[本地路径已隐藏]/${name}` : '[本地路径已隐藏]';
}
