import type { z } from 'zod';

type SnakeCase<Name extends string> = Name extends `${infer Head}${infer Tail}`
  ? `${Head extends Lowercase<Head> ? Head : `_${Lowercase<Head>}`}${SnakeCase<Tail>}`
  : Name;

/** The columns for a flat DTO whose properties use camelCase. */
export type DatabaseRow<Dto> = {
  [Key in keyof Dto as Key extends string ? SnakeCase<Key> : never]: Dto[Key];
};

type FlatSchema = z.ZodType & { shape: object };

/** Read only declared DTO fields; SQLite column names use snake_case. */
export function parseRow<Schema extends FlatSchema>(
  schema: Schema,
  row: object,
): z.output<Schema> {
  const record = row as Record<string, unknown>;
  const projected = Object.fromEntries(
    Object.keys(schema.shape).map((key) => [
      key,
      record[key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)],
    ]),
  );
  return schema.parse(projected) as z.output<Schema>;
}
