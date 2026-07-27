import { z } from 'zod';
import { UserSchema } from '@/server/auth/contract';
import {
  RunnerIdSchema,
  RunnerSchema,
} from '@agent-party-time/runner-contract';
import { EngineeringIdSchema } from '@/features/cooking/engineering/contract';

export const BindingIdSchema = z.uuid();
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

export type EngineeringBinding = z.infer<typeof EngineeringBindingSchema>;
export type EngineeringBindingSummary = z.infer<
  typeof EngineeringBindingSummarySchema
>;
