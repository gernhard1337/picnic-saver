// Shows the savings for the cart of the account in PICNIC_AUTH_KEY, without changing the cart.
// Run: PICNIC_AUTH_KEY=... npx tsx examples/basic.ts
import { PicnicSaver, previewSwaps } from "../src/index.js";

const saver = new PicnicSaver({ countryCode: "DE", authKey: process.env.PICNIC_AUTH_KEY });

const cart = await saver.getCart();
console.log(`Cart: ${cart.items.length} lines, €${(cart.totalPrice / 100).toFixed(2)}`);

const plan = await saver.findSavings();
for (const group of plan.duplicates) {
  console.log(`Duplicate: ${group.items.map((item) => item.name).join(" / ")}`);
}
for (const suggestion of plan.suggestions) {
  console.log(`${suggestion.from.name} → ${suggestion.to.name}: ${suggestion.linePriceDelta} cents (${suggestion.source})`);
}

// Only the suggestions that make the cart cheaper and don't come from search.
const selected = plan.suggestions.filter((suggestion) => suggestion.source !== "search" && suggestion.linePriceDelta < 0);
const preview = previewSwaps(
  plan,
  selected.map((suggestion) => suggestion.id),
);
console.log(`Estimated total: €${(preview.estimatedTotal / 100).toFixed(2)}`);

// To change the cart:
// const result = await saver.applySwaps(selected);
