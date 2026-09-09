import { promisify } from 'node:util';
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';

const scrypt = promisify(scryptCallback);
const FORMAT = 'scrypt';
const VERSION = '1';
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return [
    FORMAT,
    VERSION,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  const [format, version, encodedSalt, encodedDerived, extra] =
    encodedHash.split('$');
  if (
    format !== FORMAT ||
    version !== VERSION ||
    !encodedSalt ||
    !encodedDerived ||
    extra
  )
    return false;

  try {
    const salt = Buffer.from(encodedSalt, 'base64url');
    const expected = Buffer.from(encodedDerived, 'base64url');
    const actual = (await scrypt(password, salt, expected.length)) as Buffer;
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  } catch {
    return false;
  }
}
