import { PicnicSaverError } from "./errors.js";

/**
 * A product that should never be in the cart.
 *
 * A string, or `name`, matches every product whose name has all of its words as whole words, in
 * any order and without regard to case: `"Petersilie"` matches "Bio Petersilie glatt" but not
 * "Petersilienwurzel". `productId` matches exactly that product. A rule with both needs both.
 */
export type IgnoreRule = string | { name?: string; productId?: string; note?: string };

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function matches(rule: IgnoreRule, product: { productId: string; name: string }): boolean {
  const { name, productId } = typeof rule === "string" ? { name: rule, productId: undefined } : rule;
  const ruleWords = name === undefined ? [] : words(name);
  if (productId === undefined && ruleWords.length === 0) return false;
  if (productId !== undefined && productId !== product.productId) return false;
  const productWords = new Set(words(product.name));
  return ruleWords.every((word) => productWords.has(word));
}

/** Returns the first rule that matches the product, or null. */
export function matchIgnoreRule(product: { productId: string; name: string }, rules: IgnoreRule[]): IgnoreRule | null {
  return rules.find((rule) => matches(rule, product)) ?? null;
}

/** How a rule reads in messages: its name, its product id, or both. */
export function describeIgnoreRule(rule: IgnoreRule): string {
  if (typeof rule === "string") return rule;
  return [rule.name, rule.productId].filter(Boolean).join(" / ");
}

/**
 * Validates an ignore list read from JSON: either an array of rules or `{ "ignore": [...] }`.
 * A rule is a string or an object with `name`, `productId` or both, and an optional `note`.
 * @throws {PicnicSaverError} When the data has another shape.
 */
export function parseIgnoreList(data: unknown): IgnoreRule[] {
  const list = Array.isArray(data) ? data : (data as { ignore?: unknown } | null)?.ignore;
  if (!Array.isArray(list)) throw new PicnicSaverError('An ignore list must be an array or an object like { "ignore": [...] }.');
  return list.map((rule: unknown, index): IgnoreRule => {
    if (typeof rule === "string" && rule.trim() !== "") return rule;
    if (rule && typeof rule === "object") {
      const { name, productId, note } = rule as Record<string, unknown>;
      const valid = [name, productId, note].every((value) => value === undefined || typeof value === "string");
      if (valid && (name || productId)) return { ...(name ? { name } : {}), ...(productId ? { productId } : {}), ...(note ? { note } : {}) } as IgnoreRule;
    }
    throw new PicnicSaverError(`Ignore rule ${index + 1} must be a name or an object with "name" or "productId".`);
  });
}
