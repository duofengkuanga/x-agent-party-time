import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { ERROR_CODES, createAppError } from '@agent-party-time/shared';
import type { Logger } from '../logging/logger.js';

export const TokenReferenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('env'),
    variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  }),
  z.object({ kind: z.literal('file'), path: z.string().min(1) }),
  z.object({
    kind: z.literal('keychain'),
    service: z.string().min(1),
    account: z.string().min(1),
  }),
]);
export type TokenReference = z.infer<typeof TokenReferenceSchema>;
export const ResolvedTokenSchema = z.object({
  value: z.string().min(1),
  source: z.enum(['env', 'file', 'keychain']),
  resolvedAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
});
export type ResolvedToken = z.infer<typeof ResolvedTokenSchema>;
export interface KeychainAdapter {
  get(service: string, account: string): Promise<string | null>;
}
export interface TokenResolverOptions {
  env: Readonly<Record<string, string | undefined>>;
  cacheTtlMs: number;
  keychain: KeychainAdapter;
  allowedFileRoot: string;
  logger: Logger;
}

export function parseTokenReference(value: string): TokenReference {
  const separator = value.indexOf(':');
  if (separator <= 0)
    throw createAppError({
      code: ERROR_CODES.configInvalid,
      category: 'validation',
      message: 'tokenRef 格式无效',
      retryable: false,
    });
  const kind = value.slice(0, separator);
  const locator = value.slice(separator + 1);
  if (kind === 'env')
    return TokenReferenceSchema.parse({ kind, variable: locator });
  if (kind === 'file')
    return TokenReferenceSchema.parse({ kind, path: locator });
  if (kind === 'keychain') {
    const slash = locator.indexOf('/');
    return TokenReferenceSchema.parse({
      kind,
      service: locator.slice(0, slash),
      account: locator.slice(slash + 1),
    });
  }
  throw createAppError({
    code: ERROR_CODES.configInvalid,
    category: 'validation',
    message: `不支持 tokenRef 类型 ${kind}`,
    retryable: false,
  });
}

export class TokenResolver {
  private readonly cache = new Map<string, ResolvedToken>();
  constructor(private readonly options: TokenResolverOptions) {}

  async resolve(reference: string): Promise<ResolvedToken> {
    const cached = this.cache.get(reference);
    if (cached?.expiresAt && Date.parse(cached.expiresAt) > Date.now())
      return cached;
    const parsed = parseTokenReference(reference);
    const started = Date.now();
    let value: string | undefined | null;
    if (parsed.kind === 'env') value = this.options.env[parsed.variable];
    else if (parsed.kind === 'keychain')
      value = await this.options.keychain.get(parsed.service, parsed.account);
    else {
      const root = await realpath(this.options.allowedFileRoot);
      const target = await realpath(
        isAbsolute(parsed.path) ? parsed.path : resolve(root, parsed.path),
      );
      if (relative(root, target).startsWith('..'))
        throw createAppError({
          code: ERROR_CODES.configInvalid,
          category: 'permission',
          message: 'token 文件不在允许目录内',
          retryable: false,
        });
      value = await readFile(target, 'utf8');
    }
    const token = value?.trim();
    if (!token)
      throw createAppError({
        code: ERROR_CODES.channelAuthenticationFailed,
        category: 'authentication',
        message: `无法解析 ${parsed.kind} 凭据`,
        retryable: false,
      });
    const now = new Date();
    const result = ResolvedTokenSchema.parse({
      value: token,
      source: parsed.kind,
      resolvedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + this.options.cacheTtlMs,
      ).toISOString(),
    });
    this.cache.set(reference, result);
    this.options.logger.debug('token.resolved', '凭据引用已解析', {
      kind: parsed.kind,
      durationMs: Date.now() - started,
    });
    return result;
  }
  invalidate(reference: string): void {
    this.cache.delete(reference);
  }
  close(): void {
    this.cache.clear();
  }
}
