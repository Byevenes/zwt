import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

export default defineConfig({
  ...cloudflare,
  rules: {
    ...cloudflare.rules,
    "import/no-namespace": "off", // temporary during migration
    "@nkzw/no-instanceof": "off", // temporary during migration
    "quality/no-conditional-empty-object-spread": "off", // temporary during migration
    "quality/no-known-value-widening": "off", // temporary during migration
    "quality/no-unsafe-dictionary-type": "off", // temporary during migration
    "typescript/no-empty-object-type": "off", // temporary during migration
    "typescript/no-unnecessary-type-assertion": "off", // temporary during migration
    "typescript/no-unsafe-type-assertion": "off", // temporary during migration
    "unicorn/consistent-function-scoping": "off", // temporary during migration
  },
});
