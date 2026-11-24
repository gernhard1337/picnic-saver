import type PicnicClient from "picnic-api";
import type { IgnoreRule } from "./ignore.js";

/** The base unit two products are compared in: per kilogram, per litre or per piece. */
export type ComparisonUnit = "kg" | "l" | "piece";

/** A package size as an amount of a base unit: "400 g" is `{ amount: 0.4, unit: "kg" }`. */
export interface PackageSize {
  amount: number;
  unit: ComparisonUnit;
}

/** A price per kilogram, litre or piece, in cents. */
export interface BasePrice {
  unit: ComparisonUnit;
  /** Cents per unit, e.g. 109 for €1.09/l. */
  price: number;
}

/** A quantity discount: from `fromQuantity` packages on, every package costs `price` cents. */
export interface PriceTier {
  price: number;
  fromQuantity: number;
}

/** One line of the cart. All amounts are in cents. */
export interface CartItem {
  /** Picnic's id of the cart line. */
  lineId: string;
  /** The product id, e.g. "s1001524". */
  productId: string;
  name: string;
  /** The package size as Picnic shows it, e.g. "500 g". */
  unitQuantity: string;
  /** The number of packages. */
  quantity: number;
  /** What the line costs, after discounts. */
  linePrice: number;
  /** `linePrice` divided by `quantity`. */
  unitPrice: number;
  /** The parsed package size, or null when it has no weight, volume or piece count. */
  packageSize: PackageSize | null;
  /** What is paid per kilogram, litre or piece, or null when `packageSize` is null. */
  basePrice: BasePrice | null;
  priceTiers: PriceTier[];
  imageId: string | null;
  /** True when Picnic can't deliver the product in the selected slot. */
  isUnavailable: boolean;
  /** The recipe the line belongs to, or null. */
  recipeId: string | null;
  /** True when the product is on the ignore list ({@link IgnoreRule}). */
  ignored: boolean;
}

/** The cart with its total. All amounts are in cents. */
export interface CartSummary {
  id: string;
  items: CartItem[];
  /** The number of packages in the cart. */
  totalCount: number;
  /** The amount to pay as Picnic reports it, including deposits and fees. */
  totalPrice: number;
  /** The sum of the line prices, without deposits and fees. */
  itemsTotal: number;
}

/**
 * Where a suggestion comes from. `"similar"` are the similar products Picnic lists on the product
 * page, `"search"` are search results for the product name, which are less reliable, and
 * `"duplicate"` is another line of the cart ({@link DuplicateGroup}). Custom sources use their
 * own name.
 */
export type SuggestionSource = "similar" | "search" | "duplicate" | (string & {});

/** A product an {@link AlternativeSource} offers instead of a cart item. */
export interface AlternativeCandidate {
  productId: string;
  name: string;
  unitQuantity: string;
  /** The price of one package in cents. */
  unitPrice: number;
  priceTiers?: PriceTier[];
  /** The most packages the cart accepts. Default: 99. */
  maxCount?: number;
  imageId?: string | null;
  source: SuggestionSource;
}

/** What the product page says about a product in the cart. */
export interface ProductInfo {
  productId: string;
  /** The name without the brand. */
  name: string;
  brand: string | null;
  unitQuantity: string;
  /** The price of one package in cents. */
  unitPrice: number;
  priceTiers: PriceTier[];
  maxCount: number;
  imageId: string | null;
  /** The ids of the similar products Picnic lists on the product page. */
  similarProductIds: string[];
}

/** What a suggestion replaces: a cart line as it was when the plan was made. */
export interface SwapFrom {
  lineId: string;
  productId: string;
  name: string;
  unitQuantity: string;
  quantity: number;
  linePrice: number;
  basePrice: BasePrice;
  recipeId: string | null;
}

/** What a suggestion puts in the cart instead. */
export interface SwapTo {
  productId: string;
  name: string;
  unitQuantity: string;
  /** The number of packages that covers at least the amount of the replaced line. */
  quantity: number;
  /** The estimated cost of these packages. */
  linePrice: number;
  basePrice: BasePrice;
  imageId: string | null;
  /** True when the product is in the cart already; applying the suggestion raises its quantity. */
  alreadyInCart: boolean;
}

/**
 * A suggestion to replace one cart line by another product that costs less per kilogram, litre or
 * piece. It is plain JSON: send it to a frontend and pass it back to {@link PicnicSaver.applySwap}.
 */
export interface SwapSuggestion {
  /** Unique within its plan. */
  id: string;
  /**
   * `"alternative"` is a cheaper product for one cart line; `"consolidate"` moves a duplicate
   * onto the cheapest product of its {@link DuplicateGroup}. The two can describe the same swap.
   */
  kind: "alternative" | "consolidate";
  source: SuggestionSource;
  from: SwapFrom;
  to: SwapTo;
  /** How much less the new product costs per kilogram, litre or piece, in cents. Always positive. */
  savingPerUnit: number;
  /**
   * The estimated change of the line price: `to.linePrice - from.linePrice`. Negative is a saving.
   * It can be positive when the cheaper product only comes in a larger package.
   */
  linePriceDelta: number;
  /** True when `linePriceDelta` is positive. */
  increasesLinePrice: boolean;
}

/** Why no suggestions were looked up for a cart line. */
export type SkipReason = "ignored" | "unavailable" | "recipe" | "no-comparable-size";

/** The suggestions for one cart line. */
export interface LineSavings {
  item: CartItem;
  /** Why the line was left out, or null when it was checked. */
  skipped: SkipReason | null;
  /** All suggestions, cheapest per unit first. */
  suggestions: SwapSuggestion[];
  /** The cheapest suggestion per unit, or null without suggestions. */
  recommended: SwapSuggestion | null;
}

/** A cart line in a {@link DuplicateGroup}. */
export interface DuplicateItem {
  lineId: string;
  productId: string;
  name: string;
  unitQuantity: string;
  quantity: number;
  linePrice: number;
  basePrice: BasePrice | null;
}

/**
 * Cart lines that are the same kind of product at different prices, e.g. milk and organic milk.
 */
export interface DuplicateGroup {
  id: string;
  /**
   * `"high"` when the names match and Picnic lists the products as similar, `"medium"` when only
   * the names match.
   */
  confidence: "high" | "medium";
  /** What links the lines. */
  reasons: Array<"similar-products" | "name-match">;
  /** The lines, cheapest per unit first; lines without a base price come last. */
  items: DuplicateItem[];
  /** The cheapest product per unit, or null when the lines can't be compared. */
  cheapestProductId: string | null;
  /** The difference between the highest and the lowest base price, or null. */
  basePriceSpread: BasePrice | null;
  /** One suggestion per more expensive line that moves it onto the cheapest product. */
  consolidation: SwapSuggestion[];
  /** The estimated saving in cents when all of `consolidation` is applied. */
  potentialSaving: number;
}

/** The effect of a set of suggestions on the cart total. All amounts are in cents. */
export interface SwapPreview {
  suggestionIds: string[];
  currentTotal: number;
  /**
   * The estimated total after the swaps. An estimate: Picnic has no dry run, so promotions and
   * deposits of the new products are only known once they are in the cart.
   */
  estimatedTotal: number;
  /** `currentTotal - estimatedTotal`. Negative when larger packages make the cart cost more. */
  estimatedSaving: number;
}

/** The result of {@link PicnicSaver.findSavings}. Plain JSON. */
export interface SavingsPlan {
  /** ISO timestamp. */
  createdAt: string;
  cart: CartSummary;
  /** One entry per cart line, in cart order. */
  lines: LineSavings[];
  /** The recommended suggestion of every line that has one. */
  suggestions: SwapSuggestion[];
  duplicates: DuplicateGroup[];
  /**
   * The cart lines on the ignore list. They get no suggestions and are left out of `duplicates`;
   * {@link PicnicSaver.removeIgnored} takes them out of the cart.
   */
  ignored: CartItem[];
  /** The preview for all of `suggestions`. */
  summary: SwapPreview;
  /** Problems that didn't stop the analysis, e.g. a product page that couldn't be read. */
  warnings: string[];
}

/** The outcome of one suggestion in {@link PicnicSaver.applySwaps}. */
export type SwapOutcome =
  | { suggestionId: string; status: "applied" }
  /** The cart no longer has the line as the suggestion expects it. Nothing was changed. */
  | { suggestionId: string; status: "skipped"; reason: string }
  | { suggestionId: string; status: "failed"; reason: string };

/** The result of {@link PicnicSaver.applySwap}. */
export interface SwapResult {
  suggestionId: string;
  /** The cart after the swap, as Picnic reports it. */
  cart: CartSummary;
  previousTotal: number;
  newTotal: number;
  /** `previousTotal - newTotal`: the real change, including promotions and deposits. */
  actualSaving: number;
}

/** The result of {@link PicnicSaver.applySwaps}. */
export interface SwapsResult {
  outcomes: SwapOutcome[];
  cart: CartSummary;
  previousTotal: number;
  newTotal: number;
  actualSaving: number;
}

/** The result of {@link PicnicSaver.removeIgnored}. */
export interface RemoveIgnoredResult {
  /** The lines that were taken out of the cart. */
  removed: CartItem[];
  /** The lines Picnic refused to remove. */
  failed: Array<{ item: CartItem; reason: string }>;
  /** The cart afterwards. */
  cart: CartSummary;
  previousTotal: number;
  newTotal: number;
}

/** The result of {@link PicnicSaver.login}. */
export interface LoginResult {
  /** Store this to skip the login next time. */
  authKey: string;
  userId: string;
  /** True when the login only completes after {@link PicnicSaver.verifyTwoFactorCode}. */
  secondFactorRequired: boolean;
}

type PicnicCart = PicnicClient.Types.cart.Cart;
type PicnicCatalog = PicnicClient["catalog"];

/**
 * The part of a picnic-api client this library uses. A `PicnicClient` satisfies it; tests can
 * pass a stub.
 */
export interface PicnicClientLike {
  authKey: string | null;
  auth: {
    login(username: string, password: string): Promise<PicnicClient.Types.auth.LoginResult>;
    generate2FACode(channel: string): Promise<unknown>;
    verify2FACode(code: string): Promise<PicnicClient.Types.auth.Verify2FAResult>;
    logout(): Promise<unknown>;
  };
  cart: {
    getCart(): Promise<PicnicCart>;
    addProductToCart(productId: string, count?: number): Promise<PicnicCart>;
    removeProductFromCart(productId: string, count?: number): Promise<PicnicCart>;
  };
  catalog: {
    getProduct: PicnicCatalog["getProduct"];
    getSearchResults: PicnicCatalog["getSearchResults"];
  };
}
