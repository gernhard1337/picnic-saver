import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";

/** Reads a .env file into an object. A missing file is an empty object. */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return { ...parseEnv(readFileSync(path, "utf8")) } as Record<string, string>;
}

function formatValue(value: string): string {
  return /^[\w.\-+/=:@]*$/.test(value) ? value : JSON.stringify(value);
}

/**
 * Sets or removes (null) variables in a .env file and leaves every other line as it is. Creates
 * the file when it doesn't exist. The file is made readable for its owner only.
 */
export function updateEnvFile(path: string, updates: Record<string, string | null>): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  if (lines.at(-1) === "") lines.pop();
  const pending = new Map(Object.entries(updates));

  const kept = lines.flatMap((line) => {
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (key === undefined || !pending.has(key)) return [line];
    const value = pending.get(key)!;
    pending.delete(key);
    return value === null ? [] : [`${key}=${formatValue(value)}`];
  });
  for (const [key, value] of pending) {
    if (value !== null) kept.push(`${key}=${formatValue(value)}`);
  }

  writeFileSync(path, kept.join("\n") + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** True when the .env file sits in a git repository whose .gitignore doesn't mention it. */
export function isUnignoredInGit(path: string): boolean {
  const directory = dirname(path);
  if (!existsSync(join(directory, ".git"))) return false;
  const gitignore = join(directory, ".gitignore");
  if (!existsSync(gitignore)) return true;
  return !readFileSync(gitignore, "utf8")
    .split(/\r?\n/)
    .some((line) => /^\/?\.env(\*|\.\*)?$/.test(line.trim()));
}
