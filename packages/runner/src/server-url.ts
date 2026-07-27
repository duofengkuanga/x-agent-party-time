export function normalizeServerUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return url.toString().replace(/\/$/u, '');
}
