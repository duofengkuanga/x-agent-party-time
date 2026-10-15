import { z } from 'zod';

export const OBSERVATION_VERSION = 1;
export const OBSERVATION_LIMITS = {
  eventBytes: 8 * 1024,
  batchBytes: 256 * 1024,
  batchEvents: 128,
  summaryBytes: 64 * 1024,
  executionBytes: 50 * 1024 * 1024,
  installationBytes: 1024 * 1024 * 1024,
  memoryBytes: 8 * 1024 * 1024,
  detailDays: 30,
  summaryDays: 180,
} as const;

const Identity = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_.:-]+$/u);
const Milliseconds = z.number().finite().nonnegative();
export const ActivitySchema = z.enum([
  'read',
  'search',
  'edit',
  'test',
  'typecheck',
  'lint',
  'build',
  'install',
  'git.inspect',
  'git.integrate',
  'git.commit',
  'git.push',
  'deploy',
  'message',
  'mixed',
  'unknown',
]);
export type Activity = z.infer<typeof ActivitySchema>;
export const ObservationPhaseSchema = z.enum([
  'local_wait',
  'workspace',
  'attachments',
  'skill',
  'baseline',
  'startup',
  'session',
  'turn_start',
  'turn',
  'shutdown',
  'validation',
  'delivery',
  'synchronization',
]);
export type ObservationPhase = z.infer<typeof ObservationPhaseSchema>;
export const ObservationEventSchema = z.strictObject({
  schemaVersion: z.literal(OBSERVATION_VERSION),
  eventId: z.uuid(),
  executionId: z.uuid(),
  segmentId: z.uuid(),
  sequence: z.number().int().positive(),
  name: z.enum([
    'segment.opened',
    'segment.closed',
    'execution.received',
    'phase.started',
    'phase.finished',
    'rpc.sent',
    'rpc.settled',
    'session.associated',
    'turn.associated',
    'activity.observed',
    'item.started',
    'item.finished',
    'interaction.requested',
    'interaction.resolved',
    'interaction.responded',
    'handoff.requested',
    'turn.terminal',
    'process.exited',
    'outcome.validated',
    'delivery.started',
    'delivery.accepted',
    'delivery.rejected',
    'delivery.unknown',
    'gap',
    'configuration.observed',
    'usage.observed',
    'capability.observed',
  ]),
  source: z.enum(['xapt', 'codex_protocol', 'server_response', 'recovered_evidence']),
  observedAt: z.iso.datetime(),
  observedElapsedMs: Milliseconds,
  phase: ObservationPhaseSchema.optional(),
  activity: ActivitySchema.optional(),
  correlation: z
    .strictObject({
      sessionId: Identity.optional(),
      turnId: Identity.optional(),
      sourceItemId: Identity.optional(),
      callId: Identity.optional(),
      requestId: Identity.optional(),
      connectionId: z.uuid().optional(),
      intervalId: Identity.optional(),
      parentIntervalId: Identity.optional(),
    })
    .optional(),
  status: z
    .enum(['running', 'succeeded', 'failed', 'interrupted', 'handed_off', 'unknown'])
    .optional(),
  sourceDurationMs: Milliseconds.optional(),
  workId: z.uuid().optional(),
  reason: z
    .enum([
      'unsupported',
      'unrecognized',
      'missing_boundary',
      'recording_gap',
      'conflict',
      'budget',
      'expired',
      'unavailable',
      'source_reported',
      'clock_unknown',
      'static_definition',
    ])
    .optional(),
  configuration: z
    .strictObject({
      xaptVersion: Identity.optional(),
      codexVersion: Identity.optional(),
      bundleHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .optional(),
      requestedModel: Identity.optional(),
      effectiveModel: Identity.optional(),
      requestedEffort: z
        .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
        .optional(),
      effectiveEffort: z
        .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
        .optional(),
      clockSleep: z.enum(['included', 'excluded', 'unknown']).optional(),
      items: z.enum(['supported', 'unsupported', 'unknown']).optional(),
    })
    .optional(),
  usage: z
    .strictObject({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      cachedInputTokens: z.number().int().nonnegative().optional(),
      cacheWriteInputTokens: z.number().int().nonnegative().optional(),
      reasoningOutputTokens: z.number().int().nonnegative().optional(),
      scope: z.enum(['turn', 'session', 'unknown']),
      mode: z.enum(['cumulative', 'delta', 'unknown']),
    })
    .optional(),
});
export type ObservationEvent = z.infer<typeof ObservationEventSchema>;

export const LocatedActivitySchema = z.strictObject({
  id: Identity,
  segmentId: z.uuid(),
  startMs: Milliseconds,
  endMs: Milliseconds,
  activity: ActivitySchema,
  phase: ObservationPhaseSchema.optional(),
  parentId: Identity.optional(),
  connectionId: z.uuid().optional(),
  turnId: Identity.optional(),
  status: z.enum([
    'running',
    'succeeded',
    'failed',
    'interrupted',
    'handed_off',
    'unknown',
  ]),
  evidence: z.array(z.uuid()).min(1).max(4),
  classificationBasis: z.enum([
    'observed',
    'static_definition',
    'source_reported',
    'unknown',
  ]),
  workId: z.uuid().optional(),
});
export type LocatedActivity = z.infer<typeof LocatedActivitySchema>;
export const FindingSchema = z.strictObject({
  id: Identity,
  kind: z.enum([
    'cost_contributor',
    'repeated_invocation',
    'potential_duplicate_work',
    'unassigned_interval',
    'attribution_limited',
  ]),
  activity: ActivitySchema.optional(),
  evidence: z.array(z.uuid()).max(16),
  strength: z.enum(['observed', 'source_reported', 'inferred', 'unknown', 'conflict']),
  equivalence: z.enum(['unknown', 'same', 'different']),
  removability: z.enum(['unassessed', 'blocked_by_phase_gate', 'candidate']),
  durationMs: Milliseconds.nullable(),
  estimatedSavingMs: z.null(),
  missing: z
    .array(
      z.enum([
        'equivalent_inputs',
        'coverage',
        'phase_requirements',
        'interval',
        'source_support',
      ]),
    )
    .max(5),
});
export type Finding = z.infer<typeof FindingSchema>;
export const ObservationReportSchema = z.strictObject({
  schemaVersion: z.literal(OBSERVATION_VERSION),
  reportId: z.uuid(),
  executionId: z.uuid(),
  revision: z.number().int().positive(),
  parentReportId: z.uuid().nullable(),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  eventCount: z.number().int().nonnegative(),
  calculatedAt: z.iso.datetime(),
  ruleVersion: z.literal(1),
  totalMs: Milliseconds.nullable(),
  sealed: z.boolean(),
  envelopeQuality: z.enum(['complete', 'open', 'fragmented', 'conflict']),
  attributionQuality: z.enum(['partial', 'conflict']),
  segments: z
    .array(
      z.strictObject({
        id: z.uuid(),
        startMs: Milliseconds,
        endMs: Milliseconds,
        toolMs: Milliseconds,
        cumulativeToolMs: Milliseconds,
        interactionMs: Milliseconds,
        overlapMs: Milliseconds,
        unassignedMs: Milliseconds,
        hasGap: z.boolean(),
      }),
    )
    .max(256),
  intervals: z.array(LocatedActivitySchema).max(2000),
  unplaced: z
    .array(
      z.strictObject({
        eventId: z.uuid(),
        segmentId: z.uuid(),
        activity: ActivitySchema,
        durationMs: Milliseconds.nullable(),
        sourceItemId: Identity.optional(),
        parentId: Identity.optional(),
        connectionId: z.uuid().optional(),
        turnId: Identity.optional(),
        workId: z.uuid().optional(),
        status: z.enum([
          'running',
          'succeeded',
          'failed',
          'interrupted',
          'handed_off',
          'unknown',
        ]),
        classificationBasis: z.enum([
          'observed',
          'static_definition',
          'source_reported',
          'unknown',
        ]),
      }),
    )
    .max(2000),
  incompleteActivities: z
    .array(
      z.strictObject({
        eventId: z.uuid(),
        segmentId: z.uuid(),
        activity: ActivitySchema,
        phase: ObservationPhaseSchema.optional(),
        boundary: z.enum(['start_only', 'end_only', 'conflict']),
        lowerMs: Milliseconds,
        upperMs: Milliseconds.nullable(),
      }),
    )
    .max(2000),
  issues: z
    .array(
      z.enum([
        'conflict',
        'missing_boundary',
        'recording_gap',
        'unrecognized',
        'clock_unknown',
        'budget',
      ]),
    )
    .max(6),
  findings: z.array(FindingSchema).max(5),
  configurations: z
    .array(
      z.object({
        segmentId: z.uuid(),
        value: ObservationEventSchema.shape.configuration.unwrap(),
      }),
    )
    .max(256),
  usages: z
    .array(
      z.strictObject({
        segmentId: z.uuid(),
        sessionId: Identity.optional(),
        turnId: Identity.optional(),
        value: ObservationEventSchema.shape.usage.unwrap(),
      }),
    )
    .max(256),
});
export type ObservationReport = z.infer<typeof ObservationReportSchema>;

export const ObservationBatchSchema = z
  .strictObject({
    schemaVersion: z.literal(OBSERVATION_VERSION),
    batchId: z.uuid(),
    executionId: z.uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
    events: z.array(ObservationEventSchema).max(OBSERVATION_LIMITS.batchEvents),
    report: ObservationReportSchema.nullable(),
  })
  .refine(
    (batch) =>
      batch.events.every((e) => e.executionId === batch.executionId) &&
      (!batch.report || batch.report.executionId === batch.executionId),
    '执行关联不一致',
  )
  .refine(
    (batch) => batch.events.length > 0 || batch.report !== null,
    '空归因批次无可接受内容',
  );
export type ObservationBatch = z.infer<typeof ObservationBatchSchema>;
export const ObservationReceiptSchema = z.strictObject({
  batchId: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  accepted: z.literal(true),
  duplicate: z.boolean(),
});
export type ObservationReceipt = z.infer<typeof ObservationReceiptSchema>;
