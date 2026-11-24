# picnic-saver

Finds cheaper alternatives for the products in your [Picnic](https://picnic.app) cart and swaps them. A library and a CLI on top of [picnic-api](https://github.com/MRVDH/picnic-api). Not affiliated with Picnic.

- Reads the cart and its total.
- Suggests, per cart line, products that cost less per kilogram, litre or piece, and estimates the new total.
- Points out duplicates, such as milk and organic milk in the same cart.
- Swaps the products you choose, one at a time or all at once.
- Removes products you never want, based on an ignore list.

Requires Node.js 20.12 or newer.

## CLI

```sh
npm install -g picnic-saver   # in this repository: npm install && npm run build && npm link

picnic-saver login            # e-mail, password and, if needed, the SMS code
picnic-saver cart             # the cart and its total
picnic-saver savings          # suggestions, duplicates, estimated total; changes nothing
picnic-saver apply            # swap: all at once, or asked one by one
picnic-saver clean            # remove the products on your ignore list
picnic-saver ignore add "Petersilie"
picnic-saver logout
```

`apply` first removes what is on the ignore list, shows the plan and asks: swap all, review one by one, or cancel. In the review every "yes" is applied at once. "Swap all" takes the cheapest suggestion of every line but leaves out search results, because a search can return another kind of product.

| Flag | Effect |
| --- | --- |
| `--all` | Swap all without asking. |
| `--only <ids...>` | Swap only these suggestions; `savings` shows the ids in brackets. |
| `--include-search` | Let `--all` also take suggestions from search results. |
| `--consolidate` | Let `--all` also merge duplicates. |
| `--dry-run` | Show what would happen without changing the cart. |
| `--no-search` | Only use the similar products Picnic lists. |
| `--no-recipes` | Leave products that belong to a recipe alone. |
| `--no-ignore` | Leave the ignore list out for this run. |
| `--json` | Print JSON. |
| `--country <code>` | `DE` (default), `NL` or `FR`. |
| `--env-file <path>`, `--ignore-file <path>` | Other files than `.env` and `picnic-saver.ignore.json` in the current directory. |

**Login.** `login` writes `PICNIC_AUTH_KEY` and `PICNIC_COUNTRY_CODE` to `.env`; your password is never stored. Variables set in your shell win over the file. Keep `.env` out of version control (see `.env.example`).

**Ignore list.** `picnic-saver.ignore.json` holds names and product ids, and can be edited by hand or with `ignore add`, `ignore remove` and `ignore`:

```json
{ "ignore": ["Petersilie", { "productId": "s1001524", "note": "grows in the garden" }] }
```

A name matches products that have all of its words as whole words: `Petersilie` matches "Bio Petersilie glatt", not "Petersilienwurzel". `apply` and `clean` remove matching products, also from recipes; `cart` and `savings` only mark them.

## Library

```sh
npm install picnic-saver
```

```ts
import { PicnicSaver, selectSwaps } from "picnic-saver";

const saver = new PicnicSaver({ countryCode: "DE", ignore: ["Petersilie"] });

const login = await saver.login("me@example.com", "secret");
if (login.secondFactorRequired) {
  await saver.requestTwoFactorCode();
  await saver.verifyTwoFactorCode("123456");
}
// Store saver.authKey and pass it as `authKey` next time.

const cart = await saver.getCart();                 // amounts are in cents
const plan = await saver.findSavings();             // reads only
await saver.applySwap(plan.suggestions[0]);         // one suggestion
await saver.applySwaps(selectSwaps(plan));          // or the cheapest of every line
await saver.removeIgnored();                        // take ignored products out
```

Works from ESM and CommonJS. Every export is documented in its TSDoc; [`examples/`](examples) has runnable scripts:

| Example | Shows |
| --- | --- |
| [`login.ts`](examples/login.ts) | Login with two-factor code. |
| [`savings.ts`](examples/savings.ts) | Cart, duplicates and suggestions, read-only. |
| [`swap-all.ts`](examples/swap-all.ts) | Selecting, previewing and applying all swaps. |
| [`ui-flow.ts`](examples/ui-flow.ts) | Keeping the plan as JSON and applying single suggestions later. |
| [`ignore-list.ts`](examples/ignore-list.ts) | Flagging and removing ignored products. |
| [`custom-source.ts`](examples/custom-source.ts) | Your own source of alternatives. |

### The plan

`findSavings()` returns plain JSON, so a UI can hold it and pass single suggestions back later.

| Field | Content |
| --- | --- |
| `lines` | Per cart line: its `suggestions` (cheapest per unit first), the `recommended` one, or why it was `skipped`. |
| `suggestions` | The recommended suggestion of every line. |
| `duplicates` | Lines that are the same kind of product at different prices, with `consolidation` suggestions onto the cheapest. |
| `ignored` | Lines on the ignore list. |
| `summary` | Current total, estimated total and saving for all of `suggestions`. |
| `warnings` | Problems that didn't stop the analysis. |

A suggestion says what is replaced (`from`), by what and how many (`to`), the saving per unit (`savingPerUnit`), the effect on the line price (`linePriceDelta`, negative is a saving) and where it comes from (`source`).

### How suggestions are made

- **Cheaper per unit.** A product is suggested when it costs less per kilogram, litre or piece than the line does now. Lines without such a size ("24 Waschladungen") are skipped.
- **The quantity covers what you had.** 2 × 500 g becomes 1 × 1 kg. When the cheaper product only comes in a larger package the line can cost more; then `increasesLinePrice` is true.
- **Sources.** `"similar"` are the few similar products on Picnic's product page. `"search"` are search results with a matching name; they find most alternatives. Both can be another kind of product, so check the names before you swap.
- **Duplicates** are lines whose names are equal apart from the brand and words such as "Bio".
- A cheaper product that is in the cart already is suggested too (`to.alreadyInCart`); swapping raises its quantity.

`findSavings` options: `sources` (default `["similar", "search"]`), `includeRecipeItems` (`true`), `minSavingPerUnit` (`1` cent), `maxSuggestionsPerLine` (`5`), `maxSearchSuggestionsPerLine` (`3`), `concurrency` (`2`).

### Swapping

Picnic has no swap and no dry run: `applySwap` adds the new product, then removes the old one, and returns the cart with the real total.

- Each call checks only its own cart line, so suggestions can be applied one by one while the rest of the cart changes.
- `StaleSuggestionError`: the line is gone or has another quantity. Nothing was changed.
- `SwapFailedError`: Picnic rejected a step; `rolledBack` says whether the cart is as before.
- `applySwaps` reports `applied`, `skipped` or `failed` per suggestion instead of throwing.
- `selectSwaps(plan)` picks one suggestion per line that can be applied together, and `previewSwaps(plan, selection)` estimates the total for any selection.

`saver.client` is the picnic-api client for everything else (delivery slots, checkout). Errors from Picnic are its `PicnicApiError` with `status` and `code`.

## Limits

- **Totals before a swap are estimates** from list prices and quantity discounts. Promotions and deposits of the new product only show once it is in the cart.
- **Picnic throttles.** An analysis costs one to three requests per cart line; after a few runs on a large cart Picnic refuses requests for some minutes. `findSavings` then returns what it has, with a warning.
- **A product on several lines** (on its own and in recipes): picnic-api reports its total quantity on each line; the library splits it by the line prices.
- **The API is unofficial** and can change at any time.

## Development

```sh
npm install
npm test                  # against an in-memory Picnic, no network
npm run typecheck
npm run build
npm run cli -- savings    # the CLI from source
```

## License

[MIT](LICENSE). Contains code adapted from picnic-api (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
