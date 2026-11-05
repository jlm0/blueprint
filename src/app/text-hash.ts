export function textHash(parts: readonly string[]): string {
  let length = 0;
  for (const part of parts) length += part.length;
  let first = 0xdeadbeef ^ length;
  let second = 0x41c6ce57 ^ length;
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      const code = part.charCodeAt(index);
      first = Math.imul(first ^ code, 2654435761);
      second = Math.imul(second ^ code, 1597334677);
    }
    first = Math.imul(first ^ 0xffff, 2654435761);
    second = Math.imul(second ^ 0xffff, 1597334677);
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
  return `${length.toString(36)}.${(first >>> 0).toString(36)}.${(second >>> 0).toString(36)}`;
}
