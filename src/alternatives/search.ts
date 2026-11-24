import { toPriceTiers } from "../cart.js";
import { nameOverlap } from "../names.js";
import type { AlternativeCandidate } from "../types.js";
import type { AlternativeContext, AlternativeSource } from "./source.js";

export interface SearchSourceOptions {
  /**
   * The share of words the name of the item and the name of a search result must have in common,
   * from 0 to 1, measured both ways. Keeps "Hafermilch" and "Kartoffelbrei mit Blattspinat" out
   * of the results for "Vollmilch" and "Blattspinat". Default: 0.5.
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
  // Several cart lines often share a name; each name is searched once.
  const searches = new Map<string, ReturnType<AlternativeContext["client"]["catalog"]["getSearchResults"]>>();
  return {
    name: "search",
    async find({ item, product, client }) {
      const query = product?.name ?? item.name;
      if (!searches.has(query)) searches.set(query, client.catalog.getSearchResults(query));
      const results = await searches.get(query)!;
      const candidates = new Map<string, AlternativeCandidate>();
      for (const section of results.products?.sections ?? []) {
        for (const tile of section.products) {
          if (tile.isUnavailable || tile.id === item.productId || candidates.has(tile.id)) continue;
          if (Math.min(nameOverlap(query, tile.name), nameOverlap(tile.name, query)) < minNameOverlap) continue;
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
