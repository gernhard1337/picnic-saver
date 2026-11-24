import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    target: "node20",
    sourcemap: true,
  },
  {
    entry: { cli: "src/cli/index.ts" },
    format: ["esm"],
    target: "node20",
    banner: { js: "#!/usr/bin/env node" },
  },
]);
