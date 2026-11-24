import { quantityInCart } from "./cart.js";
import { nameKey } from "./names.js";
import { buildSuggestion } from "./suggestion.js";
import type { AlternativeCandidate, CartItem, CartSummary, DuplicateGroup, DuplicateItem, ProductInfo, SwapSuggestion } from "./types.js";

export interface DuplicateOptions {
  /** The least a product must cost less per unit to be offered for consolidation, in cents. Default: 1. */
  minSavingPerUnit?: number;
  /** Also offer to consolidate lines that belong to a recipe. Default: true. */
  includeRecipeItems?: boolean;
}

type Reason = DuplicateGroup["reasons"][number];

/**
 * Finds cart lines that are the same kind of product at different prices, e.g. milk and organic
 * milk, or the same potatoes in two package sizes. Two lines are linked when their names are
 * equal apart from the brand and words such as "Bio"; Picnic listing one as similar to the other
 * raises the confidence, but is not enough on its own, because Picnic's similar products include
 * other kinds of product. Each group comes with suggestions that move the more expensive lines
 * onto the cheapest product.
 *
 * @param cart The cart.
 * @param products The product pages of the cart's products, by product id. Lines without one are
 *   only matched by name.
 */
export function findDuplicates(cart: CartSummary, products: Record<string, ProductInfo> = {}, options: DuplicateOptions = {}): DuplicateGroup[] {
  const items = cart.items.filter((item) => !item.isUnavailable && !item.ignored);
  const parent = items.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index]!)));
  const reasonsByRoot = new Map<number, Set<Reason>>();
  const links: Array<[number, number, Reason[]]> = [];

  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      const reasons = linkReasons(items[a]!, items[b]!, products);
      if (reasons.length > 0) links.push([a, b, reasons]);
    }
  }
  for (const [a, b] of links) parent[find(a)] = find(b);
  for (const [a, , reasons] of links) {
    const set = reasonsByRoot.get(find(a)) ?? new Set<Reason>();
    reasons.forEach((reason) => set.add(reason));
    reasonsByRoot.set(find(a), set);
  }

  const groups: DuplicateGroup[] = [];
  for (const [root, reasons] of reasonsByRoot) {
    const members = items.filter((_, index) => find(index) === root);
    const group = buildGroup(members, [...reasons].sort().reverse(), cart, products, options);
    if (group) groups.push(group);
  }
  return groups;
}

function linkReasons(a: CartItem, b: CartItem, products: Record<string, ProductInfo>): Reason[] {
  if (a.productId === b.productId) return [];
  const sameUnit = !a.packageSize || !b.packageSize || a.packageSize.unit === b.packageSize.unit;
  const keyA = nameKey(products[a.productId]?.name ?? a.name);
  const keyB = nameKey(products[b.productId]?.name ?? b.name);
  if (!sameUnit || keyA === "" || keyA !== keyB) return [];

  const similar = products[a.productId]?.similarProductIds.includes(b.productId) || products[b.productId]?.similarProductIds.includes(a.productId);
  return similar ? ["similar-products", "name-match"] : ["name-match"];
}

function buildGroup(members: CartItem[], reasons: Reason[], cart: CartSummary, products: Record<string, ProductInfo>, options: DuplicateOptions): DuplicateGroup | null {
  const sorted = [...members].sort((a, b) => (a.basePrice?.price ?? Infinity) - (b.basePrice?.price ?? Infinity));
  const cheapest = sorted[0]!;
  const comparable = cheapest.basePrice ? sorted.filter((item) => item.basePrice?.unit === cheapest.basePrice!.unit) : [];
  const spread = comparable.length > 1 ? comparable.at(-1)!.basePrice!.price - cheapest.basePrice!.price : null;
  // The same kind of product at the same price is nothing to point out.
  if (spread === 0) return null;

  const consolidation: SwapSuggestion[] = [];
  if (spread !== null) {
    const target = consolidationTarget(cheapest, products[cheapest.productId]);
    const inCart = quantityInCart(cart, cheapest.productId);
    for (const item of comparable.slice(1)) {
      if (item.recipeId && options.includeRecipeItems === false) continue;
      const suggestion = buildSuggestion({ kind: "consolidate", item, candidate: target, quantityInCart: inCart, minSavingPerUnit: options.minSavingPerUnit ?? 1 });
      if (suggestion) consolidation.push(suggestion);
    }
  }

  return {
    id: [...new Set(sorted.map((item) => item.productId))].join("+"),
    confidence: reasons.length > 1 ? "high" : "medium",
    reasons,
    items: sorted.map(
      (item): DuplicateItem => ({
        lineId: item.lineId,
        productId: item.productId,
        name: item.name,
        unitQuantity: item.unitQuantity,
        quantity: item.quantity,
        linePrice: item.linePrice,
        basePrice: item.basePrice,
      }),
    ),
    cheapestProductId: spread === null ? null : cheapest.productId,
    basePriceSpread: spread === null ? null : { unit: cheapest.basePrice!.unit, price: spread },
    consolidation,
    potentialSaving: consolidation.reduce((sum, suggestion) => sum - suggestion.linePriceDelta, 0),
  };
}

/** The cheapest product of a group as a candidate, priced from its product page when there is one. */
function consolidationTarget(item: CartItem, product: ProductInfo | undefined): AlternativeCandidate {
  return {
    productId: item.productId,
    name: item.name,
    unitQuantity: item.unitQuantity,
    unitPrice: product?.unitPrice ?? item.unitPrice,
    priceTiers: product?.priceTiers ?? item.priceTiers,
    maxCount: product?.maxCount,
    imageId: item.imageId,
    source: "duplicate",
  };
}
