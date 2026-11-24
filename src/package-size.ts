import type { ComparisonUnit, PackageSize } from "./types.js";

// Adapted from picnic-api's src/domains/catalog/comparison-price.ts, which doesn't export its
// parser. Copyright (c) 2021 MRVDH, MIT License; see THIRD_PARTY_NOTICES.md.

/** Unit words in Dutch, German, French and English with their base unit and the factor to it. */
const UNITS: [string, ComparisonUnit, number][] = [
  ["kilogramm", "kg", 1],
  ["kilogram", "kg", 1],
  ["kilo", "kg", 1],
  ["kg", "kg", 1],
  ["gramm", "kg", 0.001],
  ["gram", "kg", 0.001],
  ["gr", "kg", 0.001],
  ["g", "kg", 0.001],
  ["milliliter", "l", 0.001],
  ["millilitre", "l", 0.001],
  ["liter", "l", 1],
  ["litre", "l", 1],
  ["ml", "l", 0.001],
  ["cl", "l", 0.01],
  ["l", "l", 1],
  ["stuks", "piece", 1],
  ["stuk", "piece", 1],
  ["stück", "piece", 1],
  ["stk", "piece", 1],
  ["st", "piece", 1],
  ["unités", "piece", 1],
  ["unité", "piece", 1],
  ["pièces", "piece", 1],
  ["pièce", "piece", 1],
  ["pieces", "piece", 1],
  ["piece", "piece", 1],
  ["pcs", "piece", 1],
];
const NUMBER = String.raw`\d+(?:[.,]\d+)*`;
const UNIT = UNITS.map(([word]) => word).join("|");
const SIZE = new RegExp(String.raw`(?:(\d+)\s*[x×]\s*)?(${NUMBER})\s*(${UNIT})(?![\p{L}])`, "iu");
const RANGE = new RegExp(String.raw`${NUMBER}\s*(?:-|–|of|oder|bis|ou|à)\s*${NUMBER}\s*(?:${UNIT})(?![\p{L}])`, "iu");

/** Reads "1,5", "1.5" and "1.000" (a thousands separator) as numbers. */
function parseAmount(text: string): number {
  if (/^[1-9]\d{0,2}(?:\.\d{3})+$/.test(text)) return Number(text.replace(/\./g, ""));
  return Number(text.replace(",", "."));
}

/**
 * Reads a package size as Picnic shows it ("400 g", "1,5 Liter", "6 x 330 ml", "10 Stück") into
 * kilograms, litres or pieces. Returns null for other units ("24 Waschladungen"), ranges
 * ("2-3 Stück") and texts without a size.
 */
export function parsePackageSize(unitQuantity: string): PackageSize | null {
  for (const part of unitQuantity.split(/,\s|•/)) {
    if (RANGE.test(part)) continue;
    const match = SIZE.exec(part);
    if (!match) continue;
    const [, count, amount, word] = match;
    const unit = UNITS.find(([w]) => w === word!.toLowerCase());
    if (!unit) continue;
    const total = (count ? Number(count) : 1) * parseAmount(amount!) * unit[2];
    if (total > 0) return { amount: Math.round(total * 1e6) / 1e6, unit: unit[1] };
  }
  return null;
}
