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
      Number(left.kind === 'DERIVED') - Number(right.kind === 'DERIVED'),
  );
  const limitations = [
    ...new Set(scopes.flatMap((scope) => scope.limitations)),
  ];
  return (
    <section className="collab-tester-checklist" aria-label="本次要测">
      <h3>
        本次要测{points.length ? <span> · {points.length} 项</span> : null}
      </h3>
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
      {points.length ? (
        <ol>
          {points.map((point) => (
            <li
              key={JSON.stringify(point)}
              className={
                point.kind === 'DERIVED'
                  ? 'collab-tester-checklist__derived'
                  : undefined
              }
            >
              <div>
                <strong>{point.title}</strong>
                {point.kind === 'DERIVED' ? (
                  <span className="collab-tester-checklist__badge">
                    衍生回归
                  </span>
                ) : null}
              </div>
              <p>{point.steps}</p>
              <p>
                <span>预期：</span>
                {point.expectedResult}
              </p>
              {point.kind === 'DERIVED' ? (
                <p className="collab-tester-checklist__reason">
                  关联原因：{point.reason}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="collab-tester-checklist__notice">
          本轮尚未生成可用的测试范围，请等待修复与更新完成。
        </p>
      )}
      {limitations.length ? (
        <aside aria-label="尚未覆盖">
          <h4>尚未覆盖</h4>
          <ul>
            {limitations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </aside>
      ) : null}
    </section>
  );
}
