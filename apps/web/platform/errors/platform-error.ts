export type PlatformErrorCode =
  | 'AUTHENTICATION_FAILED'
  | 'NOT_AUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'STALE_STATE'
  | 'INVALID_TRANSITION'
  | 'VALIDATION_FAILED'
  | 'SCHEMA_VERSION_MISMATCH'
  | 'RESOURCE_CONFLICT'
  | 'LEASE_EXPIRED'
  | 'OUTCOME_CONFLICT'
  | 'NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'FILE_TYPE_NOT_ALLOWED'
  | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<PlatformErrorCode, number> = {
  AUTHENTICATION_FAILED: 401,
  NOT_AUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  STALE_STATE: 409,
  INVALID_TRANSITION: 409,
  VALIDATION_FAILED: 400,
  SCHEMA_VERSION_MISMATCH: 500,
  RESOURCE_CONFLICT: 409,
  LEASE_EXPIRED: 409,
  OUTCOME_CONFLICT: 409,
  NOT_FOUND: 404,
  FILE_TOO_LARGE: 413,
  FILE_TYPE_NOT_ALLOWED: 415,
  INTERNAL_ERROR: 500,
};

export class PlatformError extends Error {
  readonly status: number;

  constructor(
    readonly code: PlatformErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PlatformError';
    this.status = STATUS_BY_CODE[code];
  }
}
