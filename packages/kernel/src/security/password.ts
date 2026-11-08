import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * One-way password hashing (scrypt). Stored format:
 *   scrypt$<N>$<r>$<p>$<salt b64url>$<hash b64url>
 */
const PREFIX = 'scrypt';
const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LEN = 32;
const HASH_RE = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

function derive(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LEN, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export function isPasswordHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return [PREFIX, PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const m = stored ? HASH_RE.exec(stored) : null;
  if (!m) {
    // Burn comparable time so a missing user or password is not distinguishable by timing.
    await derive(password, DUMMY_SALT, PARAMS);
    return false;
  }
  const [, n, r, p, salt, hash] = m;
  const expected = Buffer.from(hash!, 'base64url');
  const actual = await derive(password, Buffer.from(salt!, 'base64url'), { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const DUMMY_SALT = randomBytes(16);
