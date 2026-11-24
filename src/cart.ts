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
 * Converts a picnic-api cart into a {@link CartSummary}. Lines with a quantity of 0 are left out.
 * @param cart The cart from picnic-api.
 * @param ignore The ignore list; matching lines get `ignored: true`.
 */
export function toCartSummary(cart: PicnicCart, ignore: IgnoreRule[] = []): CartSummary {
  const items = cart.items
    .filter((line) => line.quantity > 0)
    .map((line): CartItem => {
      const packageSize = parsePackageSize(line.unitQuantity);
      return {
        lineId: line.id,
        productId: line.productId,
        name: line.name,
        unitQuantity: line.unitQuantity,
        quantity: line.quantity,
        linePrice: line.displayPrice,
        unitPrice: Math.round(line.displayPrice / line.quantity),
        packageSize,
        basePrice: packageSize && line.displayPrice > 0 ? basePriceOf(line.displayPrice, line.quantity, packageSize) : null,
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
