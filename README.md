# picnic-saver

Finds cheaper alternatives for the products in your [Picnic](https://picnic.app) cart and swaps them, as a library and as a CLI. Built on [picnic-api](https://github.com/MRVDH/picnic-api). Not affiliated with Picnic.

What it does:

1. Logs in to your Picnic account (with two-factor code when Picnic asks for one).
2. Reads the cart with its total.
3. Checks every cart line for products that cost less per kilogram, litre or piece, points out duplicates (milk and organic milk in the same cart), and estimates the new total.
4. Swaps the products you choose, one at a time or all at once.

Requires Node.js 20.12 or newer.

## CLI

```sh
npm install -g picnic-saver   # or, in this repository: npm install && npm run build && npm link

picnic-saver login            # asks for e-mail, password and, if needed, the SMS code
picnic-saver cart             # the cart and its total
picnic-saver savings          # suggestions, duplicates, estimated total; changes nothing
picnic-saver apply            # swap: all at once, or asked one by one
picnic-saver logout
```

`apply` shows the plan and then asks once: swap all, review one by one, or cancel. In the review you answer yes, no or "skip the rest" per suggestion; every yes is applied immediately and the new total is shown.

"Swap all" and `--all` only take suggestions from the similar products Picnic lists. Suggestions from search results and the consolidation of duplicates are offered in the review, or added with flags:

| Flag | Effect |
| --- | --- |
| `--all` | Swap all suggestions without asking. |
| `--only <ids...>` | Swap only these suggestions; the ids are shown in brackets by `savings`. |
| `--include-search` | Let `--all` also swap suggestions from search results. |
| `--consolidate` | Let `--all` also move duplicates onto the cheapest product. |
| `--dry-run` | Show what would happen without changing the cart. |
| `--no-search` | Don't search; only use the similar products Picnic lists. |
| `--include-recipes` | Also check products that belong to a recipe (swapping removes them from the recipe). |
| `--json` | Print JSON (`cart`, `savings`, and `apply` with `--all` or `--only`). |
| `--country <code>` | `DE` (default), `NL` or `FR`. |
| `--env-file <path>` | The .env file to use. Default: `.env` in the current directory. |

### Login and the .env file

`login` writes the auth key to `.env` in the current directory and `logout` removes it; other lines in the file are kept, and the file is made readable for you only. Your password is never stored.

| Variable | Meaning |
| --- | --- |
| `PICNIC_AUTH_KEY` | The session, written by `login`. |
| `PICNIC_COUNTRY_CODE` | `DE`, `NL` or `FR`. Written by `login`. |
| `PICNIC_EMAIL` | Optional. Prefills the e-mail prompt. |
| `PICNIC_PASSWORD` | Optional, read from the shell only, for scripted logins. |

Variables set in your shell win over the file. Keep `.env` out of version control; the CLI warns when it sits in a git repository without being ignored. See `.env.example`.

## Library

```sh
npm install picnic-saver
```

```ts
import { PicnicSaver, previewSwaps } from "picnic-saver";

const saver = new PicnicSaver({ countryCode: "DE" });

// 1. Log in. Store the auth key and pass it as `authKey` next time.
const login = await saver.login("me@example.com", "secret");
if (login.secondFactorRequired) {
  await saver.requestTwoFactorCode();
  await saver.verifyTwoFactorCode("123456");
}
console.log(saver.authKey);

// 2. The cart. All amounts are in cents.
const cart = await saver.getCart();
console.log(cart.totalPrice);

// 3. Savings. Reads only; the cart is not changed.
const plan = await saver.findSavings();
console.log(plan.suggestions, plan.duplicates, plan.summary.estimatedTotal);

// 4. Swap one suggestion, or several.
const result = await saver.applySwap(plan.suggestions[0]);
console.log(result.newTotal, result.actualSaving);
```

Works from ESM and CommonJS and ships its types.

### The plan

`findSavings()` returns a `SavingsPlan`, which is plain JSON, so you can send it to a frontend and pass single suggestions back later:

| Field | Content |
| --- | --- |
| `cart` | The cart the plan was made for. |
| `lines` | One entry per cart line: all its `suggestions` (cheapest per unit first), the `recommended` one, or why it was `skipped`. |
| `suggestions` | The recommended suggestion of every line that has one. |
| `duplicates` | Groups of lines that are the same kind of product at different prices, each with `consolidation` suggestions. |
| `summary` | Current total, estimated total and saving when all of `suggestions` are applied. |
| `warnings` | Problems that didn't stop the analysis, such as a product page that couldn't be read. |

A `SwapSuggestion` says what is replaced (`from`), by what and in which quantity (`to`), how much less it costs per unit (`savingPerUnit`), and what that does to the line price (`linePriceDelta`, negative is a saving). `source` is `"similar"`, `"search"`, `"duplicate"` or the name of your own source.

### How suggestions are made

- **Cheaper means cheaper per unit.** A product is suggested when it costs less per kilogram, litre or piece than what you pay for the cart line now. Only products in the same unit are compared; lines without a weight, volume or piece count ("24 Waschladungen") are skipped.
- **The quantity covers what you had.** 2 × 500 g becomes 1 × 1 kg; 3 × 400 g becomes 2 × 1 kg. Quantity discounts are included.
- **A cheaper unit price can still cost more.** When the cheaper product only comes in a larger package, the line gets more expensive. Such suggestions have `increasesLinePrice: true`, and the estimated total includes the increase. Filter on `linePriceDelta < 0` if you only want swaps that lower the total.
- **Two sources.** `"similar"` are the similar products on Picnic's product page. `"search"` are search results for the product name, filtered by name; they find more, but can be a different kind of product, so the recommendation prefers other sources and the CLI never swaps them unasked.
- **Duplicates.** Two cart lines are a duplicate when Picnic lists one as similar to the other, or when their names are equal apart from words such as "Bio". `confidence` is `"high"` when both hold. A product that is already in the cart is never suggested as an alternative; it appears in `duplicates`, and applying its `consolidation` raises the quantity of the cheaper line.
- **Recipes.** Lines that belong to a recipe are skipped unless you pass `includeRecipeItems: true`.

### Options for `findSavings`

| Option | Default | Meaning |
| --- | --- | --- |
| `sources` | `["similar", "search"]` | Where alternatives come from, in order of preference. Accepts your own `AlternativeSource`. |
| `minSavingPerUnit` | `1` | The least an alternative must cost less per unit, in cents. |
| `maxSuggestionsPerLine` | `5` | The most suggestions kept per line. |
| `maxSearchSuggestionsPerLine` | `3` | The most suggestions from search kept per line. |
| `includeRecipeItems` | `false` | Also check lines that belong to a recipe. |
| `concurrency` | `4` | Requests to Picnic at the same time. |

A custom source proposes candidates; whether they are cheaper is decided for you:

```ts
import type { AlternativeSource } from "picnic-saver";

const ownBrand: AlternativeSource = {
  name: "own-brand",
  async find({ item, product, client }) {
    return [{ productId: "s123", name: "Ja Spaghetti", unitQuantity: "500 g", unitPrice: 89, source: "own-brand" }];
  },
};
await saver.findSavings({ sources: ["similar", ownBrand] });
```

### Applying swaps

Picnic has no "swap" and no dry run. `applySwap(suggestion)` adds the new product and then removes the old one, and returns the cart with the real total.

- Suggestions are independent. Each call reads the cart and checks only its own line, so a UI can apply them one by one, in any order, while the rest of the cart changes.
- `StaleSuggestionError`: the line is gone or has another quantity. Nothing was changed; call `findSavings()` again.
- `SwapFailedError`: Picnic rejected a step. `stage` is `"add"` or `"remove"`, and `rolledBack` says whether the cart is as before. When it is `false`, the cart may hold both products.
- `applySwaps(suggestions)` applies several in a row and reports `applied`, `skipped` (stale) or `failed` per suggestion instead of throwing.
- `previewSwaps(plan, ids)` computes the estimated total for any selection without touching the cart, and throws `InvalidSelectionError` for an unknown id or two suggestions for the same line.

### More

- `saver.client` is the picnic-api client, for delivery slots, checkout and everything else. You can also pass your own: `new PicnicSaver({ client })`.
- The pure functions are exported for use without a `PicnicSaver`: `buildSavingsPlan`, `findDuplicates`, `previewSwaps`, `findSuggestion`, `allSuggestions`, `parsePackageSize`, `toCartSummary`.
- Errors from Picnic are picnic-api's `PicnicApiError`, with `status` and `code` (`AUTH_INVALID_CRED` for wrong credentials, `OTP_NOT_VALID` for a wrong code, status 401 for an expired session).

## Limits

- **Totals before a swap are estimates.** They use list prices and quantity discounts. Promotions on the new product and deposit differences only show once the product is in the cart; `applySwap` returns the real total.
- **The API is unofficial.** Picnic can change it at any time; this library then depends on an update of picnic-api.
- **"Similar" is Picnic's judgement.** A similar product can differ in taste, brand or quality. The library compares prices, not products.

## Development

```sh
npm install
npm test             # unit tests against an in-memory Picnic, no network
npm run typecheck
npm run build
npm run cli -- savings   # run the CLI from source
```
