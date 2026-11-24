import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { selectSuggestions } from "../src/cli/apply.js";
import { isUnignoredInGit, readEnvFile, updateEnvFile } from "../src/cli/env-file.js";
import { addIgnoreRules, readIgnoreFile, removeIgnoreRules, writeIgnoreFile } from "../src/cli/ignore-file.js";
import { PicnicSaver } from "../src/index.js";
import { FakePicnic } from "./fake-picnic.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "picnic-saver-"));
}

describe(".env file", () => {
  it("updates a variable and keeps every other line", () => {
    const path = join(tempDir(), ".env");
    writeFileSync(path, "# mine\nOTHER=1\nPICNIC_AUTH_KEY=old\n\nexport LAST=x\n");
    updateEnvFile(path, { PICNIC_AUTH_KEY: "new.key-1==", PICNIC_COUNTRY_CODE: "DE" });
    expect(readFileSync(path, "utf8")).toBe("# mine\nOTHER=1\nPICNIC_AUTH_KEY=new.key-1==\n\nexport LAST=x\nPICNIC_COUNTRY_CODE=DE\n");
    expect(readEnvFile(path)).toMatchObject({ OTHER: "1", PICNIC_AUTH_KEY: "new.key-1==", LAST: "x" });
  });

  it("removes a variable and creates a missing file for the owner only", () => {
    const path = join(tempDir(), ".env");
    expect(readEnvFile(path)).toEqual({});
    updateEnvFile(path, { PICNIC_AUTH_KEY: "a b" });
    expect(readEnvFile(path)).toEqual({ PICNIC_AUTH_KEY: "a b" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    updateEnvFile(path, { PICNIC_AUTH_KEY: null });
    expect(readFileSync(path, "utf8")).toBe("\n");
  });

  it("notices a .env that git would pick up", () => {
    const directory = tempDir();
    const path = join(directory, ".env");
    expect(isUnignoredInGit(path)).toBe(false);
    mkdirSync(join(directory, ".git"));
    expect(isUnignoredInGit(path)).toBe(true);
    writeFileSync(join(directory, ".gitignore"), "node_modules/\n.env\n");
    expect(isUnignoredInGit(path)).toBe(false);
  });
});

describe("selectSuggestions", () => {
  async function plan() {
    const fake = new FakePicnic(
      [
        { id: "pasta", name: "Spaghetti", unitQuantity: "500 g", price: 199, similar: ["pasta-own"] },
        { id: "pasta-own", name: "Spaghetti", unitQuantity: "500 g", price: 89 },
        { id: "rice", name: "Reis", unitQuantity: "1 kg", price: 300 },
        { id: "rice-cheap", name: "Reis", unitQuantity: "1 kg", price: 200 },
        { id: "milk", name: "Vollmilch", unitQuantity: "1 l", price: 109, similar: ["milk-bio"] },
        { id: "milk-bio", name: "Bio Vollmilch", unitQuantity: "1 l", price: 145 },
      ],
      { pasta: 1, rice: 1, milk: 1, "milk-bio": 1 },
    );
    fake.searchResults.set("Reis", ["rice-cheap"]);
    return new PicnicSaver({ client: fake.client }).findSavings();
  }
  const ids = (suggestions: Array<{ id: string }>) => suggestions.map((suggestion) => suggestion.id);

  it("leaves search results and duplicates out of --all", async () => {
    expect(ids(selectSuggestions(await plan(), { all: true }))).toEqual(["pasta:pasta-own"]);
  });

  it("adds them on request", async () => {
    expect(ids(selectSuggestions(await plan(), { all: true, includeSearch: true, consolidate: true }))).toEqual(["pasta:pasta-own", "rice:rice-cheap", "milk-bio:milk"]);
  });

  it("resolves --only ids and rejects unknown ones", async () => {
    expect(ids(selectSuggestions(await plan(), { only: ["milk-bio:milk"] }))).toEqual(["milk-bio:milk"]);
    await expect(plan().then((result) => selectSuggestions(result, { only: ["x"] }))).rejects.toThrow(/Unknown suggestion "x"/);
  });
});

describe("ignore file", () => {
  it("reads a missing file as an empty list and round-trips rules", () => {
    const path = join(tempDir(), "ignore.json");
    expect(readIgnoreFile(path)).toEqual([]);
    writeIgnoreFile(path, ["Petersilie", { productId: "s1" }]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ignore: ["Petersilie", { productId: "s1" }] });
    expect(readIgnoreFile(path)).toEqual(["Petersilie", { productId: "s1" }]);
  });

  it("names the file when it is broken", () => {
    const path = join(tempDir(), "ignore.json");
    writeFileSync(path, "{ nope");
    expect(() => readIgnoreFile(path)).toThrow(path);
  });

  it("adds without duplicates and removes by name or id", () => {
    const { rules, added } = addIgnoreRules(["Petersilie"], ["petersilie ", "Dill", { productId: "s1" }, { productId: "s1" }]);
    expect(rules).toEqual(["Petersilie", "Dill", { productId: "s1" }]);
    expect(added).toEqual(["Dill", { productId: "s1" }]);
    expect(removeIgnoreRules(rules, ["DILL"], ["s1"])).toEqual({ rules: ["Petersilie"], removed: ["Dill", { productId: "s1" }] });
  });
});
