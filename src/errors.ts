/** Base class of the errors this library throws itself. Errors of picnic-api pass through as they are. */
export class PicnicSaverError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Thrown when a set of suggestions can't be combined: an unknown id, or two for the same cart line. */
export class InvalidSelectionError extends PicnicSaverError {}

/**
 * Thrown by `applySwap` when the cart no longer has the line the suggestion replaces, in the
 * quantity it was planned for. Nothing was changed; run `findSavings` again.
 */
export class StaleSuggestionError extends PicnicSaverError {
  constructor(
    readonly suggestionId: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Thrown by `applySwap` when Picnic rejects a step of the swap. `stage` says which one, and
 * `rolledBack` whether the cart is back in the state from before the swap.
 */
export class SwapFailedError extends PicnicSaverError {
  constructor(
    readonly suggestionId: string,
    readonly stage: "add" | "remove",
    readonly rolledBack: boolean,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
