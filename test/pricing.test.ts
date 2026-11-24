import { describe, expect, it } from "vitest";
import { parsePackageSize } from "../src/package-size.js";
import { basePriceOf, coveringQuantity, lineCost, unitPriceAt } from "../src/pricing.js";

describe("parsePackageSize", () => {
  it.each([
    ["500 g", { amount: 0.5, unit: "kg" }],
    ["1,5 Liter", { amount: 1.5, unit: "l" }],
    ["6 x 330 ml", { amount: 1.98, unit: "l" }],
    ["10 Stück", { amount: 10, unit: "piece" }],
    ["1.000 g", { amount: 1, unit: "kg" }],
    ["9 Rollen, 400 g", { amount: 0.4, unit: "kg" }],
  ])("reads %s", (text, size) => {
    expect(parsePackageSize(text)).toEqual(size);
  });

  it.each(["24 Waschladungen", "2-3 Stück", ""])("returns null for %j", (text) => {
    expect(parsePackageSize(text)).toBeNull();
  });
});

describe("pricing", () => {
  const tiers = [{ price: 90, fromQuantity: 3 }];

  it("applies a quantity discount from its quantity on", () => {
    expect(unitPriceAt(100, tiers, 2)).toBe(100);
    expect(unitPriceAt(100, tiers, 3)).toBe(90);
    expect(lineCost(100, tiers, 4)).toBe(360);
    expect(lineCost(100, tiers, 0)).toBe(0);
  });

  it("covers at least the amount", () => {
    expect(coveringQuantity(1, 1)).toBe(1);
    expect(coveringQuantity(2 * 0.5, 1)).toBe(1);
    expect(coveringQuantity(1.2, 0.5)).toBe(3);
    expect(coveringQuantity(3 * 0.33, 0.99)).toBe(1);
    expect(coveringQuantity(0.2, 1)).toBe(1);
  });

  it("computes the price per unit", () => {
    expect(basePriceOf(398, 2, { amount: 0.5, unit: "kg" })).toEqual({ unit: "kg", price: 398 });
  });
});
