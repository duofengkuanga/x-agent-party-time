import { z } from 'zod';

export const ErrorCategorySchema = z.enum([
  'validation',
  'not_found',
  'conflict',
  'authentication',
  'permission',
  'timeout',
  'cancelled',
  'transport',
  'runner',
  'invariant',
  'internal',
]);

export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

export const ERROR_CODES = {
  configInvalid: 'config.invalid',
  configInvalidJson: 'config.invalid_json',
  configVersionUnsupported: 'config.version_unsupported',
  configMigrationMissing: 'config.migration_missing',
  configPermissionDenied: 'config.permission_denied',
  configRevisionConflict: 'config.revision_conflict',
  entityNotFound: 'entity.not_found',
  storeConstraintConflict: 'store.constraint_conflict',
  storeInvariantViolation: 'store.invariant_violation',
  capabilityInvalid: 'service.capability_invalid',
  instanceAlreadyRunning: 'service.instance_already_running',
  instanceOwnershipLost: 'service.instance_ownership_lost',
  channelDisconnected: 'channel.disconnected',
  channelAuthenticationFailed: 'channel.authentication_failed',
  runnerTimedOut: 'runner.timed_out',
  runnerCancelled: 'runner.cancelled',
  runnerFailed: 'runner.failed',
  jobLeaseLost: 'job.lease_lost',
  jobRetryExhausted: 'job.retry_exhausted',
  taskRevisionConflict: 'task.revision_conflict',
  taskTransitionInvalid: 'task.transition_invalid',
  projectSlugConflict: 'project.slug_conflict',
  projectBindingInvalid: 'project.binding_invalid',
  projectAccessDenied: 'project.access_denied',
  projectInvitationConflict: 'project.invitation_conflict',
  projectInvitationInvalid: 'project.invitation_invalid',
  projectMemberRemovalBlocked: 'project.member_removal_blocked',
  engineeringSlugConflict: 'engineering.slug_conflict',
  engineeringAccessDenied: 'engineering.access_denied',
  engineeringReferenced: 'engineering.referenced',
  engineeringMemberInvalid: 'engineering.member_invalid',
  engineeringEnvironmentInvalid: 'engineering.environment_invalid',
  engineeringSensitiveValue: 'engineering.sensitive_value',
  engineeringBindingInvalid: 'engineering.binding_invalid',
  engineeringBindingConflict: 'engineering.binding_conflict',
  bugTransitionInvalid: 'bug.transition_invalid',
  repairDispatchUnavailable: 'repair_dispatch.unavailable',
  idempotencyConflict: 'request.idempotency_conflict',
  internalUnexpected: 'internal.unexpected',
} as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

const JsonValueSchema: z.ZodType<unknown> = z.json();

export const AppErrorSchema = z.object({
  code: ErrorCodeSchema,
  category: ErrorCategorySchema,
  message: z.string().min(1).max(2_000),
  retryable: z.boolean(),
  details: z.record(z.string(), JsonValueSchema).optional(),
  causeId: z.string().min(1).optional(),
});

export type AppError = z.infer<typeof AppErrorSchema>;

export function createAppError(input: AppError): AppError {
  return AppErrorSchema.parse(input);
}

export function isAppError(value: unknown): value is AppError {
  return AppErrorSchema.safeParse(value).success;
}

export function normalizeError(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (error instanceof z.ZodError) {
    return createAppError({
      code: ERROR_CODES.configInvalid,
      category: 'validation',
      message: '输入数据校验失败',
      retryable: false,
      details: {
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
  }

  return createAppError({
    code: ERROR_CODES.internalUnexpected,
    category: 'internal',
    message: '发生了未识别内部错误',
    retryable: false,
  });
}
