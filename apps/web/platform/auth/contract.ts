import { z } from 'zod';

export const UserIdSchema = z.string().trim().min(1).max(80);
export const UsernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u);
export const DisplayNameSchema = z.string().trim().min(1).max(120);

export const UserSchema = z.object({
  id: UserIdSchema,
  username: UsernameSchema,
  displayName: DisplayNameSchema,
  createdAt: z.iso.datetime(),
});

export type User = z.infer<typeof UserSchema>;
