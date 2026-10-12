export const BUG_DEPLOYMENT_SCHEMA = `
CREATE TABLE cooking_bug_deployment (
  bug_id TEXT PRIMARY KEY REFERENCES cooking_bug(id) ON DELETE CASCADE,
  deployment_json TEXT NOT NULL CHECK (json_valid(deployment_json))
) STRICT;
`;
