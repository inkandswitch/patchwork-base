// The in-browser TypeScript environment behind the editor's completions,
// hovers, and diagnostics for JS/TS files. lib.*.d.ts come from the INSTALLED
// typescript package (globbed at build time — no network), with a CDN fetch as
// fallback. This module is imported dynamically so the TypeScript compiler only
// ships (as its own chunk) when a code file is actually opened.
import ts from "typescript"
import {
	createDefaultMapFromCDN,
	createSystem,
	createVirtualTypeScriptEnvironment,
} from "@typescript/vfs"

// import.meta.glob is a Vite build-time feature; tsconfig doesn't pull in
// vite/client types, so reach for it through a cast to keep the typecheck clean.
const tsLibs = (
	import.meta as unknown as {
		glob: (
			pattern: string,
			opts: {query: string; import: string; eager: boolean},
		) => Record<string, string>
	}
).glob("../node_modules/typescript/lib/lib*.d.ts", {
	query: "?raw",
	import: "default",
	eager: true,
})

// A permissive ambient JSX namespace so .tsx/.jsx files don't report an error
// on every intrinsic element when no framework types are present.
const JSX_SHIM = `
declare namespace JSX {
	type Element = any
	interface ElementChildrenAttribute { children: {} }
	interface IntrinsicElements { [tag: string]: any }
}
`

export const compilerOptions: ts.CompilerOptions = {
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	jsx: ts.JsxEmit.Preserve,
	// programmatic `lib` wants full lib FILENAMES, not tsconfig-style names
	lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
	allowJs: true,
	checkJs: false,
	strict: false,
	noEmit: true,
	allowNonTsExtensions: true,
}

export async function createTsEnv(path: string, initialCode: string) {
	let fsMap: Map<string, string>
	const globbed = Object.entries(tsLibs)
	if (globbed.length > 0) {
		fsMap = new Map()
		for (const [p, src] of globbed) fsMap.set("/" + p.split("/").pop()!, src)
	} else {
		// the glob came up empty (packaging quirk) — fall back to the CDN map,
		// cached in localStorage by @typescript/vfs
		fsMap = await createDefaultMapFromCDN(
			{target: compilerOptions.target!},
			ts.version,
			true,
			ts,
		)
	}

	fsMap.set("/jsx-shim.d.ts", JSX_SHIM)
	fsMap.set(path, initialCode || " ") // the env refuses an empty root file

	const system = createSystem(fsMap)
	return createVirtualTypeScriptEnvironment(
		system,
		[path, "/jsx-shim.d.ts"],
		ts,
		compilerOptions,
	)
}
