import type { Activity, Finding, LocatedActivity } from './schema';

/** Deliberately bounded, literal-only shell parsing; never executes repository text. */
function literalWords(input: string): string[] | null {
  if (input.length > 8192 || /[$`\n\r]/u.test(input)) return null;
  const words: string[] = [];
  let word = '';
  let quote = '';
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"') {
        if (++i >= input.length) return null;
        word += input[i];
      } else word += c;
    } else if (c === '"' || c === "'") quote = c;
    else if (/\s/u.test(c)) {
      if (word) words.push(word);
      word = '';
    } else if (';&|<>'.includes(c)) return null;
    else if (c === '\\') {
      if (++i >= input.length) return null;
      word += input[i];
    } else word += c;
  }
  if (quote) return null;
  if (word) words.push(word);
  return words;
}

export function literalCommand(
  command: string,
  depth = 0,
): { executable: string; args: string[] } | null {
  if (depth > 5) return null;
  const words = literalWords(command);
  if (!words?.length) return null;
  let index = 0;
  if (['env', 'cross-env'].includes(words[index]?.split('/').at(-1) ?? '')) index++;
  while (/^[a-zA-Z_][a-zA-Z0-9_]*=/u.test(words[index] ?? '')) index++;
  const executable = words[index]?.split('/').at(-1);
  const args = words.slice(index + 1);
  if (!executable) return null;
  if (['sh', 'bash', 'zsh'].includes(executable))
    return args.length === 2 && ['-c', '-lc'].includes(args[0]!)
      ? literalCommand(args[1]!, depth + 1)
      : null;
  return { executable, args };
}

export function classifyCommand(command: string): Activity {
  const invocation = literalCommand(command);
  if (!invocation) return 'unknown';
  const { executable, args } = invocation;
  if (
    args.some((a) =>
      ['--help', '-h', '--listTests', '--list-tests', '--dry-run'].includes(a),
    )
  )
    return 'read';
  if (['cat', 'sed', 'head', 'tail', 'ls', 'pwd', 'stat'].includes(executable))
    return 'read';
  if (['rg', 'grep', 'find'].includes(executable)) return 'search';
  if (['apply_patch'].includes(executable)) return 'edit';
  if (executable === 'git') {
    const gitArgs = [...args];
    while (gitArgs[0] === '-C' || gitArgs[0] === '-c') gitArgs.splice(0, 2);
    const subcommand = gitArgs[0];
    if (subcommand === 'push') return 'git.push';
    if (subcommand === 'commit') return 'git.commit';
    if (['merge', 'cherry-pick', 'apply'].includes(subcommand ?? ''))
      return 'git.integrate';
    if (
      ['status', 'diff', 'show', 'log', 'rev-parse', 'ls-remote'].includes(
        subcommand ?? '',
      )
    )
      return 'git.inspect';
    return 'unknown';
  }
  if (['node', 'bun'].includes(executable) && args.includes('--test')) return 'test';
  if (['pytest', 'jest', 'vitest'].includes(executable))
    return args.includes('--collect-only') || args.includes('--listTests')
      ? 'read'
      : 'test';
  if (
    ['python', 'python3'].includes(executable) &&
    args[0] === '-m' &&
    ['pytest', 'unittest'].includes(args[1] ?? '')
  )
    return 'test';
  if (executable === 'tsc') return 'typecheck';
  if (executable === 'bun' && args[0] === 'build') return 'build';
  if (executable === 'eslint') return 'lint';
  if (
    (['umi', 'vite', 'next'].includes(executable) && args[0] === 'build') ||
    executable === 'webpack'
  )
    return 'build';
  if (executable === 'deploy-cli-service' && args[0] === 'deploy') return 'deploy';
  if (
    ['npm', 'pnpm', 'yarn', 'bun'].includes(executable) &&
    ['install', 'ci'].includes(args[0] ?? '')
  )
    return 'install';
  // Package script names alone never prove what the script does.
  return 'unknown';
}

export function diagnoseActivities(
  intervals: LocatedActivity[],
  unplaced: import('./schema').ObservationReport['unplaced'],
  unassignedMs: number,
): Finding[] {
  const roots = intervals.filter(
    (entry) =>
      !entry.parentId ||
      !intervals.some(
        (parent) =>
          parent.id === entry.parentId &&
          parent.segmentId === entry.segmentId &&
          parent.connectionId === entry.connectionId &&
          parent.turnId === entry.turnId,
      ),
  );
  const findings: Finding[] = [];
  const common = {
    equivalence: 'unknown' as const,
    removability: 'unassessed' as const,
    estimatedSavingMs: null,
  };
  for (const entry of [...roots]
    .sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs))
    .slice(0, 3)) {
    findings.push({
      ...common,
      id: `cost:${entry.evidence[0]}`,
      kind: 'cost_contributor',
      activity: entry.activity,
      evidence: entry.evidence,
      strength: 'observed',
      durationMs: entry.endMs - entry.startMs,
      missing: [],
    });
  }
  for (const activity of ['build', 'test', 'typecheck', 'lint'] as const) {
    const entries = [
      ...roots
        .filter((entry) => entry.activity === activity)
        .map((entry) => ({ ...entry, strength: 'inferred' as const })),
      ...unplaced
        .filter(
          (entry) =>
            entry.activity === activity &&
            !intervals.some(
              (parent) =>
                parent.segmentId === entry.segmentId &&
                parent.id === entry.parentId &&
                parent.activity === activity &&
                parent.connectionId === entry.connectionId &&
                parent.turnId === entry.turnId,
            ),
        )
        .map((entry) => ({
          ...entry,
          evidence: [entry.eventId],
          strength: 'source_reported' as const,
        })),
    ];
    if (entries.length < 2) continue;
    const supported = entries.some(
      (entry, i) =>
        entry.status === 'succeeded' &&
        entry.workId &&
        entries.some(
          (other, j) =>
            j !== i && other.status === 'succeeded' && other.workId === entry.workId,
        ),
    );
    findings.unshift({
      ...common,
      id: `repeat:${activity}`,
      kind: supported ? 'potential_duplicate_work' : 'repeated_invocation',
      activity,
      evidence: entries.flatMap((entry) => entry.evidence).slice(0, 16),
      strength: entries.some((entry) => entry.strength === 'source_reported')
        ? 'source_reported'
        : 'inferred',
      durationMs: null,
      missing: ['equivalent_inputs', 'coverage', 'phase_requirements'],
    });
  }
  if (unassignedMs > 0 && findings.length < 5)
    findings.push({
      ...common,
      id: 'unassigned',
      kind: 'unassigned_interval',
      evidence: [],
      strength: 'unknown',
      durationMs: unassignedMs,
      missing: ['source_support'],
    });
  return findings.slice(0, 5);
}
