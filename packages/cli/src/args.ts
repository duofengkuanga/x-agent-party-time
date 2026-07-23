export interface ParsedArgs {
  positionals: string[];
  options: Record<string, string | boolean | string[]>;
}
const BOOLEAN_OPTIONS = new Set([
  'approve',
  'disabled',
  'enabled',
  'follow',
  'help',
  'json',
  'no-color',
  'reject',
  'verbose',
  'version',
]);

export function withoutLeadingPositionals(
  args: readonly string[],
  count: number,
): string[] {
  const result: string[] = [];
  let removed = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith('--')) {
      result.push(arg);
      const equal = arg.indexOf('=');
      const key = arg.slice(2, equal > 0 ? equal : undefined);
      if (
        equal < 0 &&
        !BOOLEAN_OPTIONS.has(key) &&
        args[index + 1] &&
        !args[index + 1]!.startsWith('--')
      )
        result.push(args[++index]!);
      continue;
    }
    if (removed < count) removed += 1;
    else result.push(arg);
  }
  return result;
}

export function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: ParsedArgs['options'] = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const equal = arg.indexOf('=');
    const key = arg.slice(2, equal > 0 ? equal : undefined);
    const next =
      equal > 0
        ? arg.slice(equal + 1)
        : BOOLEAN_OPTIONS.has(key)
          ? true
          : args[index + 1] && !args[index + 1]!.startsWith('--')
            ? args[++index]!
            : true;
    const previous = options[key];
    options[key] =
      previous === undefined
        ? next
        : Array.isArray(previous)
          ? [...previous, String(next)]
          : [String(previous), String(next)];
  }
  return { positionals, options };
}
export function optionString(
  parsed: ParsedArgs,
  key: string,
): string | undefined {
  const value = parsed.options[key];
  return Array.isArray(value)
    ? value.at(-1)
    : typeof value === 'string'
      ? value
      : undefined;
}
export function optionStrings(parsed: ParsedArgs, key: string): string[] {
  const value = parsed.options[key];
  return value === undefined
    ? []
    : Array.isArray(value)
      ? value
      : [String(value)];
}
export function optionBoolean(parsed: ParsedArgs, key: string): boolean {
  return parsed.options[key] === true;
}
export function optionNumber(
  parsed: ParsedArgs,
  key: string,
  fallback: number,
): number;
export function optionNumber(
  parsed: ParsedArgs,
  key: string,
  fallback?: undefined,
): number | undefined;
export function optionNumber(
  parsed: ParsedArgs,
  key: string,
  fallback?: number,
): number | undefined {
  const value = optionString(parsed, key);
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`--${key} 必须是数字`);
  return number;
}
