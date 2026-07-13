// Example document for fresh accounts (aggregated into the bundle's init.js):
// a short markdown essay to read and mess with. Standalone: builds the doc
// shape inline instead of going through the plugin registry.

const CONTENT = `# Working with the garage door up

This document is yours — edit it, break it, delete it.

One of the nicest habits in software (and writing, and most crafts) is
working with the garage door up: doing your work where others can see it,
half-finished edges and all. Not as a performance, but because unfinished
work invites collaboration in a way polished work never does.

## Why it works

A finished document says *admire me*. A draft says *help me*. When people
can see the seams — the TODO, the sentence that trails off, the paragraph
marked "is this right?" — they know where to push.

## Try it here

Everything in this folder is a live document. Put your cursor anywhere in
this essay and start typing. There is no save button; every keystroke is
already yours, and the history of the document remembers how it got here.
`;

export default async function example(repo) {
  const handle = await repo.create2({
    "@patchwork": {
      type: "essay",
      suggestedImportUrl: new URL("./dist/main.js", import.meta.url).href,
    },
    content: CONTENT,
  });

  return {
    name: "Working with the garage door up",
    type: "essay",
    url: handle.url,
  };
}
