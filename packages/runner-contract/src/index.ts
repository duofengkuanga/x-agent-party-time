import { z } from 'zod';

export const RunnerIdSchema = z.uuid();
export const RunnerNameSchema = z.string().trim().min(1).max(120);
export const RunnerCredentialSchema = z.string().min(32).max(256);
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

export const RunnerHeartbeatResponseSchema = z.object({
  runner: RunnerSchema,
});

export const RunnerBindingRefSchema = z.object({
  bindingId: z.uuid(),
});

export const RunnerBindingsResponseSchema = z.object({
  bindings: z.array(RunnerBindingRefSchema),
});

export type Runner = z.infer<typeof RunnerSchema>;
export type RunnerStatus = z.infer<typeof RunnerStatusSchema>;
export type PairingCodeIssue = z.infer<typeof PairingCodeIssueSchema>;
export type RunnerPairRequest = z.infer<typeof RunnerPairRequestSchema>;
export type RunnerPairingResult = z.infer<typeof RunnerPairingResultSchema>;
export type RunnerHeartbeatResponse = z.infer<
  typeof RunnerHeartbeatResponseSchema
>;
export type RunnerBindingRef = z.infer<typeof RunnerBindingRefSchema>;
export type RunnerBindingsResponse = z.infer<
  typeof RunnerBindingsResponseSchema
>;
