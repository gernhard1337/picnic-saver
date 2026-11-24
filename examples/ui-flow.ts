// How a UI uses the library: make the plan in one request, keep it as JSON, and apply single
// suggestions later, one per click.
// Run: npx tsx --env-file=.env examples/ui-flow.ts plan
//      npx tsx --env-file=.env examples/ui-flow.ts apply <suggestion id>
import { readFile, writeFile } from "node:fs/promises";
import { findSuggestion, StaleSuggestionError, SwapFailedError, type SavingsPlan } from "../src/index.js";
import { createSaver, euro } from "./_saver.js";

const PLAN_FILE = "plan.example.json";
const [command, id] = process.argv.slice(2);
const saver = createSaver();

if (command === "plan") {
  // The plan is plain JSON: send it to the browser, store it in a session, or as here in a file.
  const plan = await saver.findSavings();
  await writeFile(PLAN_FILE, JSON.stringify(plan, null, 2));
  for (const line of plan.lines) {
    for (const suggestion of line.suggestions) console.log(`${suggestion.id}  ${suggestion.from.name} → ${suggestion.to.name}`);
  }
  console.log(`\nSaved to ${PLAN_FILE}. Apply one with: ui-flow.ts apply <id>`);
} else if (command === "apply" && id) {
  const plan = JSON.parse(await readFile(PLAN_FILE, "utf8")) as SavingsPlan;
  const suggestion = findSuggestion(plan, id);
  if (!suggestion) throw new Error(`No suggestion ${id} in ${PLAN_FILE}`);

  try {
    // Checks only this suggestion's own cart line, so earlier clicks don't invalidate it.
    const result = await saver.applySwap(suggestion);
    console.log(`Swapped. Total: ${euro(result.previousTotal)} → ${euro(result.newTotal)}`);
  } catch (error) {
    if (error instanceof StaleSuggestionError) console.log(`Out of date, make a new plan: ${error.message}`);
    else if (error instanceof SwapFailedError) console.log(`Failed at "${error.stage}", cart restored: ${error.rolledBack}. ${error.message}`);
    else throw error;
  }
} else {
  console.log("Usage: ui-flow.ts plan | apply <suggestion id>");
}
