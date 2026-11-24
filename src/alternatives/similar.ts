import { toPriceTiers } from "../cart.js";
import type { AlternativeSource } from "./source.js";

/**
 * The similar products Picnic lists on the product page. Costs no extra request, because the
 * product page is read for every cart item anyway.
 */
export function similarProductsSource(): AlternativeSource {
  return {
    name: "similar",
    async find({ product }) {
      return (product?.similarProducts ?? []).map((similar) => ({
        productId: similar.id,
        name: similar.name,
        unitQuantity: similar.unitQuantity,
        unitPrice: similar.displayPrice,
        priceTiers: toPriceTiers(similar.priceRanges),
        maxCount: similar.maxCount,
        imageId: similar.imageId,
        source: "similar",
      }));
    },
  };
}
