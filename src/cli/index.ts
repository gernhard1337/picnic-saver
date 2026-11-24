import { resolve } from "node:path";
import { input, password } from "@inquirer/prompts";
import { Command, Option } from "commander";
import PicnicClient from "picnic-api";
import { PicnicSaverError } from "../errors.js";
import { PicnicSaver, type FindSavingsOptions } from "../saver.js";
import { printCleanup, runApply, type ApplyOptions } from "./apply.js";
import { isUnignoredInGit, readEnvFile, updateEnvFile } from "./env-file.js";
import { describeIgnoreRule, type IgnoreRule } from "../ignore.js";
import { formatCart, formatIgnored, formatPlan, money, style } from "./format.js";
import { addIgnoreRules, readIgnoreFile, removeIgnoreRules, writeIgnoreFile } from "./ignore-file.js";

type CountryCode = "DE" | "NL" | "FR";

interface GlobalOptions {
  envFile: string;
  ignoreFile: string;
  /** False with --no-ignore. */
  ignore: boolean;
  country?: CountryCode;
}

interface Session {
  envPath: string;
  env: Record<string, string | undefined>;
  countryCode: CountryCode;
}

/** Reads the .env file; variables of the real environment win over the file. */
function loadSession(options: GlobalOptions): Session {
  const envPath = resolve(options.envFile);
  const env = { ...readEnvFile(envPath), ...process.env };
  const countryCode = (options.country ?? env.PICNIC_COUNTRY_CODE?.toUpperCase() ?? "DE") as CountryCode;
  if (!["DE", "NL", "FR"].includes(countryCode)) throw new PicnicSaverError(`Unknown country "${countryCode}". Use DE, NL or FR.`);
  return { envPath, env, countryCode };
}

function loggedInSaver(options: GlobalOptions): PicnicSaver {
  const session = loadSession(options);
  const authKey = session.env.PICNIC_AUTH_KEY;
  if (!authKey) throw new PicnicSaverError('Not logged in. Run "picnic-saver login" first.');
  return new PicnicSaver({ countryCode: session.countryCode, authKey, ignore: options.ignore ? readIgnoreFile(resolve(options.ignoreFile)) : [] });
}

function requireTerminal(what: string): void {
  if (!process.stdin.isTTY) throw new PicnicSaverError(`Can't ask for ${what} without an interactive terminal.`);
}

async function login(options: GlobalOptions & { email?: string }): Promise<void> {
  const session = loadSession(options);
  let email = options.email;
  if (!email) {
    requireTerminal("the e-mail address (pass --email)");
    email = await input({ message: "Picnic e-mail:", default: session.env.PICNIC_EMAIL || undefined, required: true });
  }
  let secret = process.env.PICNIC_PASSWORD;
  if (!secret) {
    requireTerminal("the password (set PICNIC_PASSWORD)");
    secret = await password({ message: "Password:", mask: true });
  }

  const saver = new PicnicSaver({ countryCode: session.countryCode });
  let { authKey, secondFactorRequired } = await saver.login(email, secret);
  if (secondFactorRequired) {
    requireTerminal("the two-factor code");
    await saver.requestTwoFactorCode();
    const code = await input({ message: "Code from the SMS Picnic sent you:", required: true });
    ({ authKey } = await saver.verifyTwoFactorCode(code.trim()));
  }

  updateEnvFile(session.envPath, { PICNIC_AUTH_KEY: authKey, PICNIC_COUNTRY_CODE: session.countryCode });
  console.log(`Logged in. The auth key is saved in ${session.envPath}; your password is not stored.`);
  if (isUnignoredInGit(session.envPath)) console.log(style("yellow", "Warning: this file is not in your .gitignore. Add it before you commit."));
  if (process.env.PICNIC_AUTH_KEY && process.env.PICNIC_AUTH_KEY !== authKey) {
    console.log(style("yellow", "Warning: PICNIC_AUTH_KEY is also set in your shell and overrides the file. Unset it to use the new login."));
  }
}

async function logout(options: GlobalOptions): Promise<void> {
  const session = loadSession(options);
  const authKey = session.env.PICNIC_AUTH_KEY;
  if (authKey) {
    try {
      await new PicnicSaver({ countryCode: session.countryCode, authKey }).logout();
    } catch (error) {
      // An expired key can't be logged out, and doesn't need to be.
      if (!PicnicClient.isPicnicApiError(error)) throw error;
    }
  }
  updateEnvFile(session.envPath, { PICNIC_AUTH_KEY: null });
  console.log(`Logged out. The auth key is removed from ${session.envPath}.`);
}

interface SavingsOptions extends GlobalOptions {
  search: boolean;
  /** False with --no-recipes. */
  recipes: boolean;
  json?: boolean;
}

function findOptions(options: SavingsOptions): FindSavingsOptions {
  return { sources: options.search ? ["similar", "search"] : ["similar"], includeRecipeItems: options.recipes };
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function formatTotal(before: number, after: number): string {
  return `${money(before)} → ${style("bold", money(after))}`;
}

function explain(error: unknown): string {
  if (PicnicClient.isPicnicApiError(error)) {
    if (error.code === "AUTH_INVALID_CRED") return "Wrong e-mail address or password.";
    if (error.code === "OTP_NOT_VALID") return "That code is not valid.";
    if (error.status === 401) return 'Your login has expired. Run "picnic-saver login" again.';
    return `Picnic answered with an error (${error.status}${error.code ? ` ${error.code}` : ""}).`;
  }
  return error instanceof Error ? error.message : String(error);
}

const program = new Command()
  .name("picnic-saver")
  .description("Find cheaper alternatives for the products in your Picnic cart and swap them.")
  .option("--env-file <path>", "the .env file that holds the login", ".env")
  .option("--ignore-file <path>", "the JSON file with products you never want in your cart", "picnic-saver.ignore.json")
  .option("--no-ignore", "leave the ignore list out for this run")
  .addOption(new Option("--country <code>", "the country of your Picnic account (default: PICNIC_COUNTRY_CODE or DE)").choices(["DE", "NL", "FR"]));

program
  .command("login")
  .description("log in and save the auth key in the .env file")
  .option("--email <address>", "the e-mail address of your Picnic account")
  .action((_options, command: Command) => login(command.optsWithGlobals()));

program
  .command("logout")
  .description("log out and remove the auth key from the .env file")
  .action((_options, command: Command) => logout(command.optsWithGlobals()));

program
  .command("cart")
  .description("show the cart and its total")
  .option("--json", "print JSON")
  .action(async (_options, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions & { json?: boolean }>();
    const cart = await loggedInSaver(options).getCart();
    console.log(options.json ? JSON.stringify(cart, null, 2) : formatCart(cart));
  });

const savingsOptions = (command: Command): Command =>
  command.option("--no-search", "only use the similar products Picnic lists, no search results").option("--no-recipes", "leave products that belong to a recipe as they are").option("--json", "print JSON");

savingsOptions(program.command("savings"))
  .description("show cheaper alternatives, duplicates and the estimated new total; changes nothing")
  .action(async (_options, command: Command) => {
    const options = command.optsWithGlobals<SavingsOptions>();
    const plan = await loggedInSaver(options).findSavings(findOptions(options));
    console.log(options.json ? JSON.stringify(plan, null, 2) : formatPlan(plan));
  });

savingsOptions(program.command("apply"))
  .description("swap products for cheaper alternatives: all at once, or asked one by one")
  .option("--all", "swap the cheapest suggestion of every product without asking (leaves out search results)")
  .option("--only <ids...>", "swap only the suggestions with these ids, without asking")
  .option("--include-search", "let --all also swap suggestions that come from search results")
  .option("--consolidate", "let --all also use the suggestions that merge duplicates")
  .option("--dry-run", "show what would happen without changing the cart")
  .action(async (_options, command: Command) => {
    const options = command.optsWithGlobals<SavingsOptions & ApplyOptions>();
    await runApply(loggedInSaver(options), findOptions(options), options);
  });

program
  .command("clean")
  .description("remove the products on your ignore list from the cart")
  .option("--dry-run", "show what would be removed without changing the cart")
  .option("--json", "print JSON")
  .action(async (_options, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions & { dryRun?: boolean; json?: boolean }>();
    const saver = loggedInSaver(options);
    if (options.dryRun) {
      const ignored = (await saver.getCart()).items.filter((item) => item.ignored);
      if (options.json) return console.log(JSON.stringify({ dryRun: true, wouldRemove: ignored }, null, 2));
      return console.log(ignored.length > 0 ? formatIgnored(ignored, "Would remove") : "Nothing on your ignore list is in the cart.");
    }
    const cleanup = await saver.removeIgnored();
    if (options.json) return console.log(JSON.stringify(cleanup, null, 2));
    if (cleanup.removed.length + cleanup.failed.length === 0) return console.log("Nothing on your ignore list is in the cart.");
    printCleanup(cleanup);
    console.log(`Total: ${formatTotal(cleanup.previousTotal, cleanup.newTotal)}`);
  });

const ignore = program.command("ignore").description("manage the list of products you never want in your cart");

ignore
  .command("list", { isDefault: true })
  .description("show the ignore list")
  .option("--json", "print JSON")
  .action((_options, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions & { json?: boolean }>();
    const path = resolve(options.ignoreFile);
    const rules = readIgnoreFile(path);
    if (options.json) return console.log(JSON.stringify({ ignore: rules }, null, 2));
    if (rules.length === 0) return console.log(`The ignore list is empty. Add a product with: picnic-saver ignore add "Petersilie"`);
    console.log(style("bold", `Ignore list (${path})`));
    for (const rule of rules) console.log(`  ${describeIgnoreRule(rule)}${typeof rule !== "string" && rule.note ? style("dim", `  ${rule.note}`) : ""}`);
  });

ignore
  .command("add [names...]")
  .description("ignore products by name (all words must be in the product name) or by product id")
  .option("--id <id>", "a product id, as shown by 'cart --json'; repeat for more", collect, [])
  .option("--note <text>", "a note to store with the new entries")
  .action((names: string[], _options, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions & { id?: string[]; note?: string }>();
    const path = resolve(options.ignoreFile);
    const note = options.note ? { note: options.note } : {};
    const additions: IgnoreRule[] = [...names.map((name) => (options.note ? { name, ...note } : name)), ...(options.id ?? []).map((productId) => ({ productId, ...note }))];
    if (additions.length === 0) throw new PicnicSaverError("Give at least one name or --id.");
    const { rules, added } = addIgnoreRules(readIgnoreFile(path), additions);
    writeIgnoreFile(path, rules);
    console.log(added.length > 0 ? `Added to ${path}: ${added.map(describeIgnoreRule).join(", ")}` : "Already on the ignore list.");
  });

ignore
  .command("remove [names...]")
  .description("take products off the ignore list")
  .option("--id <id>", "a product id; repeat for more", collect, [])
  .action((names: string[], _options, command: Command) => {
    const options = command.optsWithGlobals<GlobalOptions & { id?: string[] }>();
    const path = resolve(options.ignoreFile);
    const { rules, removed } = removeIgnoreRules(readIgnoreFile(path), names, options.id ?? []);
    if (removed.length === 0) return console.log("No such entry on the ignore list.");
    writeIgnoreFile(path, rules);
    console.log(`Removed from ${path}: ${removed.map(describeIgnoreRule).join(", ")}`);
  });

program.parseAsync().catch((error: unknown) => {
  // Ctrl+C in a prompt.
  if (error instanceof Error && error.name === "ExitPromptError") process.exit(130);
  console.error(style("red", explain(error)));
  process.exit(1);
});
