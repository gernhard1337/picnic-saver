import { select } from "@inquirer/prompts";
import { PicnicSaverError, StaleSuggestionError, SwapFailedError } from "../errors.js";
import { findSuggestion } from "../savings.js";
import type { FindSavingsOptions, PicnicSaver } from "../saver.js";
import { buildSuggestion } from "../suggestion.js";
import type { CartItem, RemoveIgnoredResult, SavingsPlan, SwapOutcome, SwapPreview, SwapSuggestion } from "../types.js";
import { formatIgnored, formatPlan, formatPreview, formatSuggestion, money, style } from "./format.js";

export interface ApplyOptions {
  all?: boolean;
  only?: string[];
  includeSearch?: boolean;
  consolidate?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

/**
 * The suggestions `--all` and `--only` stand for.
 *
 * `--all` takes the cheapest allowed suggestion of every line. Search results need
 * `--include-search`. A line is never moved onto a product that is swapped away in the same run;
 * it goes where that product goes. With three sizes of the same potatoes in the cart, the two
 * more expensive ones both end up on the cheapest instead of one on the other. Such a redirected
 * suggestion is new, not one of the plan.
 */
export function selectSuggestions(plan: SavingsPlan, options: ApplyOptions): SwapSuggestion[] {
  if (options.only) {
    return options.only.map((id) => {
      const suggestion = findSuggestion(plan, id);
      if (!suggestion) throw new PicnicSaverError(`Unknown suggestion "${id}". Run "picnic-saver savings" for the current ids.`);
      return suggestion;
    });
  }

  const merges = options.consolidate ? plan.duplicates.flatMap((group) => group.consolidation) : [];
  const lines = plan.lines
    .map((line) => ({
      line,
      options: [...line.suggestions, ...merges.filter((merge) => merge.from.lineId === line.item.lineId)]
        .filter((suggestion) => options.includeSearch || suggestion.source !== "search")
        .sort((x, y) => x.to.basePrice.price - y.to.basePrice.price),
    }))
    .filter((entry) => entry.options.length > 0);

  const inCart = new Map<string, number>();
  for (const item of plan.cart.items) inCart.set(item.productId, (inCart.get(item.productId) ?? 0) + item.quantity);

  // A target costs less per unit than the line it replaces, so going from the cheapest line up,
  // it is known for every target whether it stays in the cart, and if not, where it goes.
  const destination = new Map<string, SwapSuggestion>();
  const chosen = new Map<string, SwapSuggestion>();
  for (const entry of [...lines].sort((x, y) => (x.line.item.basePrice?.price ?? 0) - (y.line.item.basePrice?.price ?? 0))) {
    const { item } = entry.line;
    for (const option of entry.options) {
      const onward = destination.get(option.to.productId);
      const choice = onward ? redirect(item, onward, inCart.get(onward.to.productId) ?? 0) : option;
      if (!choice || destination.has(choice.to.productId)) continue;
      chosen.set(item.lineId, choice);
      destination.set(item.productId, choice);
      break;
    }
  }
  return lines.flatMap((entry) => chosen.get(entry.line.item.lineId) ?? []).filter((suggestion) => !destination.has(suggestion.to.productId));
}

/** The suggestion to move `item` straight to where `onward` goes, or null when that isn't cheaper for it. */
function redirect(item: CartItem, onward: SwapSuggestion, quantityInCart: number): SwapSuggestion | null {
  const { to } = onward;
  const candidate = { productId: to.productId, name: to.name, unitQuantity: to.unitQuantity, unitPrice: Math.round(to.linePrice / to.quantity), imageId: to.imageId, source: onward.source };
  return buildSuggestion({ kind: "alternative", item, candidate, quantityInCart, minSavingPerUnit: 1 });
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
  // Not previewSwaps: a redirected suggestion is not part of the plan.
  const delta = selected.reduce((sum, suggestion) => sum + suggestion.linePriceDelta, 0);
  const preview: SwapPreview = {
    suggestionIds: selected.map((suggestion) => suggestion.id),
    currentTotal: plan.cart.totalPrice,
    estimatedTotal: plan.cart.totalPrice + delta,
    estimatedSaving: delta === 0 ? 0 : -delta,
  };
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
  const sameSwap = (a: SwapSuggestion, b: SwapSuggestion) => a.from.lineId === b.from.lineId && a.to.productId === b.to.productId;
  const consolidation = plan.duplicates.flatMap((group) => group.consolidation).filter((merge) => !plan.suggestions.some((suggestion) => sameSwap(suggestion, merge)));
  const queue = [...plan.suggestions, ...consolidation];
  const swappedLines = new Set<string>();
  // Products that left the cart, and products whose quantity grew, in this review.
  const gone = new Set<string>();
  const grown = new Set<string>();
  const counts = { applied: 0, declined: 0, failed: 0 };
  let total = plan.cart.totalPrice;

  for (const [index, planned] of queue.entries()) {
    if (swappedLines.has(planned.from.lineId)) continue;
    if (grown.has(planned.from.productId)) {
      console.log(style("dim", `\nSkipping ${planned.from.name}: you just moved other products onto it. Run "apply" again to see what is left.`));
      continue;
    }
    // Don't offer a product that was just swapped away; take the line's next best instead.
    const others = plan.lines.find((line) => line.item.lineId === planned.from.lineId)?.suggestions ?? [];
    const suggestion = gone.has(planned.to.productId) ? others.find((other) => !gone.has(other.to.productId)) : planned;
    if (!suggestion) continue;
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
      gone.add(suggestion.from.productId);
      grown.add(suggestion.to.productId);
      total += suggestion.linePriceDelta;
      counts.applied++;
      console.log(`Would swap. Estimated total: ${money(total)}`);
      continue;
    }
    try {
      const result = await saver.applySwap(suggestion);
      gone.add(suggestion.from.productId);
      grown.add(suggestion.to.productId);
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
  const reviewable = new Set([...plan.suggestions, ...plan.duplicates.flatMap((group) => group.consolidation)].map((suggestion) => suggestion.from.lineId)).size;
  if (reviewable === 0) return;

  const trusted = selectSuggestions(plan, { includeSearch: options.includeSearch, consolidate: options.consolidate });
  const leftOut = reviewable - trusted.length;
  const why = options.includeSearch ? "they only merge duplicates" : "they come from search results or only merge duplicates";
  const answer = await select({
    message: "What do you want to do?",
    choices: [
      ...(trusted.length > 0
        ? [{ name: `Swap all ${trusted.length}${leftOut > 0 ? ` (leaves out ${leftOut}: ${why}; review those one by one)` : ""}`, value: "all" }]
        : []),
      { name: "Review one by one", value: "review" },
      { name: "Cancel", value: "cancel" },
    ],
  });

  if (answer === "all") return applySelection(saver, plan, trusted, options);
  if (answer === "review") return reviewOneByOne(saver, plan, options);
  console.log("Nothing changed.");
}
