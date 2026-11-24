// Shared by the examples: a PicnicSaver for the account in PICNIC_AUTH_KEY.
import { PicnicSaver, type IgnoreRule } from "../src/index.js";

export function createSaver(ignore: IgnoreRule[] = []): PicnicSaver {
  const authKey = process.env.PICNIC_AUTH_KEY;
  if (!authKey) {
    console.error("PICNIC_AUTH_KEY is not set. Run examples/login.ts, or `picnic-saver login` and start the example with --env-file=.env.");
    process.exit(1);
  }
  const countryCode = (process.env.PICNIC_COUNTRY_CODE ?? "DE") as "DE" | "NL" | "FR";
  return new PicnicSaver({ countryCode, authKey, ignore });
}

/** 1234 → "€12.34". */
export function euro(cents: number): string {
  return `${cents < 0 ? "-" : ""}€${(Math.abs(cents) / 100).toFixed(2)}`;
}
