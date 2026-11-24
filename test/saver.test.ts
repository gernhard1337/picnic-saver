import PicnicClient from "picnic-api";
import { describe, expect, it } from "vitest";
import { InvalidSelectionError, PicnicSaver, StaleSuggestionError, SwapFailedError, matchIgnoreRule, parseIgnoreList, previewSwaps, toCartSummary, type IgnoreRule } from "../src/index.js";
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

describe("toCartSummary", () => {
  const line = (id: string, productId: string, quantity: number, displayPrice: number, originalPrice: number | null = null) => ({
    id,
    productId,
    name: productId,
    unitQuantity: "300g",
    imageId: null,
    quantity,
    displayPrice,
    originalPrice,
    priceRanges: null,
    isUnavailable: false,
    recipeId: null,
  });
  const summarize = (items: ReturnType<typeof line>[], totalCount: number) => toCartSummary({ id: "c", items, totalCount, totalPrice: 0 } as never);

  it("splits a product total that picnic-api reports on each of its lines", () => {
    // 1 package in one recipe, 2 in another: both lines say 3.
    const cart = summarize([line("a", "mushrooms", 3, 269, 299), line("b", "mushrooms", 3, 538, 598), line("c", "other", 2, 200)], 5);
    expect(cart.items.map((item) => [item.quantity, item.unitPrice, item.basePrice?.price])).toEqual([
      [1, 269, 897],
      [2, 269, 897],
      [2, 100, 333],
    ]);
  });

  it("leaves quantities that add up alone", () => {
    const cart = summarize([line("a", "mushrooms", 2, 538), line("b", "mushrooms", 2, 538)], 4);
    expect(cart.items.map((item) => item.quantity)).toEqual([2, 2]);
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

  it("suggests a cheaper product that is in the cart already and counts its quantity discount", async () => {
    const { saver } = setup({ cola: 2, "pasta-brand": 2, "pasta-own": 1 });
    const plan = await saver.findSavings({ sources: ["similar"] });
    const pasta = plan.lines.find((line) => line.item.productId === "pasta-brand")!;
    expect(pasta.suggestions.find((suggestion) => suggestion.to.productId === "pasta-own")).toMatchObject({ to: { quantity: 2, linePrice: 178, alreadyInCart: true } });
  });

  it("adds search results as less reliable suggestions and filters other kinds of product", async () => {
    const { fake, saver } = setup({ milk: 1 });
    fake.products.set("milk-meal", { id: "milk-meal", name: "Grießbrei mit Vollmilch und Zimt", unitQuantity: "1 l", price: 50 });
    fake.searchResults.set("Vollmilch", ["oat", "milk-meal", "milk-cheap", "milk"]);
    const plan = await saver.findSavings();
    expect(plan.lines[0]!.suggestions.map((suggestion) => [suggestion.to.productId, suggestion.source])).toEqual([["milk-cheap", "search"]]);
    expect(plan.lines[0]!.recommended!.source).toBe("search");
  });

  it("accepts a custom source and recommends the cheapest suggestion of all sources", async () => {
    const { fake, saver } = setup({ milk: 1 });
    fake.searchResults.set("Vollmilch", ["milk-cheap"]);
    const plan = await saver.findSavings({
      sources: ["search", { name: "mine", find: async () => [{ productId: "x", name: "Milch", unitQuantity: "1 l", unitPrice: 105, source: "ignored" }] }],
    });
    expect(plan.lines[0]!.suggestions.map((suggestion) => suggestion.source)).toEqual(["search", "mine"]);
    expect(plan.lines[0]!.recommended!.to.productId).toBe("milk-cheap");
  });

  it("keeps going when a product page can't be read", async () => {
    const { fake, saver } = setup({ "pasta-brand": 1, milk: 1 });
    fake.failProductPages.add("milk");
    const plan = await saver.findSavings({ sources: ["similar"] });
    expect(plan.suggestions).toHaveLength(1);
    expect(plan.warnings).toEqual(["Could not read the product page of milk: page broken"]);
    fake.failProductPages.clear();
  });

  it("stops asking when Picnic throttles and says how far it got", async () => {
    const { fake, saver } = setup({ "pasta-brand": 1, milk: 1, cola: 1, oat: 1 });
    fake.failSearches = { from: 2, error: new PicnicClient.PicnicApiError(403, "Forbidden", "<html>blocked</html>") };
    const plan = await saver.findSavings({ concurrency: 1 });
    expect(fake.calls.filter((call) => call.startsWith("search "))).toHaveLength(2);
    expect(plan.warnings).toEqual(["Picnic started to refuse requests (too many in a short time), so only 1 of 4 products were checked completely. Wait a few minutes and try again."]);
    expect(plan.suggestions.map((suggestion) => suggestion.from.productId)).toEqual(["pasta-brand"]);
  });

  it("searches a name once and reads no product pages for skipped lines", async () => {
    const fake = new FakePicnic([...catalog, { id: "milk-b", name: "Vollmilch", unitQuantity: "500 ml", price: 80 }, { id: "herb", name: "Dill", unitQuantity: "25 g", price: 99, recipeId: "r" }], { milk: 1, "milk-b": 1, herb: 1 });
    const plan = await new PicnicSaver({ client: fake.client }).findSavings({ includeRecipeItems: false });
    expect(plan.lines[2]).toMatchObject({ skipped: "recipe" });
    expect(fake.calls.sort()).toEqual(["product milk", "product milk-b", "search Vollmilch"]);
  });

  it("checks lines of a recipe by default", async () => {
    const fake = new FakePicnic([...catalog, { id: "recipe-pasta", name: "Spaghetti", brand: "De Cecco", unitQuantity: "500 g", price: 249, recipeId: "r", similar: ["pasta-own"] }], { "recipe-pasta": 1 });
    const plan = await new PicnicSaver({ client: fake.client }).findSavings({ sources: ["similar"] });
    expect(plan.suggestions).toMatchObject([{ id: "recipe-pasta:pasta-own", from: { recipeId: "r" } }]);
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

    // The cheaper product is an alternative too, marked as being in the cart.
    expect(plan.suggestions).toMatchObject([{ id: "milk-bio:milk", kind: "alternative", to: { quantity: 2, alreadyInCart: true }, linePriceDelta: -72 }]);
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
      id: "merge:milk-bio:milk",
      kind: "consolidate",
      source: "duplicate",
      to: { productId: "milk", quantity: 2, alreadyInCart: true },
      linePriceDelta: -72,
    });
  });

  it("needs matching names: products Picnic merely lists as similar are no duplicates", async () => {
    const { saver } = setup({ cola: 1, "cola-six": 1, "pasta-brand": 1, "pasta-own": 1, "pasta-posh": 1 });
    const plan = await saver.findSavings({ sources: ["similar"] });
    expect(plan.duplicates.map((group) => [group.id, group.confidence])).toEqual([["pasta-own+pasta-brand", "high"]]);
  });

  it("matches names without a similar link, with less confidence", async () => {
    const { saver } = setup({ milk: 1, "milk-cheap": 1, "pasta-own": 1, "pasta-posh": 1 });
    const fake2 = new FakePicnic([...catalog, { id: "milk-2", name: "Vollmilch", brand: "Weihenstephan", unitQuantity: "500 ml", price: 99 }], { milk: 1, "milk-2": 1 });
    expect((await saver.findSavings({ sources: ["similar"] })).duplicates).toEqual([]);
    const plan = await new PicnicSaver({ client: fake2.client }).findSavings({ sources: ["similar"] });
    expect(plan.duplicates).toMatchObject([{ confidence: "medium", reasons: ["name-match"], cheapestProductId: "milk" }]);
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
    expect(plan.suggestions.map((suggestion) => suggestion.to.productId)).not.toContain("oat");
    expect(plan.lines.find((line) => line.item.productId === "milk")!.suggestions).toEqual([]);
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
