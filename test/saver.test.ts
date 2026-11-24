import { describe, expect, it } from "vitest";
import { InvalidSelectionError, PicnicSaver, StaleSuggestionError, SwapFailedError, matchIgnoreRule, parseIgnoreList, previewSwaps, type IgnoreRule } from "../src/index.js";
import { FakePicnic, type FakeProduct } from "./fake-picnic.js";

const catalog: FakeProduct[] = [
  { id: "pasta-brand", name: "Spaghetti", brand: "Barilla", unitQuantity: "500 g", price: 199, similar: ["pasta-own", "pasta-big", "pasta-posh"] },
  { id: "pasta-own", name: "Spaghetti", brand: "Ja", unitQuantity: "500 g", price: 89 },
  { id: "pasta-big", name: "Spaghetti XL", unitQuantity: "5 kg", price: 500 },
  { id: "pasta-posh", name: "Spaghetti Bronze", unitQuantity: "500 g", price: 349 },
  { id: "milk", name: "Vollmilch", unitQuantity: "1 l", price: 109, similar: ["milk-bio"] },
  { id: "milk-bio", name: "Bio Vollmilch", unitQuantity: "1 l", price: 145, similar: ["milk"] },
  { id: "oat", name: "Haferdrink", unitQuantity: "1 l", price: 95 },
  { id: "milk-cheap", name: "Vollmilch haltbar", unitQuantity: "1 l", price: 99 },
  { id: "soap", name: "Waschmittel", unitQuantity: "24 Waschladungen", price: 499, similar: ["pasta-own"] },
  { id: "cola", name: "Cola", unitQuantity: "1 l", price: 150, similar: ["cola-six"] },
  { id: "cola-six", name: "Cola Sixpack", unitQuantity: "6 x 330 ml", price: 300, priceRanges: [{ price: 250, from_quantity: 2 }], maxCount: 1 },
];

function setup(cart: Record<string, number>) {
  const fake = new FakePicnic(catalog, cart);
  return { fake, saver: new PicnicSaver({ client: fake.client }) };
}

describe("getCart", () => {
  it("returns the lines with prices per unit and the total", async () => {
    const { fake, saver } = setup({ "pasta-brand": 2, soap: 1 });
    fake.extras = 25;
    const cart = await saver.getCart();
    expect(cart.totalPrice).toBe(2 * 199 + 499 + 25);
    expect(cart.itemsTotal).toBe(2 * 199 + 499);
    expect(cart.items[0]).toMatchObject({ productId: "pasta-brand", quantity: 2, linePrice: 398, unitPrice: 199, basePrice: { unit: "kg", price: 398 } });
    expect(cart.items[1]).toMatchObject({ productId: "soap", basePrice: null });
  });
});

describe("findSavings", () => {
  it("suggests the product that costs least per unit, in the quantity that covers the line", async () => {
    const { saver } = setup({ "pasta-brand": 2 });
    const plan = await saver.findSavings({ sources: ["similar"] });
    const [line] = plan.lines;

    expect(line!.suggestions.map((suggestion) => suggestion.to.productId)).toEqual(["pasta-big", "pasta-own"]);
    expect(line!.recommended).toMatchObject({
      id: "pasta-brand:pasta-big",
      kind: "alternative",
      source: "similar",
      to: { quantity: 1, linePrice: 500, basePrice: { unit: "kg", price: 100 }, alreadyInCart: false },
      savingPerUnit: 298,
      linePriceDelta: 102,
      increasesLinePrice: true,
    });
    expect(line!.suggestions[1]).toMatchObject({ to: { quantity: 2, linePrice: 178 }, linePriceDelta: -220, increasesLinePrice: false });
    expect(plan.summary).toEqual({ suggestionIds: ["pasta-brand:pasta-big"], currentTotal: 398, estimatedTotal: 500, estimatedSaving: -102 });
  });

  it("skips lines without a comparable size and reports why", async () => {
    const { saver } = setup({ soap: 1 });
    const plan = await saver.findSavings();
    expect(plan.lines[0]).toMatchObject({ skipped: "no-comparable-size", suggestions: [] });
    expect(plan.suggestions).toEqual([]);
  });

  it("drops a candidate the cart wouldn't accept in the needed quantity", async () => {
    const { saver } = setup({ cola: 3 });
    const plan = await saver.findSavings({ sources: ["similar"] });
    expect(plan.lines[0]!.suggestions).toEqual([]);
  });

  it("adds search results as less reliable suggestions and filters other kinds of product", async () => {
    const { fake, saver } = setup({ milk: 1 });
    fake.searchResults.set("Vollmilch", ["oat", "milk-cheap", "milk"]);
    const plan = await saver.findSavings();
    expect(plan.lines[0]!.suggestions.map((suggestion) => [suggestion.to.productId, suggestion.source])).toEqual([["milk-cheap", "search"]]);
    expect(plan.lines[0]!.recommended!.source).toBe("search");
  });

  it("accepts a custom source and prefers it over search for the recommendation", async () => {
    const { fake, saver } = setup({ milk: 1 });
    fake.searchResults.set("Vollmilch", ["milk-cheap"]);
    const plan = await saver.findSavings({
      sources: ["search", { name: "mine", find: async () => [{ productId: "x", name: "Milch", unitQuantity: "1 l", unitPrice: 105, source: "ignored" }] }],
    });
    expect(plan.lines[0]!.suggestions.map((suggestion) => suggestion.source)).toEqual(["search", "mine"]);
    expect(plan.lines[0]!.recommended!.to.productId).toBe("x");
  });

  it("keeps going when a product page can't be read", async () => {
    const { fake, saver } = setup({ "pasta-brand": 1, milk: 1 });
    fake.failProductPages.add("milk");
    const plan = await saver.findSavings({ sources: ["similar"] });
    expect(plan.suggestions).toHaveLength(1);
    expect(plan.warnings).toEqual(["Could not read the product page of milk: page broken"]);
  });

  it("returns plain JSON", async () => {
    const { saver } = setup({ "pasta-brand": 2, milk: 1, "milk-bio": 1 });
    const plan = await saver.findSavings({ sources: ["similar"] });
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });
});

describe("duplicates", () => {
  it("points out the same kind of product at two prices and offers to move to the cheapest", async () => {
    const { saver } = setup({ milk: 1, "milk-bio": 2 });
    const plan = await saver.findSavings({ sources: ["similar"] });

    // A product that is in the cart already is not an alternative.
    expect(plan.suggestions).toEqual([]);
    expect(plan.duplicates).toHaveLength(1);
    const [group] = plan.duplicates;
    expect(group).toMatchObject({
      confidence: "high",
      reasons: ["similar-products", "name-match"],
      cheapestProductId: "milk",
      basePriceSpread: { unit: "l", price: 36 },
      potentialSaving: 72,
    });
    expect(group!.items.map((item) => item.productId)).toEqual(["milk", "milk-bio"]);
    expect(group!.consolidation).toHaveLength(1);
    expect(group!.consolidation[0]).toMatchObject({
      id: "milk-bio:milk",
      kind: "consolidate",
      source: "duplicate",
      to: { productId: "milk", quantity: 2, alreadyInCart: true },
      linePriceDelta: -72,
    });
  });

  it("consolidates into the existing line", async () => {
    const { fake, saver } = setup({ milk: 1, "milk-bio": 2 });
    const plan = await saver.findSavings({ sources: ["similar"] });
    const result = await saver.applySwap(plan.duplicates[0]!.consolidation[0]!);
    expect([...fake.quantities]).toEqual([["milk", 3]]);
    expect(result).toMatchObject({ previousTotal: 109 + 290, newTotal: 327, actualSaving: 72 });
  });
});

describe("previewSwaps", () => {
  it("computes the total for a selection", async () => {
    const { saver } = setup({ "pasta-brand": 2, milk: 1 });
    const plan = await saver.findSavings({ sources: ["similar"] });
    expect(previewSwaps(plan, ["pasta-brand:pasta-own"])).toMatchObject({ currentTotal: 507, estimatedTotal: 287, estimatedSaving: 220 });
    expect(previewSwaps(plan, [])).toMatchObject({ estimatedTotal: 507, estimatedSaving: 0 });
  });

  it("rejects unknown ids and two suggestions for one line", async () => {
    const { saver } = setup({ "pasta-brand": 2 });
    const plan = await saver.findSavings({ sources: ["similar"] });
    expect(() => previewSwaps(plan, ["nope"])).toThrow(InvalidSelectionError);
    expect(() => previewSwaps(plan, ["pasta-brand:pasta-own", "pasta-brand:pasta-big"])).toThrow(InvalidSelectionError);
  });
});

describe("applySwap", () => {
  async function planFor(cart: Record<string, number>) {
    const context = setup(cart);
    const plan = await context.saver.findSavings({ sources: ["similar"] });
    const suggestion = plan.lines[0]!.suggestions.find((candidate) => candidate.to.productId === "pasta-own")!;
    return { ...context, plan, suggestion };
  }

  it("adds the new product, then removes the old one", async () => {
    const { fake, saver, suggestion } = await planFor({ "pasta-brand": 2, milk: 1 });
    fake.calls.length = 0;
    const result = await saver.applySwap(suggestion);
    expect(fake.calls).toEqual(["add pasta-own 2", "remove pasta-brand 2"]);
    expect(result).toMatchObject({ suggestionId: "pasta-brand:pasta-own", previousTotal: 507, newTotal: 287, actualSaving: 220 });
    expect(result.cart.items.map((item) => item.productId).sort()).toEqual(["milk", "pasta-own"]);
  });

  it("applies suggestions independently of other changes to the cart", async () => {
    const { fake, saver, suggestion } = await planFor({ "pasta-brand": 2, milk: 1 });
    fake.quantities.delete("milk");
    fake.quantities.set("oat", 4);
    await expect(saver.applySwap(suggestion)).resolves.toMatchObject({ suggestionId: suggestion.id });
  });

  it("refuses a suggestion whose line changed and leaves the cart alone", async () => {
    const { fake, saver, suggestion } = await planFor({ "pasta-brand": 2 });
    fake.quantities.set("pasta-brand", 3);
    fake.calls.length = 0;
    await expect(saver.applySwap(suggestion)).rejects.toThrow(StaleSuggestionError);
    fake.quantities.delete("pasta-brand");
    await expect(saver.applySwap(suggestion)).rejects.toThrow(/no longer in the cart/);
    expect(fake.calls).toEqual([]);
  });

  it("takes the new product out again when the old one can't be removed", async () => {
    const { fake, saver, suggestion } = await planFor({ "pasta-brand": 2 });
    fake.failRemove = "once";
    const error = await saver.applySwap(suggestion).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SwapFailedError);
    expect(error).toMatchObject({ stage: "remove", rolledBack: true });
    expect([...fake.quantities]).toEqual([["pasta-brand", 2]]);
  });

  it("says so when the cart could not be restored", async () => {
    const { fake, saver, suggestion } = await planFor({ "pasta-brand": 2 });
    fake.failRemove = "always";
    await expect(saver.applySwap(suggestion)).rejects.toMatchObject({ stage: "remove", rolledBack: false });
  });

  it("fails without changes when the product can't be added", async () => {
    const { fake, saver, suggestion } = await planFor({ "pasta-brand": 2 });
    fake.failAdd = true;
    await expect(saver.applySwap(suggestion)).rejects.toMatchObject({ stage: "add", rolledBack: true });
    expect([...fake.quantities]).toEqual([["pasta-brand", 2]]);
  });

  it("undoes a partial add when the cart caps the quantity", async () => {
    const { fake, saver, suggestion } = await planFor({ "pasta-brand": 2 });
    fake.products.get("pasta-own")!.maxCount = 1;
    await expect(saver.applySwap(suggestion)).rejects.toMatchObject({ stage: "add", rolledBack: true });
    expect([...fake.quantities]).toEqual([["pasta-brand", 2]]);
  });

  it("needs a login", async () => {
    const { fake, saver, suggestion } = await planFor({ "pasta-brand": 2 });
    fake.authKey = null;
    await expect(saver.applySwap(suggestion)).rejects.toThrow(/Not logged in/);
  });
});

describe("applySwaps", () => {
  it("reports each outcome and the real total", async () => {
    const { fake, saver } = setup({ "pasta-brand": 2, milk: 1, "milk-bio": 1 });
    const plan = await saver.findSavings({ sources: ["similar"] });
    const pasta = plan.lines[0]!.suggestions.find((candidate) => candidate.to.productId === "pasta-own")!;
    const stale = { ...pasta, id: "stale", from: { ...pasta.from, productId: "oat", name: "Haferdrink" } };
    const result = await saver.applySwaps([stale, pasta, plan.duplicates[0]!.consolidation[0]!]);

    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(["skipped", "applied", "applied"]);
    expect([...fake.quantities].sort()).toEqual([
      ["milk", 2],
      ["pasta-own", 2],
    ]);
    expect(result).toMatchObject({ previousTotal: 398 + 109 + 145, newTotal: 178 + 218, actualSaving: 256 });
  });
});

describe("ignore list", () => {
  const herbs: FakeProduct[] = [
    { id: "parsley", name: "Bio Petersilie glatt", unitQuantity: "1 Stück", price: 129, recipeId: "r1", similar: ["parsley-cheap"] },
    { id: "parsley-cheap", name: "Petersilie", unitQuantity: "1 Stück", price: 99 },
    { id: "root", name: "Petersilienwurzel", unitQuantity: "500 g", price: 249 },
    { id: "milk", name: "Vollmilch", unitQuantity: "1 l", price: 109, similar: ["oat"] },
    { id: "oat", name: "Haferdrink", unitQuantity: "1 l", price: 95 },
  ];
  function herbCart(ignore: IgnoreRule[]) {
    const fake = new FakePicnic(herbs, { parsley: 2, root: 1, milk: 1 });
    return { fake, saver: new PicnicSaver({ client: fake.client, ignore }) };
  }

  it("matches whole words of the name, or the product id", () => {
    const parsley = { productId: "parsley", name: "Bio Petersilie glatt" };
    expect(matchIgnoreRule(parsley, ["petersilie"])).toBe("petersilie");
    expect(matchIgnoreRule(parsley, ["glatt Petersilie"])).not.toBeNull();
    expect(matchIgnoreRule({ productId: "root", name: "Petersilienwurzel" }, ["Petersilie"])).toBeNull();
    expect(matchIgnoreRule(parsley, [{ productId: "parsley" }])).toEqual({ productId: "parsley" });
    expect(matchIgnoreRule(parsley, [{ productId: "other", name: "Petersilie" }, "Schnittlauch", {}, ""])).toBeNull();
  });

  it("validates a list from JSON", () => {
    expect(parseIgnoreList({ ignore: ["Petersilie", { productId: "s1", note: "never" }] })).toEqual(["Petersilie", { productId: "s1", note: "never" }]);
    expect(parseIgnoreList(["a"])).toEqual(["a"]);
    expect(() => parseIgnoreList({ items: [] })).toThrow(/must be an array/);
    expect(() => parseIgnoreList([{ note: "x" }])).toThrow(/rule 1/);
    expect(() => parseIgnoreList([42])).toThrow(/rule 1/);
  });

  it("flags ignored lines in the cart and keeps them out of the plan", async () => {
    const { fake, saver } = herbCart(["Petersilie"]);
    expect((await saver.getCart()).items.map((item) => item.ignored)).toEqual([true, false, false]);

    const plan = await saver.findSavings({ sources: ["similar"], includeRecipeItems: true });
    expect(plan.ignored.map((item) => item.productId)).toEqual(["parsley"]);
    expect(plan.lines[0]).toMatchObject({ skipped: "ignored", suggestions: [] });
    expect(fake.calls).not.toContain("product parsley");
    expect([...fake.quantities.keys()]).toEqual(["parsley", "root", "milk"]);
  });

  it("never suggests an ignored product as an alternative", async () => {
    const { saver } = herbCart(["Haferdrink"]);
    const plan = await saver.findSavings({ sources: ["similar"] });
    expect(plan.suggestions).toEqual([]);
  });

  it("removes ignored lines, also those of a recipe", async () => {
    const { fake, saver } = herbCart(["Petersilie"]);
    const result = await saver.removeIgnored();
    expect(result.removed.map((item) => [item.productId, item.quantity])).toEqual([["parsley", 2]]);
    expect(result).toMatchObject({ failed: [], previousTotal: 258 + 249 + 109, newTotal: 249 + 109 });
    expect([...fake.quantities.keys()]).toEqual(["root", "milk"]);
  });

  it("reports what could not be removed and does nothing without rules", async () => {
    const { fake, saver } = herbCart([]);
    expect(await saver.removeIgnored()).toMatchObject({ removed: [], failed: [] });
    saver.ignore = [{ productId: "milk" }];
    fake.failRemove = "always";
    const result = await saver.removeIgnored();
    expect(result.failed).toMatchObject([{ item: { productId: "milk" }, reason: "remove rejected" }]);
    expect(result.newTotal).toBe(result.previousTotal);
  });
});
