import type {
  FrozenRepairHandoff,
  UpdateHandoffUse,
} from '@/cooking/update/contract';
import { RoundLines } from './executionRound';

export function RepairHandoffDetails({
  sources,
}: {
  sources: FrozenRepairHandoff[];
}) {
  return (
    <section className="collab-round-detail">
      <h4>冻结的修复交接</h4>
      <p>历史上下文不代表本轮检查通过。</p>
      {sources.map((source, index) => (
        <section className="collab-round-detail" key={source.attemptId}>
          <h4>来源修复 {index + 1}</h4>
          <p>
            {source.commits.map((commit) => commit.slice(0, 12)).join('、')}
          </p>
          {source.handoff.validationCommands.length ? (
            <ul>
              {source.handoff.validationCommands.map((entry, i) => (
                <li key={i}>
                  <strong>
                    {source.validations[entry.validationIndex]?.name}
                  </strong>{' '}
                  <code>{entry.command}</code>
                  <p>
                    目录：{entry.workingDirectory} · {entry.runtime}
                  </p>
                  {entry.conditions ? (
                    <p>适用条件：{entry.conditions}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {source.handoff.environmentNotes.length ? (
            <RoundLines
              label="已确认的环境经验"
              empty=""
              items={source.handoff.environmentNotes.map(
                (entry) =>
                  `${entry.issue}：${entry.resolution}（${entry.appliesWhen}）`,
              )}
            />
          ) : null}
          {source.handoff.impact.length ? (
            <RoundLines
              label="影响入口"
              empty=""
              items={source.handoff.impact.map(
                (entry) => `${entry.path}：${entry.note}`,
              )}
            />
          ) : null}
          {source.handoff.remainingWork.length ? (
            <RoundLines
              label="修复结束时的待补事项"
              empty=""
              items={source.handoff.remainingWork}
            />
          ) : null}
          {source.handoff.limitations.length ? (
            <RoundLines
              label="历史结论限制"
              empty=""
              items={source.handoff.limitations}
            />
          ) : null}
        </section>
      ))}
    </section>
  );
}

export function HandoffUseDetails({
  use,
  validations,
}: {
  use: UpdateHandoffUse;
  validations: Array<{ name: string }>;
}) {
  if (
    !use.adopted.length &&
    !use.rechecked.length &&
    !use.validationCommands.length
  )
    return null;
  return (
    <section className="collab-round-detail">
      <h4>本轮交接使用与验收依据</h4>
      {use.adopted.length ? (
        <RoundLines label="沿用的上下文" empty="" items={use.adopted} />
      ) : null}
      {use.rechecked.length ? (
        <RoundLines
          label="重新核实"
          empty=""
          items={use.rechecked.map(
            (entry) => `${entry.context}：${entry.reason}`,
          )}
        />
      ) : null}
      {use.validationCommands.length ? (
        <ul>
          {use.validationCommands.map((entry, index) => (
            <li key={index}>
              <strong>{validations[entry.validationIndex]?.name}</strong>{' '}
              <code>{entry.command}</code>
              <p>
                目录：{entry.workingDirectory} · {entry.reason}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
