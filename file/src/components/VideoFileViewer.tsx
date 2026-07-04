import {createMemo} from "solid-js"
import type {FileDoc} from "../types"
import {isBinaryFileDoc} from "../datatype"

export const isVideoFile = (doc: FileDoc) => {
	// Require binary content: a video is inherently binary, so a string-backed
	// doc is never really a video. This disambiguates the ".ts" extension, which
	// mimeType detection reports as video/mp2t (MPEG transport stream) — a
	// TypeScript source file has string content and falls through to the text
	// editor, while an actual transport stream is binary and renders here.
	return isBinaryFileDoc(doc) && doc.mimeType?.startsWith("video/")
}

export function VideoFileViewer(props: {doc: FileDoc}) {
	const videoUrl = createMemo(() => {
		if (isBinaryFileDoc(props.doc)) {
			return URL.createObjectURL(
				new Blob([props.doc.content as BlobPart], {type: props.doc.mimeType})
			)
		}
		return undefined
	})

	return (
		<div class="flex items-center justify-center h-full">
			{videoUrl() ? (
				<video
					src={videoUrl()}
					controls
					class="max-w-full max-h-full object-contain"
				/>
			) : (
				<div class="text-gray-500">No video to play</div>
			)}
		</div>
	)
}
