import type PicnicClient from "picnic-api";
import { matchIgnoreRule, type IgnoreRule } from "./ignore.js";
import { parsePackageSize } from "./package-size.js";
import { basePriceOf } from "./pricing.js";
import type { CartItem, CartSummary, PriceTier } from "./types.js";

type PicnicCart = PicnicClient.Types.cart.Cart;
type PicnicPriceRange = PicnicClient.Types.fusion.PriceRange;

/** Converts picnic-api's price ranges into {@link PriceTier}s. */
export function toPriceTiers(ranges: PicnicPriceRange[] | null | undefined): PriceTier[] {
  return (ranges ?? []).map((range) => ({ price: range.price, fromQuantity: range.from_quantity }));
}

/**
 * The number of packages per cart line.
 *
 * picnic-api reports the total of a product on every line of that product: a product that is in
 * the cart once and in a recipe twice shows a quantity of 3 on both lines. The line prices are
 * right, so the total is split over the lines by their prices. Carts whose quantities already
 * add up to the cart's count are left as they are.
 */
function lineQuantities(cart: PicnicCart): Map<string, number> {
  const lines = cart.items.filter((line) => line.quantity > 0);
  const quantities = new Map(lines.map((line) => [line.id, line.quantity]));
  if (lines.reduce((sum, line) => sum + line.quantity, 0) === cart.totalCount) return quantities;

  const byProduct = new Map<string, typeof lines>();
  for (const line of lines) byProduct.set(line.productId, [...(byProduct.get(line.productId) ?? []), line]);
  for (const group of byProduct.values()) {
    const total = group[0]!.quantity;
    if (group.length < 2 || total < group.length || group.some((line) => line.quantity !== total)) continue;
    const weights = group.map((line) => line.originalPrice ?? line.displayPrice);
    const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
    const shares = weights.map((weight) => (weightSum > 0 ? (total * weight) / weightSum : total / group.length));
    const split = shares.map((share) => Math.max(1, Math.floor(share + 1e-9)));
    // Hand out what rounding down left over, largest remainder first.
    const order = shares.map((share, index) => [share - Math.floor(share + 1e-9), index] as const).sort((a, b) => b[0] - a[0]);
    for (let left = total - split.reduce((sum, quantity) => sum + quantity, 0), i = 0; left > 0; left--, i++) split[order[i % order.length]![1]]!++;
    group.forEach((line, index) => quantities.set(line.id, split[index]!));
  }
  return quantities;
}

/**
 * Converts a picnic-api cart into a {@link CartSummary}. Lines with a quantity of 0 are left out.
 * @param cart The cart from picnic-api.
 * @param ignore The ignore list; matching lines get `ignored: true`.
 */
export function toCartSummary(cart: PicnicCart, ignore: IgnoreRule[] = []): CartSummary {
  const quantities = lineQuantities(cart);
  const items = cart.items
    .filter((line) => line.quantity > 0)
    .map((line): CartItem => {
      const packageSize = parsePackageSize(line.unitQuantity);
      const quantity = quantities.get(line.id) ?? line.quantity;
      return {
        lineId: line.id,
        productId: line.productId,
        name: line.name,
        unitQuantity: line.unitQuantity,
        quantity,
        linePrice: line.displayPrice,
        unitPrice: Math.round(line.displayPrice / quantity),
        packageSize,
        basePrice: packageSize && line.displayPrice > 0 ? basePriceOf(line.displayPrice, quantity, packageSize) : null,
        priceTiers: toPriceTiers(line.priceRanges),
        imageId: line.imageId,
        isUnavailable: line.isUnavailable,
        recipeId: line.recipeId,
        ignored: matchIgnoreRule({ productId: line.productId, name: line.name }, ignore) !== null,
      };
    });
  return {
    id: cart.id,
    items,
    totalCount: cart.totalCount,
    totalPrice: cart.totalPrice,
    itemsTotal: items.reduce((sum, item) => sum + item.linePrice, 0),
  };
}
