import { createHash } from 'node:crypto';

export function sha256(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Short stable id derived from text (used for cache keys). */
export function shortHash(text: string): string {
  return sha256(text).slice(0, 16);
}
