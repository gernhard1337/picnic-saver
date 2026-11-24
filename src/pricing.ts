import type { BasePrice, PackageSize, PriceTier } from "./types.js";

/** The price of one package in cents when `quantity` packages are bought, with quantity discounts. */
export function unitPriceAt(unitPrice: number, tiers: PriceTier[] | undefined, quantity: number): number {
  let price = unitPrice;
  for (const tier of tiers ?? []) {
    if (tier.price > 0 && tier.fromQuantity <= quantity && tier.price < price) price = tier.price;
  }
  return price;
}

/** What `quantity` packages cost in cents, with quantity discounts. */
export function lineCost(unitPrice: number, tiers: PriceTier[] | undefined, quantity: number): number {
  return quantity <= 0 ? 0 : unitPriceAt(unitPrice, tiers, quantity) * quantity;
}

/**
 * The fewest packages of `packageAmount` that hold at least `amount`: 1 kg is covered by one
 * 1 kg package, 1.2 kg by three 500 g packages.
 */
export function coveringQuantity(amount: number, packageAmount: number): number {
  return Math.max(1, Math.ceil(amount / packageAmount - 1e-9));
}

/** The price in cents per kilogram, litre or piece when `packages` packages cost `cost` cents. */
export function basePriceOf(cost: number, packages: number, size: PackageSize): BasePrice {
  return { unit: size.unit, price: Math.round(cost / (packages * size.amount)) };
}
