import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

export default defineConfig({
  ...cloudflare,
  overrides: [
    ...cloudflare.overrides,
    {
      files: ["src/services/Config.ts"],
      // effect/SchemaIssue is a public namespace (issue constructors plus formatters).
      rules: {
        "import/no-namespace": "off",
      },
    },
  ],
});
