export function messageRedirectPath(
  basePath: string,
  kind: 'success' | 'error',
  message: string,
): string {
  if (!basePath.startsWith('/') || basePath.startsWith('//'))
    throw new Error('跳转路径必须是站内绝对路径');
  const url = new URL(basePath, 'http://agent-party-time.local');
  url.searchParams.set(kind, message);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function rethrowRedirectError(error: unknown): void {
  if (
    error instanceof Error &&
    'digest' in error &&
    typeof error.digest === 'string' &&
    error.digest.startsWith('NEXT_REDIRECT')
  )
    throw error;
}
