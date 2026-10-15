/**
 * What garden's document face does to text written to it, for tests that claim "the cell keeps it exactly" (exam 1,
 * section 4: a map that stored the text verbatim assumed the property it named). Not a test file.
 *
 * Garden imports Markdown (written with `format: "markdown"`, or with no format when the text has a Markdown hint, a
 * backtick pair or `**`) into blocks and exports it back. Outside a fenced code block that is lossy: a CommonMark
 * backslash escape is consumed (`\"` becomes `"`, `\\` becomes `\`), which is how an escaped quote in bare JSON lost its
 * backslash (RETURN-json-face.md). A fenced code block's text is kept byte for byte. Written as `plain`, runs of
 * whitespace, newlines included, are folded to one space.
 */

const ESCAPABLE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;
const MARKDOWN_HINT = /`[^`\n]+`|\*\*/;

function markdownRoundTrip(content: string): string {
	const lines = content.split("\n");
	const out: string[] = [];
	let fence: string | undefined;
	for (const line of lines) {
		const opener = /^(`{3,})/.exec(line);
		if (fence === undefined && opener) {
			fence = opener[1];
			out.push(line);
			continue;
		}
		if (fence !== undefined) {
			if (new RegExp(`^${fence}\`*\\s*$`).test(line)) fence = undefined;
			out.push(line);
			continue;
		}
		out.push(line.replace(ESCAPABLE, "$1"));
	}
	return out.join("\n");
}

/** The text the cell holds after a write of `content` with `format`. */
export function gardenDocumentFace(content: string, format?: string): string {
	if (format === "plain") return content.replace(/\s+/g, " ").trim();
	if (format === "markdown" || MARKDOWN_HINT.test(content)) return markdownRoundTrip(content);
	return content;
}
