import { Detail } from './detail-fields';

type SessionAttempt = {
  attempt: number;
  sessionId: string | null;
  agentName?: string;
};

export function SessionFacts({
  attempts,
  label,
}: {
  attempts: SessionAttempt[];
  label: string;
}) {
  const sessions = new Map<string, SessionAttempt & { rounds: number[] }>();
  for (const attempt of attempts) {
    if (!attempt.sessionId && !attempt.agentName) continue;
    const key = JSON.stringify([attempt.sessionId, attempt.agentName]);
    const existing = sessions.get(key);
    if (existing) existing.rounds.push(attempt.attempt);
    else sessions.set(key, { ...attempt, rounds: [attempt.attempt] });
  }
  if (!sessions.size) return null;
  return (
    <div className="collab-session-overview" aria-label={label}>
      {[...sessions].map(([key, session]) => (
        <div key={key}>
          {sessions.size > 1 ? <p>第 {session.rounds.join('、')} 轮</p> : null}
          <dl>
            {session.sessionId ? (
              <Detail label={label}>
                <code>{session.sessionId}</code>
              </Detail>
            ) : null}
            {session.agentName ? (
              <Detail label="Agent">{session.agentName}</Detail>
            ) : null}
          </dl>
        </div>
      ))}
    </div>
  );
}
