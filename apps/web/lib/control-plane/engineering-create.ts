import {
  CreateEngineeringCommandSchema,
  ProjectIdSchema,
  type CreateEngineeringCommand,
} from '@agent-party-time/shared/control-plane';

export async function prepareEngineeringCreation(
  raw: unknown,
  projectId: string,
  idempotencyKey: string,
): Promise<CreateEngineeringCommand> {
  return CreateEngineeringCommandSchema.parse({
    ...(raw as Record<string, unknown>),
    projectId: ProjectIdSchema.parse(projectId),
    slug: `engineering-${await stableToken(idempotencyKey)}`,
    repositoryUrl: null,
  });
}

async function stableToken(value: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
