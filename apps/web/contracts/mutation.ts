import { z } from 'zod';

export const RequestMutationIdSchema = z.uuid();

export const VersionedMutationSchema = z.object({
  mutationId: RequestMutationIdSchema,
  expectedVersion: z.number().int().positive(),
});
