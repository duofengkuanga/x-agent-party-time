import { z } from 'zod';

const RepositoryUrlInputSchema = z.string().trim().min(1).max(500);

export const RepositoryUrlSchema = RepositoryUrlInputSchema.transform(
  (value, context) => {
    const normalized = normalizedRepositoryUrl(value);
    if (normalized) return normalized;
    context.addIssue({
      code: 'custom',
      message: '仓库地址必须是 HTTP(S)、SSH、Git URL 或 SCP 风格地址',
    });
    return z.NEVER;
  },
);

export function normalizeRepositoryUrl(value: string): string {
  return RepositoryUrlSchema.parse(value);
}

function normalizedRepositoryUrl(value: string): string | null {
  const scp = value.includes('://')
    ? null
    : value.match(/^[^\s@]+@([^\s:]+):(.+)$/u);
  if (scp) return canonicalRepositoryUrl(scp[1]!, undefined, scp[2]!);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return null;
  const defaultPorts: Record<string, string> = {
    'http:': '80',
    'https:': '443',
    'ssh:': '22',
    'git:': '9418',
  };
  const port = url.port === defaultPorts[url.protocol] ? undefined : url.port;
  return canonicalRepositoryUrl(url.hostname, port, url.pathname);
}

function canonicalRepositoryUrl(
  hostnameInput: string,
  port: string | undefined,
  pathInput: string,
): string | null {
  const hostname = hostnameInput.trim().toLowerCase();
  const path = pathInput
    .trim()
    .replace(/^\/+|\/+$/gu, '')
    .replace(/\.git$/iu, '');
  if (!hostname || !path || /\s/u.test(path)) return null;
  const renderedHost = hostname.includes(':') ? `[${hostname}]` : hostname;
  return `https://${renderedHost}${port ? `:${port}` : ''}/${path}.git`;
}

export const RunnerIdSchema = z.uuid();
export const RunnerNameSchema = z.string().trim().min(1).max(120);
export const RunnerCredentialSchema = z.string().min(32).max(256);
export const RunnerAuthorizationRequestIdSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
export const RunnerAuthorizationVerifierSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
export const RunnerAuthorizationVerifierHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u);
export const RunnerFingerprintSchema = z
  .string()
  .regex(/^[A-F0-9]{4}(?:-[A-F0-9]{4}){2}$/u);
export const PairingCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/u);

export const RunnerSchema = z.object({
  id: RunnerIdSchema,
  ownerUserId: z.string().trim().min(1).max(80),
  name: RunnerNameSchema,
  version: z.number().int().positive(),
  lastSeenAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const RunnerStatusSchema = z.object({
  runner: RunnerSchema,
  online: z.boolean(),
});

export const PairingCodeIssueSchema = z.object({
  code: PairingCodeSchema,
  expiresAt: z.iso.datetime(),
});

export const RunnerPairRequestSchema = z.object({
  code: PairingCodeSchema,
  name: RunnerNameSchema,
});

export const RunnerPairingResultSchema = z.object({
  runner: RunnerSchema,
  credential: RunnerCredentialSchema,
});

export const RunnerAuthorizationCreateRequestSchema = z
  .object({
    verifierHash: RunnerAuthorizationVerifierHashSchema,
    fingerprint: RunnerFingerprintSchema,
    suggestedName: RunnerNameSchema,
  })
  .strict();

export const RunnerAuthorizationIssueSchema = z.object({
  requestId: RunnerAuthorizationRequestIdSchema,
  expiresAt: z.iso.datetime(),
});

export const RunnerAuthorizationClaimRequestSchema = z
  .object({
    verifier: RunnerAuthorizationVerifierSchema,
  })
  .strict();

export const RunnerAuthorizationClaimResponseSchema = z.discriminatedUnion(
  'state',
  [
    z.object({
      state: z.literal('WAITING'),
      retryAfterMs: z.number().int().min(500).max(30_000),
    }),
    z.object({
      state: z.literal('REJECTED'),
      message: z.string().trim().min(1).max(240),
    }),
    RunnerPairingResultSchema.extend({
      state: z.literal('AUTHORIZED'),
    }),
  ],
);

export const RunnerHeartbeatResponseSchema = z.object({
  runner: RunnerSchema,
});

export const RunnerBindingRefSchema = z.object({
  bindingId: z.uuid(),
});

export const RunnerBindingConfirmationRequestSchema = z
  .object({
    bindingId: z.uuid(),
    repositoryUrl: RepositoryUrlSchema,
  })
  .strict();

export const RunnerBindingConfirmationResponseSchema =
  RunnerBindingConfirmationRequestSchema;

export const RunnerBindingsResponseSchema = z.object({
  bindings: z.array(RunnerBindingRefSchema),
});

export const RunnerBindingWorkSchema = z.object({
  requestId: z.uuid(),
  bindingId: z.uuid(),
  expiresAt: z.iso.datetime(),
});

export const RunnerBindingWorkResponseSchema = z.object({
  request: RunnerBindingWorkSchema.nullable(),
});

export const RunnerBindingWorkCompletionSchema = z.discriminatedUnion(
  'outcome',
  [
    z
      .object({
        outcome: z.literal('SUCCEEDED'),
        repositoryUrl: RepositoryUrlSchema,
      })
      .strict(),
    z
      .object({
        outcome: z.literal('FAILED'),
        code: z.enum([
          'CANCELLED',
          'INVALID_DIRECTORY',
          'NOT_GIT_REPOSITORY',
          'MISSING_REMOTE',
          'LOCAL_STATE_FAILED',
          'UNSUPPORTED_PLATFORM',
        ]),
        message: z.string().trim().min(1).max(240),
      })
      .strict(),
  ],
);

export const RunnerBindingWorkCompletionResponseSchema = z.object({
  state: z.enum(['SUCCEEDED', 'FAILED']),
});

export type Runner = z.infer<typeof RunnerSchema>;
export type RunnerStatus = z.infer<typeof RunnerStatusSchema>;
export type PairingCodeIssue = z.infer<typeof PairingCodeIssueSchema>;
export type RunnerPairRequest = z.infer<typeof RunnerPairRequestSchema>;
export type RunnerPairingResult = z.infer<typeof RunnerPairingResultSchema>;
export type RunnerAuthorizationCreateRequest = z.infer<
  typeof RunnerAuthorizationCreateRequestSchema
>;
export type RunnerAuthorizationIssue = z.infer<
  typeof RunnerAuthorizationIssueSchema
>;
export type RunnerAuthorizationClaimResponse = z.infer<
  typeof RunnerAuthorizationClaimResponseSchema
>;
export type RunnerHeartbeatResponse = z.infer<
  typeof RunnerHeartbeatResponseSchema
>;
export type RunnerBindingRef = z.infer<typeof RunnerBindingRefSchema>;
export type RunnerBindingConfirmationRequest = z.infer<
  typeof RunnerBindingConfirmationRequestSchema
>;
export type RunnerBindingsResponse = z.infer<
  typeof RunnerBindingsResponseSchema
>;
export type RunnerBindingWork = z.infer<typeof RunnerBindingWorkSchema>;
export type RunnerBindingWorkCompletion = z.infer<
  typeof RunnerBindingWorkCompletionSchema
>;
