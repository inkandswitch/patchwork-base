// Message text is rendered through the cute.txt engine now (see MessageBody +
// lib/syntax-schema.ts). The old segment/innerHTML pipeline
// (parseTextSegments/formatInlineHtml) is gone; only the emoji-only sizing test
// remains, since it operates on the raw string, not the render tree.

export function isEmojiOnly(text: string): boolean {
	const stripped = text
		.replace(/:[a-zA-Z0-9_+\-]+:/g, "")
		.replace(
			/[\p{Emoji_Presentation}\p{Extended_Pictographic}‍️︎⃣\u{1f3fb}-\u{1f3ff}\u{e0061}-\u{e007a}\u{e007f}]/gu,
			""
		)
		.trim()
	return stripped.length === 0 && text.trim().length > 0
}
