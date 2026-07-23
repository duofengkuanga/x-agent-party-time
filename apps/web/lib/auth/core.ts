export type AccountType = 'DEVELOPER' | 'TESTER';

export interface DemoUser {
  id: string;
  username: string;
  password: string;
  displayName: string;
  accountType: AccountType;
}

export type CurrentUser = Omit<DemoUser, 'password'>;

export const DEMO_USERS: readonly DemoUser[] = [
  {
    id: 'user-xujiequan',
    username: 'xujiequan',
    password: '123456',
    displayName: '徐捷泉',
    accountType: 'DEVELOPER',
  },
  {
    id: 'user-zhoumingbo',
    username: 'zhoumingbo',
    password: '123456',
    displayName: '周明波',
    accountType: 'DEVELOPER',
  },
  {
    id: 'user-tianguohui',
    username: 'tianguohui',
    password: '123456',
    displayName: '田国会',
    accountType: 'TESTER',
  },
] as const;

interface SessionPayload {
  version: 1;
  userId: string;
  expiresAt: number;
}

const encoder = new TextEncoder();

export function authenticateDemoUser(
  username: string,
  password: string,
): CurrentUser | null {
  const normalizedUsername = username.trim().toLowerCase();
  const user = DEMO_USERS.find(
    (candidate) =>
      candidate.username === normalizedUsername &&
      candidate.password === password,
  );
  return user ? toCurrentUser(user) : null;
}

export function findDemoUser(userId: string): CurrentUser | null {
  const user = DEMO_USERS.find((candidate) => candidate.id === userId);
  return user ? toCurrentUser(user) : null;
}

export async function createSessionToken(
  userId: string,
  secret: string,
  expiresAt: number,
): Promise<string> {
  const payload: SessionPayload = { version: 1, userId, expiresAt };
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = await sign(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export async function readSessionToken(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): Promise<CurrentUser | null> {
  if (!token) return null;
  const [encodedPayload, suppliedSignature, extra] = token.split('.');
  if (!encodedPayload || !suppliedSignature || extra) return null;

  const expectedSignature = await sign(encodedPayload, secret);
  if (!constantTimeEqual(suppliedSignature, expectedSignature)) return null;

  try {
    const payload = JSON.parse(
      decodeBase64Url(encodedPayload),
    ) as Partial<SessionPayload>;
    if (
      payload.version !== 1 ||
      typeof payload.userId !== 'string' ||
      typeof payload.expiresAt !== 'number' ||
      payload.expiresAt <= now
    )
      return null;
    return findDemoUser(payload.userId);
  } catch {
    return null;
  }
}

export function safeRedirectPath(value: string | null | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  return value;
}

function toCurrentUser(user: DemoUser): CurrentUser {
  const { password: _password, ...currentUser } = user;
  return currentUser;
}

async function sign(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(value),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

function encodeBase64Url(value: string) {
  return bytesToBase64Url(encoder.encode(value));
}

function decodeBase64Url(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1)
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}
