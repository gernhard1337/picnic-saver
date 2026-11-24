import { styleText } from "node:util";
import type { BasePrice, CartSummary, DuplicateGroup, SavingsPlan, SwapPreview, SwapSuggestion } from "../types.js";

type Style = Parameters<typeof styleText>[0];

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

export function style(format: Style, text: string): string {
  return useColor ? styleText(format, text) : text;
}

/** 1234 → "€12.34", -50 → "-€0.50". */
export function money(cents: number): string {
  return `${cents < 0 ? "-" : ""}€${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function basePrice(price: BasePrice | null): string {
  return price ? `${money(price.price)}/${price.unit}` : "";
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - text.length));
}

export function formatCart(cart: CartSummary): string {
  if (cart.items.length === 0) return "Your cart is empty.";
  const names = cart.items.map((item) => `${item.quantity} × ${item.name} (${item.unitQuantity})`);
  const width = Math.max(...names.map((name) => name.length));
  const lines = cart.items.map((item, index) => {
    const note = item.isUnavailable ? style("yellow", "  unavailable") : style("dim", `  ${basePrice(item.basePrice)}`);
    return `  ${pad(names[index]!, width)}  ${money(item.linePrice).padStart(8)}${note}`;
  });
  return [style("bold", `Cart (${cart.totalCount} products)`), ...lines, "", `Total: ${style("bold", money(cart.totalPrice))} (including deposits and fees)`].join("\n");
}

/** "saves €0.40" or "costs €0.30 more" for the change of a line price. */
export function lineEffect(delta: number): string {
  if (delta < 0) return style("green", `saves ${money(-delta)}`);
  if (delta === 0) return "same price";
  return style("yellow", `costs ${money(delta)} more (larger package)`);
}

export function formatSuggestion(suggestion: SwapSuggestion): string {
  const { from, to } = suggestion;
  const notes = [
    lineEffect(suggestion.linePriceDelta),
    `${money(suggestion.savingPerUnit)}/${to.basePrice.unit} cheaper`,
    suggestion.source === "search" ? style("yellow", "from search, check that it is the same kind of product") : null,
    to.alreadyInCart ? "already in your cart" : null,
  ].filter(Boolean);
  return [
    `  ${from.quantity} × ${from.name} (${from.unitQuantity})  ${money(from.linePrice)}  ${style("dim", basePrice(from.basePrice))}`,
    `  → ${to.quantity} × ${style("bold", to.name)} (${to.unitQuantity})  ${money(to.linePrice)}  ${style("dim", basePrice(to.basePrice))}`,
    `    ${notes.join(", ")}  ${style("dim", `[${suggestion.id}]`)}`,
  ].join("\n");
}

export function formatDuplicate(group: DuplicateGroup): string {
  const names = group.items.map((item) => `"${item.name}" (${item.unitQuantity}${item.basePrice ? `, ${basePrice(item.basePrice)}` : ""})`);
  const list = names.length > 2 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join(" and ");
  const what = group.basePriceSpread ? "are the same kind of product at different prices" : "look like the same kind of product";
  const lines = [`  ${style("yellow", "!")} ${list} ${what}.`];
  if (group.consolidation.length > 0) {
    const target = group.items.find((item) => item.productId === group.cheapestProductId)!;
    const effect = group.potentialSaving >= 0 ? `would save about ${money(group.potentialSaving)}` : `would cost about ${money(-group.potentialSaving)} more`;
    const ids = group.consolidation.map((suggestion) => suggestion.id).join(" ");
    lines.push(`    Moving everything to "${target.name}" ${effect}.  ${style("dim", `[${ids}]`)}`);
  }
  return lines.join("\n");
}

export function formatPreview(preview: SwapPreview): string {
  const effect = preview.estimatedSaving >= 0 ? `saves about ${money(preview.estimatedSaving)}` : `costs about ${money(-preview.estimatedSaving)} more`;
  return [`Current total:    ${money(preview.currentTotal)}`, `Estimated total:  ${style("bold", money(preview.estimatedTotal))}  (${effect})`].join("\n");
}

export function formatPlan(plan: SavingsPlan): string {
  const parts: string[] = [];
  if (plan.duplicates.length > 0) {
    parts.push(style("bold", "Possible duplicates"), ...plan.duplicates.map(formatDuplicate), "");
  }
  if (plan.suggestions.length === 0) {
    parts.push("No cheaper alternatives found.", "", `Total: ${money(plan.cart.totalPrice)}`);
  } else {
    parts.push(style("bold", `Cheaper alternatives (${plan.suggestions.length})`));
    for (const suggestion of plan.suggestions) parts.push(formatSuggestion(suggestion), "");
    parts.push(formatPreview(plan.summary));
    parts.push(style("dim", "The estimate leaves out promotions and deposits of the new products."));
  }
  for (const warning of plan.warnings) parts.push(style("yellow", `Warning: ${warning}`));
  return parts.join("\n");
}
