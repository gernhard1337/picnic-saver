import { toCartSummary } from "./cart.js";
import { StaleSuggestionError, SwapFailedError } from "./errors.js";
import type { CartSummary, PicnicClientLike, SwapOutcome, SwapResult, SwapSuggestion, SwapsResult } from "./types.js";

function quantityOf(cart: CartSummary, productId: string, recipeId?: string | null): number {
  return cart.items.filter((item) => item.productId === productId && (recipeId === undefined || item.recipeId === recipeId)).reduce((sum, item) => sum + item.quantity, 0);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Applies one suggestion to the cart. Picnic has no swap, so the new product is added first and
 * the old one removed after: if the second step fails the cart has both rather than neither, and
 * the added product is taken out again.
 *
 * The cart is read first. When the line the suggestion replaces is gone or has another quantity,
 * nothing is changed and a {@link StaleSuggestionError} is thrown; other lines may have changed.
 */
export async function applySwap(client: PicnicClientLike, suggestion: SwapSuggestion): Promise<SwapResult> {
  const { from, to } = suggestion;
  const before = toCartSummary(await client.cart.getCart());
  const present = quantityOf(before, from.productId, from.recipeId);
  if (present !== from.quantity) {
    const found = present === 0 ? "is no longer in the cart" : `is in the cart ${present} times, not ${from.quantity}`;
    throw new StaleSuggestionError(suggestion.id, `"${from.name}" ${found}. Run the analysis again.`);
  }

  const expected = quantityOf(before, to.productId) + to.quantity;
  let added: CartSummary;
  try {
    added = toCartSummary(await client.cart.addProductToCart(to.productId, to.quantity));
  } catch (error) {
    throw new SwapFailedError(suggestion.id, "add", true, `Could not add "${to.name}": ${describe(error)}`, { cause: error });
  }

  const inCart = quantityOf(added, to.productId);
  if (inCart !== expected) {
    const surplus = inCart - (expected - to.quantity);
    const rolledBack = surplus <= 0 || (await undo(client, to.productId, surplus));
    throw new SwapFailedError(suggestion.id, "add", rolledBack, `Picnic put ${Math.max(surplus, 0)} of ${to.quantity} "${to.name}" in the cart.`);
  }

  let after: CartSummary;
  try {
    after = toCartSummary(await client.cart.removeProductFromCart(from.productId, from.quantity));
  } catch (error) {
    const rolledBack = await undo(client, to.productId, to.quantity);
    throw new SwapFailedError(suggestion.id, "remove", rolledBack, `Could not remove "${from.name}": ${describe(error)}`, { cause: error });
  }

  return {
    suggestionId: suggestion.id,
    cart: after,
    previousTotal: before.totalPrice,
    newTotal: after.totalPrice,
    actualSaving: before.totalPrice - after.totalPrice,
  };
}

async function undo(client: PicnicClientLike, productId: string, quantity: number): Promise<boolean> {
  try {
    await client.cart.removeProductFromCart(productId, quantity);
    return true;
  } catch {
    return false;
  }
}

export interface ApplySwapsOptions {
  /** Stop at the first suggestion that fails instead of going on with the rest. Default: false. */
  stopOnError?: boolean;
}

/**
 * Applies suggestions one after another and reports the outcome of each. A stale suggestion is
 * `"skipped"`, one Picnic rejected is `"failed"`; neither throws.
 */
export async function applySwaps(client: PicnicClientLike, suggestions: SwapSuggestion[], options: ApplySwapsOptions = {}): Promise<SwapsResult> {
  const outcomes: SwapOutcome[] = [];
  let previousTotal: number | null = null;
  let cart: CartSummary | null = null;

  for (const suggestion of suggestions) {
    try {
      const result = await applySwap(client, suggestion);
      previousTotal ??= result.previousTotal;
      cart = result.cart;
      outcomes.push({ suggestionId: suggestion.id, status: "applied" });
    } catch (error) {
      if (error instanceof StaleSuggestionError) {
        outcomes.push({ suggestionId: suggestion.id, status: "skipped", reason: error.message });
        continue;
      }
      if (!(error instanceof SwapFailedError)) throw error;
      // A failed swap can leave the cart changed, so the last known cart is no longer right.
      cart = null;
      outcomes.push({ suggestionId: suggestion.id, status: "failed", reason: error.message });
      if (options.stopOnError) break;
    }
  }

  cart ??= toCartSummary(await client.cart.getCart());
  previousTotal ??= cart.totalPrice;
  return { outcomes, cart, previousTotal, newTotal: cart.totalPrice, actualSaving: previousTotal - cart.totalPrice };
}
