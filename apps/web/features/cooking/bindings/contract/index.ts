import { z } from 'zod';
import { UserSchema } from '@/server/auth/contract';
import {
  RunnerIdSchema,
  RunnerSchema,
} from '@agent-party-time/runner-contract';
import { EngineeringIdSchema } from '@/features/cooking/engineering/contract';

export const BindingIdSchema = z.uuid();
export const BindingRequestIdSchema = z.uuid();
export const EngineeringBindingSchema = z.object({
  id: BindingIdSchema,
  engineeringId: EngineeringIdSchema,
  userId: UserSchema.shape.id,
  runnerId: RunnerIdSchema,
  createdAt: z.iso.datetime(),
});

export const EngineeringBindingSummarySchema = z.object({
  binding: EngineeringBindingSchema,
  user: UserSchema,
  runner: RunnerSchema,
});

export const BindingRequestSchema = z.object({
  id: BindingRequestIdSchema,
  engineeringId: EngineeringIdSchema,
  userId: UserSchema.shape.id,
  runnerId: RunnerIdSchema,
  state: z.enum(['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED']),
  errorMessage: z.string().trim().min(1).max(240).nullable(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

export type EngineeringBinding = z.infer<typeof EngineeringBindingSchema>;
export type EngineeringBindingSummary = z.infer<
  typeof EngineeringBindingSummarySchema
>;
export type BindingRequest = z.infer<typeof BindingRequestSchema>;
