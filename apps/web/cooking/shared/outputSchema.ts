import { z } from 'zod';
import type { JsonObject } from '@agent-party-time/execution-contract';

/** Codex uses the same field constraints as server-side outcome validation. */
export function outputJsonSchema(schema: z.ZodType): JsonObject {
  const { $schema: _, ...output } = z.toJSONSchema(schema, {
    target: 'draft-7',
    override: ({ jsonSchema }) => {
      if (jsonSchema.oneOf) {
        jsonSchema.anyOf = jsonSchema.oneOf;
        delete jsonSchema.oneOf;
      }
      if (jsonSchema.const !== undefined) {
        jsonSchema.enum = [jsonSchema.const];
        delete jsonSchema.const;
      }
    },
  });
  return output as JsonObject;
}
