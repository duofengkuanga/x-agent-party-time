export const SESSION_COOKIE_NAME = 'agent_party_time_session';
export const SESSION_DURATION_MS = 12 * 60 * 60 * 1_000;

export function sessionSecret() {
  return (
    process.env.AGENT_PARTY_TIME_SESSION_SECRET ??
    'agent-party-time-local-demo-session-secret-v1'
  );
}
