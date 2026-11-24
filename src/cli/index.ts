import { resolve } from "node:path";
import { input, password } from "@inquirer/prompts";
import { Command, Option } from "commander";
import PicnicClient from "picnic-api";
import { PicnicSaverError } from "../errors.js";
import { PicnicSaver, type FindSavingsOptions } from "../saver.js";
import { runApply, type ApplyOptions } from "./apply.js";
import { isUnignoredInGit, readEnvFile, updateEnvFile } from "./env-file.js";
import { formatCart, formatPlan, style } from "./format.js";

type CountryCode = "DE" | "NL" | "FR";

interface GlobalOptions {
  envFile: string;
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
  return new PicnicSaver({ countryCode: session.countryCode, authKey });
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
  includeRecipes?: boolean;
  json?: boolean;
}

function findOptions(options: SavingsOptions): FindSavingsOptions {
  return { sources: options.search ? ["similar", "search"] : ["similar"], includeRecipeItems: options.includeRecipes };
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
  command.option("--no-search", "only use the similar products Picnic lists, no search results").option("--include-recipes", "also check products that belong to a recipe").option("--json", "print JSON");

savingsOptions(program.command("savings"))
  .description("show cheaper alternatives, duplicates and the estimated new total; changes nothing")
  .action(async (_options, command: Command) => {
    const options = command.optsWithGlobals<SavingsOptions>();
    const plan = await loggedInSaver(options).findSavings(findOptions(options));
    console.log(options.json ? JSON.stringify(plan, null, 2) : formatPlan(plan));
  });

savingsOptions(program.command("apply"))
  .description("swap products for cheaper alternatives: all at once, or asked one by one")
  .option("--all", "swap all suggestions without asking (leaves out search results and duplicates)")
  .option("--only <ids...>", "swap only the suggestions with these ids, without asking")
  .option("--include-search", "let --all also swap suggestions that come from search results")
  .option("--consolidate", "let --all also move duplicates onto the cheapest product")
  .option("--dry-run", "show what would happen without changing the cart")
  .action(async (_options, command: Command) => {
    const options = command.optsWithGlobals<SavingsOptions & ApplyOptions>();
    const saver = loggedInSaver(options);
    await runApply(saver, await saver.findSavings(findOptions(options)), options);
  });

program.parseAsync().catch((error: unknown) => {
  // Ctrl+C in a prompt.
  if (error instanceof Error && error.name === "ExitPromptError") process.exit(130);
  console.error(style("red", explain(error)));
  process.exit(1);
});
