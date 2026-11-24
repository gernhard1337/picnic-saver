// Logs in, with the SMS code when Picnic asks for one, and prints the auth key to store.
// Run: npx tsx examples/login.ts
import { createInterface } from "node:readline/promises";
import { PicnicSaver } from "../src/index.js";

const prompt = createInterface({ input: process.stdin, output: process.stdout });
const saver = new PicnicSaver({ countryCode: "DE" });

const email = await prompt.question("E-mail: ");
const password = await prompt.question("Password (shown as you type): ");

const login = await saver.login(email, password);
if (login.secondFactorRequired) {
  await saver.requestTwoFactorCode();
  await saver.verifyTwoFactorCode((await prompt.question("Code from the SMS: ")).trim());
}
prompt.close();

// Keep the key somewhere safe and pass it as `authKey` next time; the password is not needed again.
console.log(`Logged in. PICNIC_AUTH_KEY=${saver.authKey}`);
