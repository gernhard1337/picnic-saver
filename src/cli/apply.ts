import { select } from "@inquirer/prompts";
import { PicnicSaverError, StaleSuggestionError, SwapFailedError } from "../errors.js";
import { findSuggestion, previewSwaps } from "../savings.js";
import type { FindSavingsOptions, PicnicSaver } from "../saver.js";
import type { RemoveIgnoredResult, SavingsPlan, SwapOutcome, SwapSuggestion } from "../types.js";
import { formatIgnored, formatPlan, formatPreview, formatSuggestion, money, style } from "./format.js";

export interface ApplyOptions {
  all?: boolean;
  only?: string[];
  includeSearch?: boolean;
  consolidate?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

/** Keeps one suggestion per cart line: the cheapest per unit. */
function onePerLine(suggestions: SwapSuggestion[]): SwapSuggestion[] {
  const byLine = new Map<string, SwapSuggestion>();
  for (const suggestion of suggestions) {
    const current = byLine.get(suggestion.from.lineId);
    if (!current || suggestion.to.basePrice.price < current.to.basePrice.price) byLine.set(suggestion.from.lineId, suggestion);
  }
  return [...byLine.values()];
}

/** The suggestions `--all` and `--only` stand for. */
export function selectSuggestions(plan: SavingsPlan, options: ApplyOptions): SwapSuggestion[] {
  if (options.only) {
    return options.only.map((id) => {
      const suggestion = findSuggestion(plan, id);
      if (!suggestion) throw new PicnicSaverError(`Unknown suggestion "${id}". Run "picnic-saver savings" for the current ids.`);
      return suggestion;
    });
  }
  const alternatives = plan.suggestions.filter((suggestion) => options.includeSearch || suggestion.source !== "search");
  const consolidation = options.consolidate ? plan.duplicates.flatMap((group) => group.consolidation) : [];
  return onePerLine([...alternatives, ...consolidation]);
}

function printOutcomes(suggestions: SwapSuggestion[], outcomes: SwapOutcome[]): void {
  for (const outcome of outcomes) {
    const suggestion = suggestions.find((candidate) => candidate.id === outcome.suggestionId)!;
    const label = `${suggestion.from.name} → ${suggestion.to.name}`;
    if (outcome.status === "applied") console.log(`${style("green", "✓")} ${label}`);
    else console.log(`${style(outcome.status === "failed" ? "red" : "yellow", outcome.status === "failed" ? "✗" : "-")} ${label}: ${outcome.reason}`);
  }
}

function printTotals(before: number, after: number): void {
  const saving = before - after;
  const effect = saving >= 0 ? `you save ${money(saving)}` : `${money(-saving)} more`;
  console.log(`\nTotal: ${money(before)} → ${style("bold", money(after))} (${effect})`);
}

/** Prints what {@link PicnicSaver.removeIgnored} did. */
export function printCleanup(cleanup: RemoveIgnoredResult): void {
  if (cleanup.removed.length > 0) console.log(formatIgnored(cleanup.removed, "Removed from your cart (ignore list)"));
  for (const { item, reason } of cleanup.failed) console.log(`${style("red", "✗")} Could not remove ${item.name}: ${reason}`);
  if (cleanup.removed.length + cleanup.failed.length > 0) console.log("");
}

async function applySelection(saver: PicnicSaver, plan: SavingsPlan, selected: SwapSuggestion[], options: ApplyOptions, cleanup: RemoveIgnoredResult | null = null): Promise<void> {
  const preview = previewSwaps(
    plan,
    selected.map((suggestion) => suggestion.id),
  );
  if (options.dryRun) {
    if (options.json) return console.log(JSON.stringify({ dryRun: true, wouldRemove: plan.ignored, preview, suggestions: selected }, null, 2));
    console.log(style("bold", `Would swap ${selected.length} products:`));
    for (const suggestion of selected) console.log(formatSuggestion(suggestion), "\n");
    console.log(formatPreview(preview));
    return;
  }

  const result = await saver.applySwaps(selected);
  if (options.json) return console.log(JSON.stringify({ removed: cleanup?.removed ?? [], preview, result }, null, 2));
  printOutcomes(selected, result.outcomes);
  printTotals(result.previousTotal, result.newTotal);
}

async function reviewOneByOne(saver: PicnicSaver, plan: SavingsPlan, options: ApplyOptions): Promise<void> {
  const queue = [...plan.suggestions, ...plan.duplicates.flatMap((group) => group.consolidation)];
  const swappedLines = new Set<string>();
  const counts = { applied: 0, declined: 0, failed: 0 };
  let total = plan.cart.totalPrice;

  for (const [index, suggestion] of queue.entries()) {
    if (swappedLines.has(suggestion.from.lineId)) continue;
    const title = suggestion.kind === "consolidate" ? "Duplicate: move to the cheaper product" : "Cheaper alternative";
    console.log(`\n${style("bold", `${title} (${index + 1}/${queue.length})`)}\n${formatSuggestion(suggestion)}`);
    const answer = await select({
      message: "Swap?",
      choices: [
        { name: "Yes", value: "yes" },
        { name: "No", value: "no" },
        { name: "Skip the rest", value: "stop" },
      ],
    });
    if (answer === "stop") break;
    if (answer === "no") {
      counts.declined++;
      continue;
    }

    swappedLines.add(suggestion.from.lineId);
    if (options.dryRun) {
      total += suggestion.linePriceDelta;
      counts.applied++;
      console.log(`Would swap. Estimated total: ${money(total)}`);
      continue;
    }
    try {
      const result = await saver.applySwap(suggestion);
      total = result.newTotal;
      counts.applied++;
      console.log(`${style("green", "✓")} Swapped. Total now: ${style("bold", money(total))}`);
    } catch (error) {
      if (!(error instanceof StaleSuggestionError) && !(error instanceof SwapFailedError)) throw error;
      counts.failed++;
      console.log(`${style("red", "✗")} ${error.message}`);
      if (error instanceof SwapFailedError && !error.rolledBack) console.log(style("yellow", "  The cart may contain both products now. Please check it."));
    }
  }

  const verb = options.dryRun ? "would be swapped" : "swapped";
  console.log(`\n${counts.applied} ${verb}, ${counts.declined} declined${counts.failed ? `, ${counts.failed} failed` : ""}.`);
  if (!options.dryRun && counts.failed > 0) total = (await saver.getCart()).totalPrice;
  printTotals(plan.cart.totalPrice, total);
}

/**
 * `picnic-saver apply`: removes the products on the ignore list, shows the plan, then swaps
 * everything at once or asks per suggestion.
 */
export async function runApply(saver: PicnicSaver, find: FindSavingsOptions, options: ApplyOptions): Promise<void> {
  const interactive = !options.all && !options.only;
  if (interactive && options.json) throw new PicnicSaverError("--json needs --all or --only.");
  if (interactive && !process.stdin.isTTY) throw new PicnicSaverError("Not an interactive terminal. Use --all or --only <ids...>.");

  // With --dry-run the ignored lines stay in the cart and the plan lists them.
  const cleanup = options.dryRun || saver.ignore.length === 0 ? null : await saver.removeIgnored();
  if (cleanup && !options.json) printCleanup(cleanup);
  const plan = await saver.findSavings(find);
  if (!interactive) return applySelection(saver, plan, selectSuggestions(plan, options), options, cleanup);

  console.log(formatPlan(plan));
  const reviewable = plan.suggestions.length + plan.duplicates.reduce((sum, group) => sum + group.consolidation.length, 0);
  if (reviewable === 0) return;

  const trusted = selectSuggestions(plan, { includeSearch: options.includeSearch, consolidate: options.consolidate });
  const leftOut = reviewable - trusted.length;
  const answer = await select({
    message: "What do you want to do?",
    choices: [
      ...(trusted.length > 0
        ? [{ name: `Swap all ${trusted.length}${leftOut > 0 ? ` (leaves out ${leftOut} from search or duplicates; review those one by one)` : ""}`, value: "all" }]
        : []),
      { name: "Review one by one", value: "review" },
      { name: "Cancel", value: "cancel" },
    ],
  });

  if (answer === "all") return applySelection(saver, plan, trusted, options);
  if (answer === "review") return reviewOneByOne(saver, plan, options);
  console.log("Nothing changed.");
}
