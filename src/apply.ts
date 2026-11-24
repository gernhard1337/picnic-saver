import { quantityInCart, toCartSummary } from "./cart.js";
import { errorMessage, StaleSuggestionError, SwapFailedError } from "./errors.js";
import type { IgnoreRule } from "./ignore.js";
import type { CartSummary, PicnicClientLike, RemoveIgnoredResult, SwapOutcome, SwapResult, SwapSuggestion, SwapsResult } from "./types.js";

/**
 * Applies one suggestion to the cart. Picnic has no swap, so the new product is added first and
 * the old one removed after: if the second step fails the cart has both rather than neither, and
 * the added product is taken out again.
 *
 * The cart is read first. When the line the suggestion replaces is gone or has another quantity,
 * nothing is changed and a {@link StaleSuggestionError} is thrown; other lines may have changed.
 */
export async function applySwap(client: PicnicClientLike, suggestion: SwapSuggestion, options: { ignore?: IgnoreRule[] } = {}): Promise<SwapResult> {
  const { from, to } = suggestion;
  const before = toCartSummary(await client.cart.getCart(), options.ignore);
  const present = quantityInCart(before, from.productId, from.recipeId);
  if (present !== from.quantity) {
    const found = present === 0 ? "is no longer in the cart" : `is in the cart ${present} times, not ${from.quantity}`;
    throw new StaleSuggestionError(suggestion.id, `"${from.name}" ${found}. Run the analysis again.`);
  }

  const expected = quantityInCart(before, to.productId) + to.quantity;
  let added: CartSummary;
  try {
    added = toCartSummary(await client.cart.addProductToCart(to.productId, to.quantity));
  } catch (error) {
    throw new SwapFailedError(suggestion.id, "add", true, `Could not add "${to.name}": ${errorMessage(error)}`, { cause: error });
  }

  const inCart = quantityInCart(added, to.productId);
  if (inCart !== expected) {
    const surplus = inCart - (expected - to.quantity);
    const rolledBack = surplus <= 0 || (await undo(client, to.productId, surplus));
    throw new SwapFailedError(suggestion.id, "add", rolledBack, `Picnic put ${Math.max(surplus, 0)} of ${to.quantity} "${to.name}" in the cart.`);
  }

  let after: CartSummary;
  try {
    after = toCartSummary(await client.cart.removeProductFromCart(from.productId, from.quantity), options.ignore);
  } catch (error) {
    const rolledBack = await undo(client, to.productId, to.quantity);
    throw new SwapFailedError(suggestion.id, "remove", rolledBack, `Could not remove "${from.name}": ${errorMessage(error)}`, { cause: error });
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
  /** The ignore list, to flag ignored lines in the returned cart. */
  ignore?: IgnoreRule[];
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
      const result = await applySwap(client, suggestion, options);
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

  cart ??= toCartSummary(await client.cart.getCart(), options.ignore);
  previousTotal ??= cart.totalPrice;
  return { outcomes, cart, previousTotal, newTotal: cart.totalPrice, actualSaving: previousTotal - cart.totalPrice };
}

/**
 * Takes every cart line that is on the ignore list out of the cart, whatever its quantity and
 * also when it belongs to a recipe. A line Picnic refuses to remove ends up in `failed`.
 */
export async function removeIgnored(client: PicnicClientLike, ignore: IgnoreRule[]): Promise<RemoveIgnoredResult> {
  const before = toCartSummary(await client.cart.getCart(), ignore);
  const result: RemoveIgnoredResult = { removed: [], failed: [], cart: before, previousTotal: before.totalPrice, newTotal: before.totalPrice };

  for (const item of before.items.filter((candidate) => candidate.ignored)) {
    try {
      result.cart = toCartSummary(await client.cart.removeProductFromCart(item.productId, item.quantity), ignore);
      result.removed.push(item);
    } catch (error) {
      result.failed.push({ item, reason: errorMessage(error) });
    }
  }
  result.newTotal = result.cart.totalPrice;
  return result;
}
