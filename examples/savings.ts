// Shows the cart, the duplicates and the cheapest alternative per line. Changes nothing.
// Run: npx tsx --env-file=.env examples/savings.ts
import { createSaver, euro } from "./_saver.js";

const saver = createSaver();

const cart = await saver.getCart();
console.log(`Cart: ${cart.items.length} lines, ${euro(cart.totalPrice)}\n`);

const plan = await saver.findSavings();

for (const group of plan.duplicates) {
  console.log(`Duplicate: ${group.items.map((item) => `${item.name} (${item.unitQuantity})`).join(" / ")}`);
}
for (const suggestion of plan.suggestions) {
  const { from, to } = suggestion;
  const effect = suggestion.increasesLinePrice ? `costs ${euro(suggestion.linePriceDelta)} more` : `saves ${euro(-suggestion.linePriceDelta)}`;
  console.log(`${from.quantity} × ${from.name} → ${to.quantity} × ${to.name}: ${effect} [${suggestion.source}]`);
}

console.log(`\nEstimated total: ${euro(plan.summary.estimatedTotal)} (now ${euro(plan.summary.currentTotal)})`);
for (const warning of plan.warnings) console.warn(`Warning: ${warning}`);
