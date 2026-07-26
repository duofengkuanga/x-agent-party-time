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
