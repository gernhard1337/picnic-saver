// Adds your own source of alternatives: the own-brand version of each product, found by search.
// A source only proposes products; the library decides whether they cost less per unit.
// Run: npx tsx --env-file=.env examples/custom-source.ts
import type { AlternativeSource } from "../src/index.js";
import { createSaver, euro } from "./_saver.js";

const OWN_BRAND = "Gut&Günstig";

const ownBrand: AlternativeSource = {
  name: "own-brand",
  async find({ item, product, client }) {
    const results = await client.catalog.getSearchResults(`${OWN_BRAND} ${product?.name ?? item.name}`);
    const tiles = (results.products?.sections ?? []).flatMap((section) => section.products);
    return tiles
      .filter((tile) => tile.brand === OWN_BRAND && !tile.isUnavailable)
      .map((tile) => ({ productId: tile.id, name: `${tile.brand} ${tile.name}`, unitQuantity: tile.unitQuantity, unitPrice: tile.displayPrice, imageId: tile.imageId, source: "own-brand" }));
  },
};

const saver = createSaver();
// Sources are asked in this order; "search" is left out here to save requests.
const plan = await saver.findSavings({ sources: ["similar", ownBrand] });

for (const suggestion of plan.suggestions.filter((candidate) => candidate.source === "own-brand")) {
  console.log(`${suggestion.from.name} → ${suggestion.to.name}: ${euro(suggestion.savingPerUnit)}/${suggestion.to.basePrice.unit} cheaper`);
}
