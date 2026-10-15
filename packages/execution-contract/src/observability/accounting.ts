import {
  ObservationEventSchema,
  ObservationReportSchema,
  type LocatedActivity,
  type ObservationEvent,
  type ObservationReport,
} from './schema';
import { diagnoseActivities } from './classification';

export type TimeInterval = readonly [number, number];

export function unionIntervals(input: readonly TimeInterval[]): TimeInterval[] {
  const result: Array<[number, number]> = [];
  for (const [start, end] of [...input].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start)
      throw new Error('无效时间区间');
    if (start === end) continue;
    const previous = result.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else result.push([start, end]);
  }
  return result;
}

export function intersectIntervals(
  a: readonly TimeInterval[],
  b: readonly TimeInterval[],
): TimeInterval[] {
  const left = unionIntervals(a);
  const right = unionIntervals(b);
  const result: TimeInterval[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const [as, ae] = left[i]!;
    const [bs, be] = right[j]!;
    if (Math.max(as, bs) < Math.min(ae, be))
      result.push([Math.max(as, bs), Math.min(ae, be)]);
    if (ae < be) i++;
    else j++;
  }
  return result;
}

export function intervalLength(input: readonly TimeInterval[]): number {
  return unionIntervals(input).reduce((sum, [start, end]) => sum + end - start, 0);
}

/** Bounds require explicit lifetime evidence, never an unrelated Turn end. */
export function activityDurationBounds(
  start: number,
  aliveAt?: number,
  stoppedBy?: number,
) {
  if (
    start < 0 ||
    (aliveAt !== undefined && aliveAt < start) ||
    (stoppedBy !== undefined && stoppedBy < (aliveAt ?? start))
  )
    throw new Error('时间证据冲突');
  return {
    lowerMs: (aliveAt ?? start) - start,
    upperMs: stoppedBy === undefined ? null : stoppedBy - start,
  };
}

function intervalKey(event: ObservationEvent): string | null {
  const c = event.correlation;
  const id = c?.intervalId ?? c?.sourceItemId ?? c?.requestId;
  if (!id) return null;
  const family = event.name.split('.')[0];
  return JSON.stringify([event.segmentId, family, c?.connectionId, c?.turnId, id]);
}

export function calculateObservationReport(
  input: readonly ObservationEvent[],
  metadata: Pick<
    ObservationReport,
    | 'reportId'
    | 'executionId'
    | 'revision'
    | 'parentReportId'
    | 'inputDigest'
    | 'calculatedAt'
  >,
): ObservationReport {
  const issues = new Set<ObservationReport['issues'][number]>();
  const unique = new Map<string, ObservationEvent>();
  const conflicts = new Set<string>();
  let envelopeConflict = false;
  for (const raw of input) {
    const event = ObservationEventSchema.parse(raw);
    if (event.executionId !== metadata.executionId) throw new Error('执行关联不一致');
    const previous = unique.get(event.eventId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) {
      conflicts.add(event.eventId);
      if (
        [previous.name, event.name].some((name) =>
          ['execution.received', 'delivery.accepted'].includes(name),
        )
      )
        envelopeConflict = true;
      issues.add('conflict');
    } else unique.set(event.eventId, event);
  }
  const events = [...unique.values()]
    .filter((event) => !conflicts.has(event.eventId))
    .sort(
      (a, b) =>
        a.segmentId.localeCompare(b.segmentId) ||
        a.sequence - b.sequence ||
        a.eventId.localeCompare(b.eventId),
    );
  const starts = new Map<string, ObservationEvent[]>();
  const finishes = new Map<string, ObservationEvent[]>();
  const startNames = new Set([
    'phase.started',
    'item.started',
    'rpc.sent',
    'interaction.requested',
    'delivery.started',
  ]);
  const endNames = new Set([
    'phase.finished',
    'item.finished',
    'rpc.settled',
    'interaction.responded',
    'delivery.accepted',
    'delivery.rejected',
    'delivery.unknown',
  ]);
  for (const event of events) {
    if (event.name === 'gap') {
      issues.add('recording_gap');
      if (
        event.reason === 'conflict' ||
        event.reason === 'budget' ||
        event.reason === 'unrecognized'
      )
        issues.add(event.reason);
    }
    const key = intervalKey(event);
    if (!key) continue;
    if (startNames.has(event.name)) starts.set(key, [...(starts.get(key) ?? []), event]);
    if (endNames.has(event.name))
      finishes.set(key, [...(finishes.get(key) ?? []), event]);
  }
  const intervals: LocatedActivity[] = [];
  const incompleteActivities: ObservationReport['incompleteActivities'] = [];
  const incomplete = (
    entries: ObservationEvent[],
    boundary: 'start_only' | 'end_only' | 'conflict',
  ) => {
    for (const entry of entries)
      incompleteActivities.push({
        eventId: entry.eventId,
        segmentId: entry.segmentId,
        activity: entry.activity ?? 'unknown',
        phase: entry.phase,
        boundary,
        lowerMs: 0,
        upperMs: null,
      });
  };
  const positioned = new Set<string>();
  for (const key of new Set([...starts.keys(), ...finishes.keys()])) {
    const begin = starts.get(key) ?? [];
    const end = finishes.get(key) ?? [];
    if (begin.length !== 1 || end.length !== 1) {
      issues.add(begin.length > 1 || end.length > 1 ? 'conflict' : 'missing_boundary');
      incomplete(
        [...begin, ...end],
        begin.length > 1 || end.length > 1
          ? 'conflict'
          : begin.length
            ? 'start_only'
            : 'end_only',
      );
      continue;
    }
    const first = begin[0]!;
    const last = end[0]!;
    if (last.observedElapsedMs < first.observedElapsedMs) {
      issues.add('conflict');
      incomplete([first, last], 'conflict');
      continue;
    }
    positioned.add(last.eventId);
    intervals.push({
      id:
        first.correlation!.intervalId ??
        first.correlation!.sourceItemId ??
        first.correlation!.requestId!,
      segmentId: first.segmentId,
      startMs: first.observedElapsedMs,
      endMs: last.observedElapsedMs,
      activity: last.activity ?? first.activity ?? 'unknown',
      phase: first.phase,
      classificationBasis:
        last.reason === 'static_definition' || first.reason === 'static_definition'
          ? 'static_definition'
          : 'observed',
      workId: last.workId ?? first.workId,
      parentId: first.correlation?.parentIntervalId,
      connectionId: first.correlation?.connectionId,
      turnId: first.correlation?.turnId,
      status: last.status ?? 'unknown',
      evidence: [first.eventId, last.eventId],
    });
  }
  const sourceOccurrences = new Map<
    string,
    { eventId: string; signature: string; conflict: boolean }
  >();
  for (const event of events) {
    if (
      event.name !== 'activity.observed' ||
      event.reason !== 'source_reported' ||
      !event.correlation?.sourceItemId
    )
      continue;
    const signature = JSON.stringify([
      event.activity,
      event.status,
      event.workId,
      event.sourceDurationMs,
    ]);
    const previous = sourceOccurrences.get(event.correlation.sourceItemId);
    if (previous && previous.signature !== signature) {
      previous.conflict = true;
      issues.add('conflict');
    } else if (!previous)
      sourceOccurrences.set(event.correlation.sourceItemId, {
        eventId: event.eventId,
        signature,
        conflict: false,
      });
  }
  const unplaced = events
    .filter((event) => {
      if (
        event.name !== 'activity.observed' ||
        event.reason !== 'source_reported' ||
        !event.correlation?.sourceItemId
      )
        return true;
      const occurrence = sourceOccurrences.get(event.correlation.sourceItemId)!;
      return !occurrence.conflict && occurrence.eventId === event.eventId;
    })
    .filter(
      (event) =>
        !positioned.has(event.eventId) &&
        (event.sourceDurationMs !== undefined ||
          (event.name === 'activity.observed' && event.reason === 'source_reported')),
    )
    .map((event) => ({
      eventId: event.eventId,
      segmentId: event.segmentId,
      activity: event.activity ?? 'unknown',
      durationMs: event.sourceDurationMs ?? null,
      sourceItemId: event.correlation?.sourceItemId,
      parentId: event.correlation?.parentIntervalId,
      connectionId: event.correlation?.connectionId,
      turnId: event.correlation?.turnId,
      workId: event.workId,
      status: event.status ?? 'unknown',
      classificationBasis: 'source_reported' as const,
    }));
  const segmentIds = [...new Set(events.map((event) => event.segmentId))];
  const segments = segmentIds.map((id) => {
    const own = events.filter((event) => event.segmentId === id);
    const receivedEvents = own.filter((event) => event.name === 'execution.received');
    const acceptedEvents = own.filter((event) => event.name === 'delivery.accepted');
    const received = receivedEvents[0];
    const accepted = acceptedEvents[0];
    if (receivedEvents.length > 1) envelopeConflict = true;
    const startMs =
      received?.observedElapsedMs ?? Math.min(...own.map((e) => e.observedElapsedMs));
    const endMs =
      accepted?.observedElapsedMs ?? Math.max(...own.map((e) => e.observedElapsedMs));
    const window: TimeInterval[] = endMs >= startMs ? [[startMs, endMs]] : [];
    if (endMs < startMs) {
      issues.add('conflict');
      envelopeConflict = true;
    }
    const owned = intervals.filter((entry) => entry.segmentId === id);
    const tools = owned.filter((entry) =>
      entry.evidence.some((eid) => unique.get(eid)?.name === 'item.started'),
    );
    const cumulativeToolMs = tools
      .filter(
        (entry) =>
          !tools.some(
            (parent) =>
              parent.id === entry.parentId &&
              parent.connectionId === entry.connectionId &&
              parent.turnId === entry.turnId,
          ),
      )
      .reduce(
        (sum, entry) =>
          sum +
          intervalLength(intersectIntervals([[entry.startMs, entry.endMs]], window)),
        0,
      );
    const tool = tools.map((entry) => [entry.startMs, entry.endMs] as const);
    const interaction = owned
      .filter((entry) =>
        entry.evidence.some((eid) => unique.get(eid)?.name === 'interaction.requested'),
      )
      .map((entry) => [entry.startMs, entry.endMs] as const);
    return {
      id,
      startMs,
      endMs: Math.max(startMs, endMs),
      cumulativeToolMs,
      toolMs: intervalLength(intersectIntervals(tool, window)),
      interactionMs: intervalLength(intersectIntervals(interaction, window)),
      overlapMs: intervalLength(
        intersectIntervals(intersectIntervals(tool, interaction), window),
      ),
      unassignedMs:
        intervalLength(window) -
        intervalLength(intersectIntervals([...tool, ...interaction], window)),
      hasGap: own.some((event) => event.name === 'gap'),
    };
  });
  const configurationMap = new Map<
    string,
    NonNullable<ObservationEvent['configuration']>
  >();
  const configurations: ObservationReport['configurations'] = [];
  const configurationIndex = new Map<string, number>();
  const usageMap = new Map<string, ObservationReport['usages'][number]>();
  for (const event of events) {
    if (event.configuration) {
      const previous = configurationMap.get(event.segmentId);
      const next = { ...previous, ...event.configuration };
      const fields = [
        'effectiveModel',
        'effectiveEffort',
        'requestedModel',
        'requestedEffort',
        'bundleHash',
        'codexVersion',
      ] as const;
      const changed =
        previous &&
        fields.some(
          (field) =>
            previous[field] !== undefined &&
            next[field] !== undefined &&
            previous[field] !== next[field],
        );
      let index = configurationIndex.get(event.segmentId);
      if (index === undefined || changed) {
        index = configurations.length;
        configurations.push({ segmentId: event.segmentId, value: next });
        configurationIndex.set(event.segmentId, index);
      } else configurations[index] = { segmentId: event.segmentId, value: next };
      configurationMap.set(event.segmentId, next);
    }
    if (event.usage) {
      const value = {
        segmentId: event.segmentId,
        sessionId: event.correlation?.sessionId,
        turnId: event.correlation?.turnId,
        value: event.usage,
      };
      usageMap.set(
        JSON.stringify([
          value.segmentId,
          value.sessionId,
          value.turnId,
          value.value.scope,
          value.value.mode,
        ]),
        value,
      );
    }
  }
  if (
    !configurationMap.size ||
    [...configurationMap.values()].some((entry) => entry.clockSleep !== 'included')
  )
    issues.add('clock_unknown');
  const complete =
    segmentIds.length === 1 &&
    events.some((e) => e.name === 'execution.received') &&
    events.some((e) => e.name === 'delivery.accepted');
  if (
    intervals.length > 2000 ||
    incompleteActivities.length > 2000 ||
    unplaced.length > 2000 ||
    segments.length > 256
  )
    issues.add('budget');
  return ObservationReportSchema.parse({
    ...metadata,
    schemaVersion: 1,
    ruleVersion: 1,
    eventCount: unique.size,
    sealed: events.some(
      (event) =>
        event.name === 'delivery.accepted' &&
        events.some(
          (end) => end.segmentId === event.segmentId && end.name === 'segment.closed',
        ),
    ),
    totalMs:
      complete && !envelopeConflict ? segments[0]!.endMs - segments[0]!.startMs : null,
    envelopeQuality: envelopeConflict
      ? 'conflict'
      : complete
        ? 'complete'
        : segments.length > 1
          ? 'fragmented'
          : 'open',
    attributionQuality: issues.has('conflict') ? 'conflict' : 'partial',
    segments: segments.slice(0, 256),
    intervals: intervals.slice(0, 2000),
    unplaced: unplaced.slice(0, 2000),
    incompleteActivities: incompleteActivities.slice(0, 2000),
    issues: [...issues],
    configurations: configurations.slice(0, 256),
    usages: [...usageMap.values()].slice(0, 256),
    findings: diagnoseActivities(
      intervals,
      unplaced,
      segments.reduce((sum, segment) => sum + segment.unassignedMs, 0),
    ),
  });
}
