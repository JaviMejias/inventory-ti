import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

const algorithm = 'scrypt';
const cost = 16_384;
const blockSize = 8;
const parallelization = 1;
const keyLength = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, keyLength, { N: cost, r: blockSize, p: parallelization, maxmem: 128 * 1024 * 1024 });
  return [algorithm, cost, blockSize, parallelization, salt.toString('hex'), hash.toString('hex')].join('$');
}

export function verifyPassword(password: string, storedHash: string | null): boolean {
  if (!storedHash) {
    return false;
  }

  const [storedAlgorithm, storedCost, storedBlockSize, storedParallelization, saltHex, hashHex] = storedHash.split('$');
  if (storedAlgorithm !== algorithm || !storedCost || !storedBlockSize || !storedParallelization || !saltHex || !hashHex) {
    return false;
  }

  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(storedCost),
      r: Number(storedBlockSize),
      p: Number(storedParallelization),
      maxmem: 128 * 1024 * 1024
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
