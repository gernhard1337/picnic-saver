import PicnicClient from "picnic-api";
import { searchSource } from "./alternatives/search.js";
import { similarProductsSource } from "./alternatives/similar.js";
import type { AlternativeSource } from "./alternatives/source.js";
import { applySwap, applySwaps, removeIgnored, type ApplySwapsOptions } from "./apply.js";
import { toCartSummary, toPriceTiers } from "./cart.js";
import { PicnicSaverError } from "./errors.js";
import { matchIgnoreRule, type IgnoreRule } from "./ignore.js";
import { buildSavingsPlan, skipReason, type PlanOptions } from "./savings.js";
import type { AlternativeCandidate, CartSummary, LoginResult, PicnicClientLike, ProductInfo, RemoveIgnoredResult, SavingsPlan, SwapResult, SwapSuggestion, SwapsResult } from "./types.js";

type PicnicProduct = PicnicClient.Types.catalog.Product;

export interface PicnicSaverOptions {
  /** The country of the Picnic account. Default: "DE". Ignored when `client` is given. */
  countryCode?: "DE" | "NL" | "FR";
  /** An auth key from an earlier {@link PicnicSaver.login}, to skip the login. Ignored when `client` is given. */
  authKey?: string;
  /** An existing picnic-api client to use instead of creating one. */
  client?: PicnicClientLike;
  /**
   * Products that should never be in the cart, e.g. `["Petersilie", { productId: "s1001524" }]`.
   * They are flagged in the cart and the plan, and {@link PicnicSaver.removeIgnored} removes them.
   */
  ignore?: IgnoreRule[];
}

export interface FindSavingsOptions extends PlanOptions {
  /**
   * Where alternatives come from, in order of preference: `"similar"` (the similar products on
   * the product page), `"search"` (search results for the product name) or your own
   * {@link AlternativeSource}. Default: `["similar", "search"]`.
   */
  sources?: Array<"similar" | "search" | AlternativeSource>;
  /** How many requests to Picnic run at the same time. Default: 4. */
  concurrency?: number;
}

/**
 * Finds cheaper alternatives for the products in a Picnic cart and swaps them.
 *
 * @example
 * const saver = new PicnicSaver({ countryCode: "DE" });
 * await saver.login("me@example.com", "secret");
 * const plan = await saver.findSavings();
 * console.log(plan.summary.estimatedSaving);
 * await saver.applySwap(plan.suggestions[0]);
 */
export class PicnicSaver {
  /**
   * The picnic-api client behind this instance, for everything this library doesn't cover
   * (delivery slots, checkout, ...). It is a full `PicnicClient` unless you passed your own stub.
   */
  readonly client: PicnicClientLike;

  /** The ignore list. Assign a new list to change it; the next call uses it. */
  ignore: IgnoreRule[];

  constructor(options: PicnicSaverOptions = {}) {
    this.ignore = options.ignore ?? [];
    this.client = options.client ?? new PicnicClient({ countryCode: options.countryCode ?? "DE", ...(options.authKey && { authKey: options.authKey }) });
  }

  /** The auth key of the session, or null before the login. Store it to skip the login next time. */
  get authKey(): string | null {
    return this.client.authKey;
  }

  /**
   * Logs in with the e-mail address and password of the Picnic account. When
   * `secondFactorRequired` is true, call {@link requestTwoFactorCode} and
   * {@link verifyTwoFactorCode} before anything else.
   * @throws picnic-api's `PicnicApiError` with code `AUTH_INVALID_CRED` for wrong credentials.
   */
  async login(email: string, password: string): Promise<LoginResult> {
    const result = await this.client.auth.login(email, password);
    return { authKey: result.authKey, userId: result.userId, secondFactorRequired: result.secondFactorAuthenticationRequired };
  }

  /** Has Picnic send a two-factor code. `"SMS"` is the only channel known to work. */
  async requestTwoFactorCode(channel: string = "SMS"): Promise<void> {
    await this.client.auth.generate2FACode(channel);
  }

  /**
   * Completes the login with the two-factor code and returns the final auth key.
   * @throws picnic-api's `PicnicApiError` with code `OTP_NOT_VALID` for a wrong code.
   */
  async verifyTwoFactorCode(code: string): Promise<{ authKey: string }> {
    return this.client.auth.verify2FACode(code);
  }

  /** Logs out. The auth key is no longer valid afterwards. */
  async logout(): Promise<void> {
    await this.client.auth.logout();
    this.client.authKey = null;
  }

  /** Returns the cart with its lines and the total to pay. Lines on the ignore list have `ignored: true`. */
  async getCart(): Promise<CartSummary> {
    return toCartSummary(await this.client.cart.getCart(), this.ignore);
  }

  /**
   * Takes every product on the ignore list out of the cart, also when a recipe put it there.
   * Nothing else changes the cart on its own: `getCart` and `findSavings` only flag these lines.
   */
  async removeIgnored(): Promise<RemoveIgnoredResult> {
    this.assertLoggedIn();
    return removeIgnored(this.client, this.ignore);
  }

  /**
   * Checks every line of the cart for products that cost less per kilogram, litre or piece, and
   * for lines that are the same kind of product at different prices. Reads the cart and one
   * product page per line (plus a search per line with the `"search"` source); the cart is not
   * changed. Lines on the ignore list are not checked and listed in `plan.ignored`.
   *
   * A product page or a source that fails doesn't stop the analysis; it ends up in
   * `plan.warnings`.
   */
  async findSavings(options: FindSavingsOptions = {}): Promise<SavingsPlan> {
    const sources = (options.sources ?? ["similar", "search"]).map((source) => (source === "similar" ? similarProductsSource() : source === "search" ? searchSource() : source));
    const concurrency = options.concurrency ?? 4;
    const warnings: string[] = [];
    const cart = await this.getCart();

    const pages = new Map<string, PicnicProduct>();
    const productIds = [...new Set(cart.items.filter((item) => !item.isUnavailable && !item.ignored).map((item) => item.productId))];
    await mapLimit(productIds, concurrency, async (productId) => {
      try {
        pages.set(productId, await this.client.catalog.getProduct(productId));
      } catch (error) {
        warnings.push(`Could not read the product page of ${productId}: ${message(error)}`);
      }
    });

    const candidates: Record<string, AlternativeCandidate[]> = {};
    const eligible = cart.items.filter((item) => skipReason(item, options) === null);
    await mapLimit(eligible, concurrency, async (item) => {
      const found: AlternativeCandidate[] = [];
      for (const source of sources) {
        try {
          const results = await source.find({ item, product: pages.get(item.productId) ?? null, client: this.client });
          found.push(...results.filter((candidate) => !matchIgnoreRule(candidate, this.ignore)).map((candidate) => ({ ...candidate, source: source.name })));
        } catch (error) {
          warnings.push(`Source "${source.name}" failed for "${item.name}": ${message(error)}`);
        }
      }
      candidates[item.lineId] = found;
    });

    const products: Record<string, ProductInfo> = {};
    for (const [productId, page] of pages) products[productId] = toProductInfo(page);
    return buildSavingsPlan({ cart, candidates, products, warnings, options });
  }

  /**
   * Applies one suggestion: adds the new product, then removes the old one. Returns the cart
   * with the real total afterwards.
   *
   * Suggestions are independent, so a UI can apply them one at a time in any order; each call
   * checks only the cart line of its own suggestion.
   * @throws {StaleSuggestionError} When that line changed since the plan was made. Nothing was changed.
   * @throws {SwapFailedError} When Picnic rejects a step; `rolledBack` says whether the cart is as before.
   */
  async applySwap(suggestion: SwapSuggestion): Promise<SwapResult> {
    this.assertLoggedIn();
    return applySwap(this.client, suggestion, { ignore: this.ignore });
  }

  /**
   * Applies several suggestions one after another. Stale and failed suggestions are reported in
   * `outcomes` instead of thrown; other errors (no connection, an expired login) are thrown.
   */
  async applySwaps(suggestions: SwapSuggestion[], options?: ApplySwapsOptions): Promise<SwapsResult> {
    this.assertLoggedIn();
    return applySwaps(this.client, suggestions, { ignore: this.ignore, ...options });
  }

  private assertLoggedIn(): void {
    if (!this.client.authKey) throw new PicnicSaverError("Not logged in. Call login() or pass an authKey.");
  }
}

function toProductInfo(page: PicnicProduct): ProductInfo {
  return {
    productId: page.id,
    name: page.name,
    brand: page.brand,
    unitQuantity: page.unitQuantity,
    unitPrice: page.displayPrice,
    priceTiers: toPriceTiers(page.priceRanges),
    maxCount: page.maxCount,
    imageId: page.imageIds[0] ?? null,
    similarProductIds: page.similarProducts.map((similar) => similar.id),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs `task` for every item with at most `limit` running at once. */
async function mapLimit<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}
