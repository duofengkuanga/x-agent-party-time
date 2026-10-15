/** Canonicalize only already validated safe payloads, never raw source text. */
export function observationCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(observationCanonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${observationCanonicalJson(item)}`)
      .join(',')}}`;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('不支持的观测值');
  return serialized;
}

export async function observationDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(observationCanonicalJson(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
