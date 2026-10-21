import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  classifyCommand,
  literalCommand,
  type Activity,
} from '@agent-party-time/execution-contract/observability';

export interface CommandClassifier {
  classify(command: string, cwd?: string): Activity;
  invalidate(): void;
  readonly ready: Promise<void>;
}

/** Bounded static context from the command's actual directory, never executed. */
export function createCommandClassifier(repositoryPath: string): CommandClassifier {
  type Context = { scripts: Record<string, string> | null; ready: Promise<void> };
  const contexts = new Map<string, Context>();
  let generation = 0;
  const root = resolve(repositoryPath);
  const refresh = (cwd: string): Context | null => {
    if (!isAbsolute(cwd)) return null;
    const location = resolve(cwd);
    const inside = relative(root, location);
    if (inside.startsWith('..') || isAbsolute(inside)) return null;
    const existing = contexts.get(location);
    if (existing) return existing;
    if (contexts.size >= 16) return null;
    const requestedGeneration = generation;
    const context: Context = { scripts: null, ready: Promise.resolve() };
    contexts.set(location, context);
    context.ready = (async () => {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        // Refuse symlinked directory components, including paths leaving this workspace.
        if ((await realpath(root)) !== root || (await realpath(location)) !== location)
          return;
        handle = await open(
          join(location, 'package.json'),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        const info = await handle.stat();
        if (!info.isFile() || info.size > 256 * 1024) return;
        const bytes = new Uint8Array(256 * 1024 + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 256 * 1024) return;
        const value = JSON.parse(
          new TextDecoder().decode(bytes.subarray(0, bytesRead)),
        ) as unknown;
        if (
          !value ||
          typeof value !== 'object' ||
          !('scripts' in value) ||
          !value.scripts ||
          typeof value.scripts !== 'object' ||
          Array.isArray(value.scripts)
        )
          return;
        const entries = Object.entries(value.scripts);
        if (
          entries.length > 64 ||
          entries.some((entry) => typeof entry[1] !== 'string' || entry[1].length > 8192)
        )
          return;
        if (requestedGeneration === generation)
          context.scripts = Object.fromEntries(entries) as Record<string, string>;
      } catch {
        /* Missing or unsafe static context is explicitly classified as unknown. */
      } finally {
        await handle?.close();
      }
    })().catch(() => {
      context.scripts = null;
    });
    return context;
  };
  const infer = (
    command: string,
    scripts: Record<string, string> | null,
    depth = 0,
    visited = new Set<string>(),
  ): Activity => {
    const direct = classifyCommand(command);
    if (direct !== 'unknown') return direct;
    if (depth >= 5 || !scripts) return 'unknown';
    const invocation = literalCommand(command);
    if (
      !invocation ||
      !['npm', 'pnpm', 'yarn', 'bun'].includes(invocation.executable) ||
      invocation.args[0] !== 'run' ||
      invocation.args.length !== 2
    )
      return 'unknown';
    const name = invocation.args[1]!;
    if (visited.has(name) || !Object.hasOwn(scripts, name)) return 'unknown';
    if (Object.hasOwn(scripts, `pre${name}`) || Object.hasOwn(scripts, `post${name}`))
      return 'mixed';
    return infer(scripts[name]!, scripts, depth + 1, new Set([...visited, name]));
  };
  refresh(root);
  return {
    classify: (command, cwd = root) => infer(command, refresh(cwd)?.scripts ?? null),
    get ready() {
      return Promise.all([...contexts.values()].map((context) => context.ready)).then(
        () => {},
      );
    },
    invalidate: () => {
      generation++;
      contexts.clear();
      refresh(root);
    },
  };
}
