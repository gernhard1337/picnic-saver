import type { PicnicClientLike } from "../src/index.js";

export interface FakeProduct {
  id: string;
  name: string;
  brand?: string;
  unitQuantity: string;
  /** Cents per package. */
  price: number;
  similar?: string[];
  priceRanges?: Array<{ price: number; from_quantity: number }>;
  maxCount?: number;
  unavailable?: boolean;
  recipeId?: string;
}

/** An in-memory Picnic with a catalog and a cart, shaped like the parts of picnic-api the library uses. */
export class FakePicnic {
  readonly products = new Map<string, FakeProduct>();
  readonly quantities = new Map<string, number>();
  readonly searchResults = new Map<string, string[]>();
  readonly calls: string[] = [];
  failAdd = false;
  failRemove: "never" | "once" | "always" = "never";
  failProductPages = new Set<string>();
  /** Fees and deposits on top of the lines. */
  extras = 0;
  authKey: string | null = "key";

  constructor(products: FakeProduct[], cart: Record<string, number> = {}) {
    for (const product of products) this.products.set(product.id, { ...product });
    for (const [id, quantity] of Object.entries(cart)) this.quantities.set(id, quantity);
  }

  private product(id: string): FakeProduct {
    const product = this.products.get(id);
    if (!product) throw new Error(`No product ${id}`);
    return product;
  }

  private linePrice(product: FakeProduct, quantity: number): number {
    const tier = (product.priceRanges ?? []).filter((range) => range.from_quantity <= quantity).sort((a, b) => a.price - b.price)[0];
    return Math.min(product.price, tier?.price ?? product.price) * quantity;
  }

  private cartSnapshot() {
    const items = [...this.quantities].map(([id, quantity]) => {
      const product = this.product(id);
      return {
        id: `line-${id}`,
        productId: id,
        name: product.name,
        unitQuantity: product.unitQuantity,
        imageId: null,
        quantity,
        maxCount: product.maxCount ?? 99,
        displayPrice: product.unavailable ? 0 : this.linePrice(product, quantity),
        priceRanges: product.priceRanges ?? null,
        isUnavailable: product.unavailable ?? false,
        recipeId: product.recipeId ?? null,
      };
    });
    return {
      id: "cart",
      items,
      totalCount: items.reduce((sum, item) => sum + item.quantity, 0),
      totalPrice: items.reduce((sum, item) => sum + item.displayPrice, 0) + this.extras,
    };
  }

  get client(): PicnicClientLike {
    const fake = this;
    const client = {
      get authKey() {
        return fake.authKey;
      },
      set authKey(value: string | null) {
        fake.authKey = value;
      },
      auth: {
        login: async () => ({ authKey: (fake.authKey = "key"), userId: "u1", secondFactorAuthenticationRequired: false, showSecondFactorAuthenticationIntro: false }),
        generate2FACode: async () => null,
        verify2FACode: async () => ({ authKey: "key-2fa" }),
        logout: async () => null,
      },
      cart: {
        getCart: async () => fake.cartSnapshot(),
        addProductToCart: async (id: string, count = 1) => {
          fake.calls.push(`add ${id} ${count}`);
          if (fake.failAdd) throw new Error("add rejected");
          const product = fake.product(id);
          fake.quantities.set(id, Math.min((fake.quantities.get(id) ?? 0) + count, product.maxCount ?? 99));
          return fake.cartSnapshot();
        },
        removeProductFromCart: async (id: string, count = 1) => {
          fake.calls.push(`remove ${id} ${count}`);
          if (fake.failRemove !== "never") {
            if (fake.failRemove === "once") fake.failRemove = "never";
            throw new Error("remove rejected");
          }
          const left = (fake.quantities.get(id) ?? 0) - count;
          if (left > 0) fake.quantities.set(id, left);
          else fake.quantities.delete(id);
          return fake.cartSnapshot();
        },
      },
      catalog: {
        getProduct: async (id: string) => {
          fake.calls.push(`product ${id}`);
          if (fake.failProductPages.has(id)) throw new Error("page broken");
          const product = fake.product(id);
          return {
            id,
            name: product.name,
            brand: product.brand ?? null,
            unitQuantity: product.unitQuantity,
            displayPrice: product.price,
            priceRanges: product.priceRanges ?? null,
            maxCount: product.maxCount ?? 99,
            imageIds: [],
            similarProducts: (product.similar ?? []).map((similarId) => {
              const similar = fake.product(similarId);
              return {
                id: similarId,
                name: similar.brand ? `${similar.brand} ${similar.name}` : similar.name,
                imageId: `img-${similarId}`,
                displayPrice: similar.price,
                unitQuantity: similar.unitQuantity,
                maxCount: similar.maxCount ?? 99,
                priceRanges: similar.priceRanges ?? null,
              };
            }),
          };
        },
        getSearchResults: async (query: string) => {
          fake.calls.push(`search ${query}`);
          const products = (fake.searchResults.get(query) ?? []).map((id) => {
            const product = fake.product(id);
            return {
              id,
              name: product.name,
              brand: product.brand ?? null,
              imageId: null,
              displayPrice: product.price,
              priceRanges: product.priceRanges ?? null,
              unitQuantity: product.unitQuantity,
              isUnavailable: product.unavailable ?? false,
            };
          });
          return { query, correctedQuery: null, recipes: [], products: { sections: [{ id: "all", type: "VISUAL", title: null, products }] } };
        },
      },
    };
    return client as unknown as PicnicClientLike;
  }
}
