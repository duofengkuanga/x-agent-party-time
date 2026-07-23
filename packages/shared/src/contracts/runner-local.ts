import { z } from 'zod';
import {
  EngineeringBindingIdSchema,
  EngineeringIdSchema,
  ProjectIdSchema,
  ProjectSlugSchema,
  RunnerIdSchema,
} from './control-plane.ts';

export const BindProjectCommandSchema = z.object({
  project: z.string().trim().min(1).max(128),
  repositoryPath: z.string().trim().min(1),
  baseBranch: z.string().trim().min(1).max(240).optional(),
});

export const ProjectBindingSchema = z.object({
  projectId: ProjectIdSchema,
  projectSlug: ProjectSlugSchema,
  projectTitle: z.string().trim().min(1).max(120).nullable(),
  runnerId: RunnerIdSchema,
  repositoryPath: z.string().trim().min(1),
  baseBranch: z.string().trim().min(1).max(240),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProjectBinding = z.infer<typeof ProjectBindingSchema>;

export const BindProjectResultSchema = z.object({
  binding: ProjectBindingSchema,
});

export const ListProjectBindingsQuerySchema = z.object({});
export const ListProjectBindingsResultSchema = z.object({
  items: z.array(ProjectBindingSchema),
});

export const BindEngineeringCommandSchema = z.object({
  engineeringId: EngineeringIdSchema,
  pairingTicket: z.string().min(32).max(500),
  repositoryPath: z.string().trim().min(1),
});

export const LocalEngineeringBindingSchema = z.object({
  bindingId: EngineeringBindingIdSchema,
  engineeringId: EngineeringIdSchema,
  developerUserId: z.string().trim().min(1).max(80),
  runnerId: RunnerIdSchema,
  repositoryPath: z.string().trim().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type LocalEngineeringBinding = z.infer<
  typeof LocalEngineeringBindingSchema
>;

export const BindEngineeringResultSchema = z.object({
  binding: LocalEngineeringBindingSchema,
});
export const ListEngineeringBindingsLocalQuerySchema = z.object({});
export const ListEngineeringBindingsLocalResultSchema = z.object({
  items: z.array(LocalEngineeringBindingSchema),
});
