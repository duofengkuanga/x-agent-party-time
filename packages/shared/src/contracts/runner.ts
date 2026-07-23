import { z } from 'zod';
import { SessionRecordSchema } from '../schemas/runtime.js';
import { AgentProfileSchema } from '../schemas/service.js';
import { WakeObjectiveSchema, type RunnerResult } from '../schemas/protocol.js';

const TimestampSchema = z.string().datetime();

export const RunnerContextSchema = z.object({
  jobId: z.string().min(1),
  runId: z.string().min(1),
  correlationId: z.string().min(1),
  agent: AgentProfileSchema,
  session: SessionRecordSchema,
  objective: WakeObjectiveSchema,
  workspacePath: z.string().min(1),
  deadlineAt: TimestampSchema,
});

export type RunnerContext = z.infer<typeof RunnerContextSchema>;

export const RunnerProgressSchema = z.object({
  phase: z.enum(['starting', 'thinking', 'tool', 'finalizing']),
  message: z.string().min(1).max(2_000),
  occurredAt: TimestampSchema,
});

export type RunnerProgress = z.infer<typeof RunnerProgressSchema>;

export interface RunnerCallbacks {
  onProgress(progress: RunnerProgress): void | Promise<void>;
}

export const RunnerHealthSchema = z.object({
  status: z.enum(['ready', 'degraded', 'unavailable']),
  runnerName: z.string().min(1),
  checkedAt: TimestampSchema,
  message: z.string().min(1).max(2_000).optional(),
});

export type RunnerHealth = z.infer<typeof RunnerHealthSchema>;
export interface AgentRunner {
  readonly name: string;

  run(
    context: RunnerContext,
    callbacks: RunnerCallbacks,
    signal: AbortSignal,
  ): Promise<RunnerResult>;

  health(): Promise<RunnerHealth>;
  close(): Promise<void>;
}
export const AgentRunnerFactoryContextSchema = z.object({
  defaultModel: z.string().min(1).optional(),
});

export type AgentRunnerFactoryContext = z.infer<
  typeof AgentRunnerFactoryContextSchema
>;

export type AgentRunnerFactory = (
  context: AgentRunnerFactoryContext,
) => AgentRunner;
