import { parsePackageSize } from "./package-size.js";
import { basePriceOf, coveringQuantity, lineCost } from "./pricing.js";
import type { AlternativeCandidate, CartItem, SwapSuggestion } from "./types.js";

export interface SuggestionInput {
  kind: SwapSuggestion["kind"];
  item: CartItem;
  candidate: AlternativeCandidate;
  /** How many packages of the candidate are in the cart already. */
  quantityInCart: number;
  /** The least the candidate must cost less per unit, in cents. */
  minSavingPerUnit: number;
}

/**
 * Builds the suggestion to replace `item` by `candidate`, or returns null when the candidate
 * can't be compared (no size, another unit), doesn't cost less per unit, or the cart wouldn't
 * accept the quantity.
 */
export function buildSuggestion({ kind, item, candidate, quantityInCart, minSavingPerUnit }: SuggestionInput): SwapSuggestion | null {
  if (!item.packageSize || !item.basePrice || candidate.productId === item.productId) return null;
  const size = parsePackageSize(candidate.unitQuantity);
  if (!size || size.unit !== item.packageSize.unit || candidate.unitPrice <= 0) return null;

  const quantity = coveringQuantity(item.quantity * item.packageSize.amount, size.amount);
  if (quantityInCart + quantity > (candidate.maxCount ?? 99)) return null;

  // With quantity discounts the packages already in the cart get cheaper too.
  const cost = lineCost(candidate.unitPrice, candidate.priceTiers, quantityInCart + quantity) - lineCost(candidate.unitPrice, candidate.priceTiers, quantityInCart);
  if (cost <= 0) return null;

  const basePrice = basePriceOf(cost, quantity, size);
  const savingPerUnit = item.basePrice.price - basePrice.price;
  if (savingPerUnit < minSavingPerUnit) return null;

  const linePriceDelta = cost - item.linePrice;
  return {
    id: `${item.productId}:${candidate.productId}`,
    kind,
    source: candidate.source,
    from: {
      lineId: item.lineId,
      productId: item.productId,
      name: item.name,
      unitQuantity: item.unitQuantity,
      quantity: item.quantity,
      linePrice: item.linePrice,
      basePrice: item.basePrice,
      recipeId: item.recipeId,
    },
    to: {
      productId: candidate.productId,
      name: candidate.name,
      unitQuantity: candidate.unitQuantity,
      quantity,
      linePrice: cost,
      basePrice,
      imageId: candidate.imageId ?? null,
      alreadyInCart: quantityInCart > 0,
    },
    savingPerUnit,
    linePriceDelta,
    increasesLinePrice: linePriceDelta > 0,
  };
}

/** Orders suggestions by price per unit, then by what the line would cost. */
export function byCheapest(a: SwapSuggestion, b: SwapSuggestion): number {
  return a.to.basePrice.price - b.to.basePrice.price || a.to.linePrice - b.to.linePrice;
}
