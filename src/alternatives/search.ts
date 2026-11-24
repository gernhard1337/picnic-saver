import { toPriceTiers } from "../cart.js";
import { nameOverlap } from "../names.js";
import type { AlternativeCandidate } from "../types.js";
import type { AlternativeSource } from "./source.js";

export interface SearchSourceOptions {
  /**
   * The share of the words in the item's name a search result must have in its own name, from 0
   * to 1. Keeps "Hafermilch" out of the results for "Vollmilch". Default: 0.5.
   */
  minNameOverlap?: number;
  /** The most candidates to return per item. Default: 10. */
  maxCandidates?: number;
}

/**
 * Search results for the name of the cart item. Finds products Picnic doesn't list as similar,
 * but a search also returns products of another kind, so treat these suggestions as less
 * reliable. Costs one or two extra requests per cart item.
 */
export function searchSource(options: SearchSourceOptions = {}): AlternativeSource {
  const minNameOverlap = options.minNameOverlap ?? 0.5;
  const maxCandidates = options.maxCandidates ?? 10;
  return {
    name: "search",
    async find({ item, product, client }) {
      const query = product?.name ?? item.name;
      const results = await client.catalog.getSearchResults(query);
      const candidates = new Map<string, AlternativeCandidate>();
      for (const section of results.products?.sections ?? []) {
        for (const tile of section.products) {
          if (tile.isUnavailable || tile.id === item.productId || candidates.has(tile.id)) continue;
          if (nameOverlap(query, tile.name) < minNameOverlap) continue;
          candidates.set(tile.id, {
            productId: tile.id,
            name: tile.brand ? `${tile.brand} ${tile.name}` : tile.name,
            unitQuantity: tile.unitQuantity,
            unitPrice: tile.displayPrice,
            priceTiers: toPriceTiers(tile.priceRanges),
            imageId: tile.imageId,
            source: "search",
          });
        }
      }
      return [...candidates.values()].slice(0, maxCandidates);
    },
  };
}
