'use client';

import { useId, useRef, useState } from 'react';
import type { BugView } from '@/contracts/submissions/bug';
import type { SubmissionWorkspaceSnapshot } from '@/contracts/submissions/workspace';
import type { TestingScopeView } from '@/contracts/submissions/testingScope';

export function testerChecklist(
  bug: BugView,
  snapshot: SubmissionWorkspaceSnapshot,
): {
  scopes: TestingScopeView[];
  preview: boolean;
} {
  const repair = snapshot.repairByBug[bug.id]?.timeline
    .filter((node) => node.kind === 'REPAIR_ATTEMPT')
    .at(-1);
  if (
    !repair ||
    repair.result?.outcome !== 'COMPLETED' ||
    ![
      'WAITING_FOR_UPDATE',
      'UPDATING',
      'WAITING_FOR_VERIFICATION',
      'DONE',
    ].includes(bug.stage)
  )
    return { scopes: [], preview: false };
  if (bug.stage === 'WAITING_FOR_UPDATE' || bug.stage === 'UPDATING')
    return { scopes: repair.result.testingScopes, preview: true };
  if (repair.result.commitCount === 0)
    return { scopes: repair.result.testingScopes, preview: false };
  const batch = snapshot.updateBatches.find((candidate) =>
    candidate.entries.some(
      (entry) =>
        entry.bugId === bug.id && entry.repairAttemptIds.includes(repair.id),
    ),
  );
  const update = batch?.timeline
    .filter((node) => node.kind === 'UPDATE_ATTEMPT')
    .at(-1);
  if (
    !batch ||
    batch.state !== 'COMPLETED' ||
    update?.result?.outcome !== 'COMPLETED'
  )
    return { scopes: [], preview: false };
  const source = batch.entries.find((entry) => entry.bugId === bug.id)!;
  return {
    scopes: [
      ...update.result.testingScopes
        .filter((entry) => entry.candidatePosition === source.position)
        .map((entry) => entry.testingScope),
      ...source.unchangedTestingScopes,
    ],
    preview: false,
  };
}

export function TesterChecklist({
  bug,
  relatedBug,
  snapshot,
}: {
  bug: BugView;
  relatedBug?: BugView;
  snapshot: SubmissionWorkspaceSnapshot;
}) {
  const id = useId();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const panels = useRef<HTMLDivElement>(null);
  const reports = [bug, ...(relatedBug ? [relatedBug] : [])].map((entry) =>
    testerChecklist(entry, snapshot),
  );
  const scopes = reports.flatMap((report) => report.scopes);
  const preview = reports.some((report) => report.preview);
  const points = [
    ...new Map(
      scopes
        .flatMap((scope) => scope.points)
        .map((point) => [JSON.stringify(point), point]),
    ).values(),
  ].sort(
    (left, right) =>
      Number(right.kind === 'DERIVED') - Number(left.kind === 'DERIVED'),
  );
  const selectedIndex = Math.max(
    0,
    points.findIndex((point) => JSON.stringify(point) === selectedKey),
  );
  const selectPoint = (index: number) => {
    const point = points[index];
    if (!point) return;
    setSelectedKey(JSON.stringify(point));
    if (panels.current) {
      panels.current.scrollTop = 0;
      panels.current.focus({ preventScroll: true });
    }
  };
  return (
    <section className="collab-tester-checklist" aria-label="本次要测">
      <div className="collab-tester-checklist__heading">
        <div>
          <h3>本次要测</h3>
          {points.length ? (
            <span
              className="collab-tester-checklist__position"
              aria-live="polite"
            >
              {selectedIndex + 1} / {points.length}
            </span>
          ) : null}
        </div>
        {preview ? (
          <p className="collab-tester-checklist__notice">
            修复预览，环境更新后再按最终清单复测。
          </p>
        ) : null}
        {points.length && reports.some((report) => !report.scopes.length) ? (
          <p className="collab-tester-checklist__notice">
            关联缺陷的测试范围尚未全部就绪。
          </p>
        ) : null}
      </div>
      {points.length ? (
        <div
          className="collab-tester-checklist__carousel"
          aria-roledescription="测试项轮播"
          onKeyDown={(event) => {
            const next =
              event.key === 'ArrowRight'
                ? selectedIndex + 1
                : event.key === 'ArrowLeft'
                  ? selectedIndex - 1
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? points.length - 1
                      : null;
            if (next !== null) {
              event.preventDefault();
              selectPoint(next);
            }
          }}
        >
          <button
            type="button"
            className="collab-tester-checklist__arrow"
            aria-label="上一测试项"
            disabled={selectedIndex === 0}
            onClick={() => selectPoint(selectedIndex - 1)}
          >
            <svg
              aria-hidden="true"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <div
            className="collab-tester-checklist__panels"
            ref={panels}
            tabIndex={0}
            role="group"
            aria-label={points[selectedIndex]?.title}
          >
            {points.map((point, index) => (
              <section
                key={JSON.stringify(point)}
                className="collab-tester-checklist__panel"
                id={`${id}-panel-${index}`}
                aria-labelledby={`${id}-title-${index}`}
                hidden={index !== selectedIndex}
              >
                <header>
                  <h3 id={`${id}-title-${index}`}>{point.title}</h3>
                  {point.kind === 'DERIVED' ? (
                    <span className="collab-tester-checklist__badge">
                      衍生回归
                    </span>
                  ) : null}
                </header>
                <div>
                  <h4>操作步骤</h4>
                  <ol>
                    {testInstructionLines(point.steps).map((step, position) => (
                      <li key={position}>{step}</li>
                    ))}
                  </ol>
                </div>
                <div>
                  <h4>预期结果</h4>
                  <ul>
                    {testInstructionLines(point.expectedResult).map(
                      (expected, position) => (
                        <li key={position}>{expected}</li>
                      ),
                    )}
                  </ul>
                </div>
                {point.kind === 'DERIVED' ? (
                  <p className="collab-tester-checklist__reason">
                    关联原因：{point.reason}
                  </p>
                ) : null}
              </section>
            ))}
          </div>
          <button
            type="button"
            className="collab-tester-checklist__arrow"
            aria-label="下一测试项"
            disabled={selectedIndex === points.length - 1}
            onClick={() => selectPoint(selectedIndex + 1)}
          >
            <svg
              aria-hidden="true"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        </div>
      ) : (
        <p className="collab-tester-checklist__notice">
          本轮尚未生成可用的测试范围，请等待修复与更新完成。
        </p>
      )}
    </section>
  );
}

export function testInstructionLines(text: string): string[] {
  return text
    .split(/\r?\n|(?<=[。；])\s*/u)
    .map((line) => line.trim().replace(/^(?:[-*•]\s+|\d+[.)、]\s+)/u, ''))
    .filter(Boolean);
}
