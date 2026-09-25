import { RunnerHttpClient as ProtocolHttpClient } from '@agent-party-time/runner-contract/http-client';
import { z } from 'zod';

const BugsDeleteRequestSchema = z
  .object({
    bugIds: z.array(z.uuid()).min(1).optional(),
    all: z.boolean().optional(),
    force: z.boolean().optional(),
  })
  .strict()
  .refine((value) => (value.all ? !value.bugIds : value.bugIds !== undefined), {
    message: '必须指定 bugIds 或 all 之一',
  });

const BugsDeleteResponseSchema = z.object({
  deletedBugIds: z.array(z.uuid()),
  deletedExecutionIds: z.array(z.uuid()),
});

export type RunnerAuthorizationHttp = Pick<
  RunnerHttpClient,
  'createAuthorization' | 'claimAuthorization' | 'heartbeat' | 'revokeSelf'
>;

export type RunnerBindingHttp = Pick<
  RunnerHttpClient,
  'listBindings' | 'claimBindingWork' | 'completeBindingWork'
>;

export type RunnerExecutionHttp = Pick<
  RunnerHttpClient,
  | 'claimExecutions'
  | 'startExecution'
  | 'renewExecution'
  | 'completeExecution'
  | 'openInteraction'
  | 'waitInteraction'
  | 'deleteBugs'
  | 'downloadExecutionFile'
>;

export class RunnerHttpClient extends ProtocolHttpClient {
  async deleteBugs(
    serverOrigin: string,
    credential: string,
    input: { bugIds?: readonly string[]; all?: boolean; force?: boolean },
  ): Promise<{ deletedBugIds: string[]; deletedExecutionIds: string[] }> {
    const body = BugsDeleteRequestSchema.parse(input);
    return await this.authorizedJson(
      serverOrigin,
      credential,
      '/api/cooking/bugs/delete',
      BugsDeleteResponseSchema,
      body,
    );
  }
}
