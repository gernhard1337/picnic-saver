/** Words that mark a variant of a product, not a different product. */
const VARIANT_WORDS = new Set(["bio", "biologisch", "biologische", "biologique", "organic", "öko", "oeko", "eko"]);

/** The words of a product name in lower case, without variant words such as "Bio". */
export function nameTokens(name: string): string[] {
  const words = name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((word) => !VARIANT_WORDS.has(word)))];
}

/** A key that is equal for names that differ only in word order and variant words. */
export function nameKey(name: string): string {
  return nameTokens(name).sort().join(" ");
}

/** The share of the words of `name` that also occur in `other`, from 0 to 1. */
export function nameOverlap(name: string, other: string): number {
  const tokens = nameTokens(name);
  if (tokens.length === 0) return 0;
  const otherTokens = new Set(nameTokens(other));
  return tokens.filter((token) => otherTokens.has(token)).length / tokens.length;
}
