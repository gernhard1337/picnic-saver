import { quantityInCart } from "./cart.js";
import { buildSuggestion } from "./suggestion.js";
import type { CartItem, SavingsPlan, SwapSuggestion } from "./types.js";

export interface SelectSwapsOptions {
  /** Also take suggestions from the `"search"` source, which can be another kind of product. Default: false. */
  includeSearch?: boolean;
  /** Also take the suggestions that merge duplicates (`DuplicateGroup.consolidation`). Default: false. */
  includeMerges?: boolean;
}

/**
 * Picks the suggestions for "swap everything": the cheapest allowed suggestion of every cart
 * line, in an order and combination that {@link PicnicSaver.applySwaps} can apply in one go.
 *
 * A line is never moved onto a product that is swapped away itself; it goes where that product
 * goes. With three sizes of the same potatoes in the cart, the two more expensive ones both end
 * up on the cheapest instead of one on the other. Such a redirected suggestion is built here and
 * is not part of the plan.
 */
export function selectSwaps(plan: SavingsPlan, options: SelectSwapsOptions = {}): SwapSuggestion[] {
  const merges = options.includeMerges ? plan.duplicates.flatMap((group) => group.consolidation) : [];
  const lines = plan.lines
    .map((line) => ({
      item: line.item,
      options: [...line.suggestions, ...merges.filter((merge) => merge.from.lineId === line.item.lineId)]
        .filter((suggestion) => options.includeSearch || suggestion.source !== "search")
        .sort((a, b) => a.to.basePrice.price - b.to.basePrice.price),
    }))
    .filter((line) => line.options.length > 0);

  // A target costs less per unit than the line it replaces, so going from the cheapest line up,
  // it is known for every target whether it stays in the cart, and if not, where it goes.
  const destination = new Map<string, SwapSuggestion>();
  const chosen = new Map<string, SwapSuggestion>();
  for (const { item, options: candidates } of [...lines].sort((a, b) => (a.item.basePrice?.price ?? 0) - (b.item.basePrice?.price ?? 0))) {
    for (const candidate of candidates) {
      const onward = destination.get(candidate.to.productId);
      const choice = onward ? redirect(item, onward, quantityInCart(plan.cart, onward.to.productId)) : candidate;
      if (!choice || destination.has(choice.to.productId)) continue;
      chosen.set(item.lineId, choice);
      destination.set(item.productId, choice);
      break;
    }
  }
  return lines.flatMap((line) => chosen.get(line.item.lineId) ?? []).filter((suggestion) => !destination.has(suggestion.to.productId));
}

/** The suggestion to move `item` straight to where `onward` goes, or null when that isn't cheaper for it. */
function redirect(item: CartItem, onward: SwapSuggestion, inCart: number): SwapSuggestion | null {
  const { to } = onward;
  const candidate = { productId: to.productId, name: to.name, unitQuantity: to.unitQuantity, unitPrice: Math.round(to.linePrice / to.quantity), imageId: to.imageId, source: onward.source };
  return buildSuggestion({ kind: "alternative", item, candidate, quantityInCart: inCart, minSavingPerUnit: 1 });
}
