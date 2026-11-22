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
  rules: {
    ...cloudflare.rules,
    "@nkzw/no-instanceof": "off", // temporary during migration
    "quality/no-conditional-empty-object-spread": "off", // temporary during migration
    "quality/no-known-value-widening": "off", // temporary during migration
    "quality/no-unsafe-dictionary-type": "off", // temporary during migration
    "typescript/no-empty-object-type": "off", // temporary during migration
    "typescript/no-unnecessary-type-assertion": "off", // temporary during migration
    "typescript/no-unsafe-type-assertion": "off", // temporary during migration
  },
});
