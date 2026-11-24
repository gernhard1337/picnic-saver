import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { errorMessage, PicnicSaverError } from "../errors.js";
import { parseIgnoreList, type IgnoreRule } from "../ignore.js";

/** Reads the ignore list from a JSON file. A missing file is an empty list. */
export function readIgnoreFile(path: string): IgnoreRule[] {
  if (!existsSync(path)) return [];
  try {
    return parseIgnoreList(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new PicnicSaverError(`Can't read the ignore list in ${path}: ${errorMessage(error)}`);
  }
}

export function writeIgnoreFile(path: string, rules: IgnoreRule[]): void {
  writeFileSync(path, JSON.stringify({ ignore: rules }, null, 2) + "\n");
}

function sameRule(a: IgnoreRule, b: IgnoreRule): boolean {
  const normalize = (rule: IgnoreRule) => (typeof rule === "string" ? { name: rule, productId: undefined } : rule);
  const [x, y] = [normalize(a), normalize(b)];
  return (x.name ?? "").trim().toLowerCase() === (y.name ?? "").trim().toLowerCase() && (x.productId ?? "") === (y.productId ?? "");
}

/** Adds the rules that aren't in the list yet. Returns the new list and the rules that were added. */
export function addIgnoreRules(rules: IgnoreRule[], additions: IgnoreRule[]): { rules: IgnoreRule[]; added: IgnoreRule[] } {
  const result = [...rules];
  const added: IgnoreRule[] = [];
  for (const rule of additions) {
    if (result.some((existing) => sameRule(existing, rule))) continue;
    result.push(rule);
    added.push(rule);
  }
  return { rules: result, added };
}

/** Removes the rules with these names or product ids. Returns the new list and the rules that were removed. */
export function removeIgnoreRules(rules: IgnoreRule[], names: string[], productIds: string[]): { rules: IgnoreRule[]; removed: IgnoreRule[] } {
  const targets: IgnoreRule[] = [...names, ...productIds.map((productId) => ({ productId }))];
  const removed = rules.filter((rule) => targets.some((target) => sameRule(rule, target)));
  return { rules: rules.filter((rule) => !removed.includes(rule)), removed };
}
