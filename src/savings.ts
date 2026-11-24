import { findDuplicates } from "./duplicates.js";
import { InvalidSelectionError } from "./errors.js";
import { buildSuggestion, byCheapest } from "./suggestion.js";
import type { AlternativeCandidate, CartItem, CartSummary, LineSavings, ProductInfo, SavingsPlan, SkipReason, SwapPreview, SwapSuggestion } from "./types.js";

export interface PlanOptions {
  /** The least an alternative must cost less per kilogram, litre or piece, in cents. Default: 1. */
  minSavingPerUnit?: number;
  /** The most suggestions to keep per cart line. Default: 5. */
  maxSuggestionsPerLine?: number;
  /** The most suggestions from the `"search"` source to keep per cart line. Default: 3. */
  maxSearchSuggestionsPerLine?: number;
  /**
   * Also suggest swaps for lines that belong to a recipe. Swapping such a line takes the product
   * out of the recipe in the cart. Set to false to leave recipes as they are. Default: true.
   */
  includeRecipeItems?: boolean;
}

export interface PlanInput {
  cart: CartSummary;
  /** The candidates per cart line id, in order of preference when a product occurs twice. */
  candidates: Record<string, AlternativeCandidate[]>;
  /** The product pages of the cart's products by product id, used to find duplicates. */
  products?: Record<string, ProductInfo>;
  warnings?: string[];
  options?: PlanOptions;
}

/** Why a cart line gets no suggestions, or null when it can be compared. */
export function skipReason(item: CartItem, options: PlanOptions = {}): SkipReason | null {
  if (item.ignored) return "ignored";
  if (item.isUnavailable) return "unavailable";
  if (item.recipeId && options.includeRecipeItems === false) return "recipe";
  if (!item.basePrice) return "no-comparable-size";
  return null;
}

/**
 * Turns a cart and the candidates of its lines into a {@link SavingsPlan}. A pure function:
 * {@link PicnicSaver.findSavings} collects the input from Picnic and calls this.
 *
 * A candidate becomes a suggestion when it costs less per kilogram, litre or piece than what is
 * paid for the cart line now. Its quantity is the fewest packages that hold at least the amount
 * of the line. A cheaper product that is in the cart already is suggested too, with
 * `to.alreadyInCart: true`; applying it raises the quantity of that line.
 */
export function buildSavingsPlan({ cart, candidates, products = {}, warnings = [], options = {} }: PlanInput): SavingsPlan {
  const inCart = new Map<string, number>();
  for (const item of cart.items) inCart.set(item.productId, (inCart.get(item.productId) ?? 0) + item.quantity);
  const usedIds = new Set<string>();
  const uniqueId = (suggestion: SwapSuggestion): SwapSuggestion => {
    let id = suggestion.id;
    for (let n = 2; usedIds.has(id); n++) id = `${suggestion.id}#${n}`;
    usedIds.add(id);
    return { ...suggestion, id };
  };

  const lines = cart.items.map((item): LineSavings => {
    const skipped = skipReason(item, options);
    if (skipped) return { item, skipped, suggestions: [], recommended: null };

    const seen = new Set<string>();
    let searchCount = 0;
    const suggestions = (candidates[item.lineId] ?? [])
      .filter((candidate) => !seen.has(candidate.productId) && seen.add(candidate.productId))
      .flatMap((candidate) => buildSuggestion({ kind: "alternative", item, candidate, quantityInCart: inCart.get(candidate.productId) ?? 0, minSavingPerUnit: options.minSavingPerUnit ?? 1 }) ?? [])
      .sort(byCheapest)
      .filter((suggestion) => suggestion.source !== "search" || ++searchCount <= (options.maxSearchSuggestionsPerLine ?? 3))
      .slice(0, options.maxSuggestionsPerLine ?? 5)
      .map(uniqueId);

    return { item, skipped: null, suggestions, recommended: suggestions[0] ?? null };
  });

  const duplicates = findDuplicates(cart, products, options).map((group) => ({ ...group, consolidation: group.consolidation.map(uniqueId) }));
  const suggestions = lines.flatMap((line) => line.recommended ?? []);
  const plan: SavingsPlan = {
    createdAt: new Date().toISOString(),
    cart,
    lines,
    suggestions,
    duplicates,
    ignored: cart.items.filter((item) => item.ignored),
    summary: { suggestionIds: [], currentTotal: cart.totalPrice, estimatedTotal: cart.totalPrice, estimatedSaving: 0 },
    warnings,
  };
  plan.summary = previewSwaps(plan);
  return plan;
}

/** All suggestions of a plan: the ones per line and the consolidation of duplicates. */
export function allSuggestions(plan: SavingsPlan): SwapSuggestion[] {
  return [...plan.lines.flatMap((line) => line.suggestions), ...plan.duplicates.flatMap((group) => group.consolidation)];
}

/** Returns the suggestion with this id, or undefined. */
export function findSuggestion(plan: SavingsPlan, id: string): SwapSuggestion | undefined {
  return allSuggestions(plan).find((suggestion) => suggestion.id === id);
}

/**
 * Computes the cart total after a set of suggestions, without touching the cart.
 *
 * @param plan The plan the suggestions come from.
 * @param suggestionIds The suggestions to apply. Default: the recommended one of every line.
 * @throws {InvalidSelectionError} For an unknown id, or two suggestions for the same cart line.
 */
export function previewSwaps(plan: SavingsPlan, suggestionIds: string[] = plan.suggestions.map((suggestion) => suggestion.id)): SwapPreview {
  const lines = new Set<string>();
  let delta = 0;
  for (const id of suggestionIds) {
    const suggestion = findSuggestion(plan, id);
    if (!suggestion) throw new InvalidSelectionError(`Unknown suggestion "${id}".`);
    if (lines.has(suggestion.from.lineId)) throw new InvalidSelectionError(`More than one suggestion selected for "${suggestion.from.name}".`);
    lines.add(suggestion.from.lineId);
    delta += suggestion.linePriceDelta;
  }
  return {
    suggestionIds: [...suggestionIds],
    currentTotal: plan.cart.totalPrice,
    estimatedTotal: plan.cart.totalPrice + delta,
    estimatedSaving: delta === 0 ? 0 : -delta,
  };
}
