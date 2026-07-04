import {createMemo} from "solid-js"
import type {FileDoc} from "../types"
import {isBinaryFileDoc} from "../datatype"

export const isAudioFile = (doc: FileDoc) => {
	// Require binary content: audio is inherently binary, so a string-backed doc
	// (e.g. a text file with a misdetected media mimeType) is never really audio.
	return isBinaryFileDoc(doc) && doc.mimeType?.startsWith("audio/")
}

export function AudioFileViewer(props: {doc: FileDoc}) {
	const audioUrl = createMemo(() => {
		if (isBinaryFileDoc(props.doc)) {
			return URL.createObjectURL(
				new Blob([props.doc.content as BlobPart], {type: props.doc.mimeType})
			)
		}
		return undefined
	})

	return (
		<div class="flex items-center justify-center h-full">
			{audioUrl() ? (
				<audio src={audioUrl()} controls />
			) : (
				<div class="text-gray-500">No audio to play</div>
			)}
		</div>
	)
}
