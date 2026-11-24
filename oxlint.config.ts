import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

export default defineConfig({
  ...cloudflare,
  jsPlugins: [
    ...cloudflare.jsPlugins,
    {
      name: "anti-slop-effect",
      specifier: "./tools/oxlint/anti-slop/effect/index.ts",
    },
  ],
  rules: {
    ...cloudflare.rules,
    "anti-slop-effect/no-manual-effect-error-tag": "error",
    // Off until the plain `_tag` unions (results, plans, pieces) move to Data.taggedEnum.
    // Turning them on today reports 47 and 86 findings across src and test.
    "anti-slop-effect/no-manual-tag-comparison": "off",
    "anti-slop-effect/no-manual-tagged-construction": "off",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop-effect/prefer-effect-match": "error",
  },
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
