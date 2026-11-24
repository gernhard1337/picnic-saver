import type PicnicClient from "picnic-api";
import type { AlternativeCandidate, CartItem, PicnicClientLike } from "../types.js";

/** What an {@link AlternativeSource} gets to work with. */
export interface AlternativeContext {
  /** The cart line to find alternatives for. */
  item: CartItem;
  /** The product page of the item, or null when it couldn't be read. */
  product: PicnicClient.Types.catalog.Product | null;
  client: PicnicClientLike;
}

/**
 * Finds products that could replace a cart item. A source only proposes candidates; whether one
 * costs less per unit is decided afterwards, so a source doesn't need to compare prices.
 *
 * Implement this to add your own source, e.g. a list of preferred own-brand products, and pass it
 * in `findSavings({ sources: ["similar", mySource] })`.
 */
export interface AlternativeSource {
  /** Ends up as `source` on the suggestions. */
  readonly name: string;
  find(context: AlternativeContext): Promise<AlternativeCandidate[]>;
}
