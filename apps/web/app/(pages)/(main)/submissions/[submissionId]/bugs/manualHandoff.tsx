export function ManualHandoff({
  questions,
  sessionId,
}: {
  questions: string[] | null;
  sessionId: string | null;
}) {
  return (
    <section className="collab-interaction-record">
      <strong>等待人工确认</strong>
      {questions ? (
        <ul>
          {questions.map((question, index) => (
            <li key={index}>{question}</li>
          ))}
        </ul>
      ) : null}
      <p>
        自动执行已停止，会话已释放。请在原 Codex
        会话中回答问题并完成任务，再回到这里点击“同步状态”。
      </p>
      {sessionId ? (
        <a href={`codex://threads/${encodeURIComponent(sessionId)}`}>
          打开原 Codex 会话
        </a>
      ) : (
        <p>等待对应工程负责人处理。</p>
      )}
    </section>
  );
}
