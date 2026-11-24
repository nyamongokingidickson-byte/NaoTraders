// Password and input validation primitives. Pure functions over node:crypto so they can be
// imported by both the SQLite server and the serverless Postgres build without dragging in a
// database driver.
import crypto from 'node:crypto';
import { config } from './config.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export const err = (message, code, status = 400, extra = {}) =>
  Object.assign(new Error(message), { code, status, ...extra });

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt}$${key.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [, N, salt, hash] = stored.split('$');
    const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: Number(N), r: SCRYPT.r, p: SCRYPT.p });
    const a = Buffer.from(hash, 'hex');
    return a.length === key.length && crypto.timingSafeEqual(a, key);
  } catch { return false; }
}

export function validateEmail(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(clean) || clean.length > 254) {
    throw err('Please enter a valid email address.', 'INVALID_EMAIL');
  }
  return clean;
}

export function validatePassword(password, email = '') {
  const pw = String(password || '');
  const min = config.security.minPasswordLength;
  if (pw.length < min) throw err(`Password must be at least ${min} characters.`, 'WEAK_PASSWORD');
  if (pw.length > 200) throw err('Password is too long.', 'WEAK_PASSWORD');
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) {
    throw err('Password must include at least one letter and one number.', 'WEAK_PASSWORD');
  }
  if (email && pw.toLowerCase().includes(email.split('@')[0].toLowerCase())) {
    throw err('Password must not contain your email address.', 'WEAK_PASSWORD');
  }
  return pw;
}

export function validateName(name) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ');
  if (clean.length < 2) throw err('Please enter your full name.', 'INVALID_NAME');
  if (clean.length > 80) throw err('That name is too long.', 'INVALID_NAME');
  return clean;
}

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
