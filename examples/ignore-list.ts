// Flags the products you never want and removes them. Without --apply it only lists them.
// Run: npx tsx --env-file=.env examples/ignore-list.ts [--apply]
import { existsSync, readFileSync } from "node:fs";
import { parseIgnoreList, type IgnoreRule } from "../src/index.js";
import { createSaver, euro } from "./_saver.js";

// The list of the CLI when there is one, otherwise a list in code.
const file = "picnic-saver.ignore.json";
const ignore: IgnoreRule[] = existsSync(file) ? parseIgnoreList(JSON.parse(readFileSync(file, "utf8"))) : ["Petersilie", { productId: "s1001524" }];

const saver = createSaver(ignore);

const cart = await saver.getCart();
const ignored = cart.items.filter((item) => item.ignored);
for (const item of ignored) console.log(`${item.quantity} × ${item.name}  ${euro(item.linePrice)}${item.recipeId ? "  (from a recipe)" : ""}`);
if (ignored.length === 0) console.log("Nothing on the ignore list is in the cart.");

if (process.argv.includes("--apply")) {
  const result = await saver.removeIgnored();
  console.log(`Removed ${result.removed.length}, failed ${result.failed.length}. Total: ${euro(result.previousTotal)} → ${euro(result.newTotal)}`);
}
