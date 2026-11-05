export type RawObject = Record<string, unknown>;

export function isObject(value: unknown): value is RawObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): RawObject {
  return isObject(value) ? value : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringList(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === 'string');
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** @throws {Error} When the file is not in the set. */
export function parseJsonFile(files: ReadonlyMap<string, string>, file: string): RawObject {
  const text = files.get(file);
  if (text === undefined) {
    throw new Error(`${file} is missing, so migrate cannot read the project. Fix: restore ${file} from git, or pass the directory of a complete project.`);
  }
  try {
    return asObject(JSON.parse(text));
  } catch (error) {
    throw new Error(`${(error as Error).message}. Fix: make ${file} valid JSON at the position that this message names.`);
  }
}
