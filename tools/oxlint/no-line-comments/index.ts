import { eslintCompatPlugin } from "@oxlint/plugins";

import { noLineCommentsRule } from "./rules/no-line-comments.ts";

/** Local Oxlint rules for zwt. */
const zwtPlugin = eslintCompatPlugin({
	meta: { name: "zwt" },
	rules: {
		"no-line-comments": noLineCommentsRule,
	},
});

export default zwtPlugin;
