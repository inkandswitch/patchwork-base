import { describe, it, expect } from "vitest";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import {
  getModuleEntryKind,
  chosenBranchFor,
  DEFAULT_BRANCH,
  type ModuleSettingsDocWithBranches,
} from "./module-types";

describe("getModuleEntryKind", () => {
  it("reads the patchwork type for directory and branches docs", () => {
    expect(getModuleEntryKind({ "@patchwork": { type: "directory" } })).toBe(
      "directory"
    );
    expect(getModuleEntryKind({ "@patchwork": { type: "branches" } })).toBe(
      "branches"
    );
  });

  it("treats a doc with a docs array as a folder", () => {
    expect(getModuleEntryKind({ docs: [] })).toBe("folder");
    expect(getModuleEntryKind({ docs: ["a", "b"] })).toBe("folder");
  });

  it("returns unknown for non-objects and unrecognized shapes", () => {
    expect(getModuleEntryKind(null)).toBe("unknown");
    expect(getModuleEntryKind(undefined)).toBe("unknown");
    expect(getModuleEntryKind("nope")).toBe("unknown");
    expect(getModuleEntryKind({})).toBe("unknown");
    expect(getModuleEntryKind({ docs: "not-an-array" })).toBe("unknown");
  });
});

describe("chosenBranchFor", () => {
  const url = "automerge:branchesDoc" as AutomergeUrl;
  const docWith = (branch: string): ModuleSettingsDocWithBranches =>
    ({ branches: { [url]: branch } }) as unknown as ModuleSettingsDocWithBranches;

  it("returns the default branch when nothing overrides it", () => {
    expect(chosenBranchFor([], url)).toBe(DEFAULT_BRANCH);
    expect(chosenBranchFor([undefined], url)).toBe(DEFAULT_BRANCH);
    expect(chosenBranchFor([{} as ModuleSettingsDocWithBranches], url)).toBe(
      DEFAULT_BRANCH
    );
  });

  it("returns the first matching branch in priority order", () => {
    expect(chosenBranchFor([docWith("feature")], url)).toBe("feature");
    // user-local override (first) beats the viewed doc (second)
    expect(chosenBranchFor([docWith("mine"), docWith("theirs")], url)).toBe(
      "mine"
    );
  });

  it("skips docs without a matching branch entry", () => {
    expect(chosenBranchFor([undefined, docWith("found")], url)).toBe("found");
  });
});
