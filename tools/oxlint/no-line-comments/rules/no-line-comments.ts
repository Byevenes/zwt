import { defineRule } from "@oxlint/plugins";

/**
 * Line comments that compilers or linters read. Contracts stay in JSDoc.
 */
const allowedLineComment =
	/^\s*(?:\/\s*<(?:reference|amd-module|amd-dependency)\b|@ts-(?:check|nocheck|ignore|expect-error)\b|(?:oxlint|eslint)-(?:disable(?:-next-line|-line)?|enable)\b|prettier-ignore\b|@vitest-environment(?:-options)?\b)/;

export const noLineCommentsRule = defineRule({
	meta: {
		type: "suggestion",
		docs: {
			description:
				"Reject `//` line comments in src and test. Keep contracts in JSDoc. Compiler and lint directives stay allowed.",
		},
		messages: {
			line: "Use a JSDoc `/** */` contract, or move a decision to an ADR. `//` line comments are not allowed except compiler and lint directives.",
		},
	},
	createOnce(context) {
		return {
			Program() {
				for (const comment of context.sourceCode.getAllComments()) {
					if (comment.type !== "Line") {
						continue;
					}
					if (allowedLineComment.test(comment.value)) {
						continue;
					}
					context.report({
						loc: comment.loc,
						messageId: "line",
					});
				}
			},
		};
	},
});
