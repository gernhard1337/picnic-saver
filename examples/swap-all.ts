// Swaps every line for its cheapest alternative. Without --apply it only shows what it would do.
// Run: npx tsx --env-file=.env examples/swap-all.ts [--apply]
import { previewSwaps, selectSwaps } from "../src/index.js";
import { createSaver, euro } from "./_saver.js";

const saver = createSaver();
const plan = await saver.findSavings();

// selectSwaps picks one suggestion per line that can be applied together. Here: no search
// results, and only swaps that make the line cheaper.
const selected = selectSwaps(plan, { includeSearch: false }).filter((suggestion) => suggestion.linePriceDelta < 0);

const preview = previewSwaps(plan, selected);
for (const suggestion of selected) console.log(`${suggestion.from.name} → ${suggestion.to.name}`);
console.log(`Estimated: ${euro(preview.currentTotal)} → ${euro(preview.estimatedTotal)}`);

if (process.argv.includes("--apply")) {
  const result = await saver.applySwaps(selected);
  for (const outcome of result.outcomes) console.log(outcome.suggestionId, outcome.status, "reason" in outcome ? outcome.reason : "");
  console.log(`Real total: ${euro(result.previousTotal)} → ${euro(result.newTotal)}`);
} else {
  console.log("Nothing changed. Add --apply to swap.");
}
