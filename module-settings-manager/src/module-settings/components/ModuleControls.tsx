import {
  For,
  Show,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { makeDocumentProjection } from "solid-automerge";
import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo";
import {
  DEFAULT_BRANCH,
  chosenBranchFor,
  chosenPinFor,
  getModuleEntryKind,
  publishVersions,
  type BranchesDoc,
  type ModuleSettingsDocWithBranches,
  type UrlHeads,
} from "../utils/module-types.ts";
import { unregisterPlugins } from "@inkandswitch/patchwork-plugins";
import {
  unregisterContributions,
  type ContributedPlugin,
} from "../utils/plugin-registry.ts";
import { BranchIcon, CopyIcon } from "../icons";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard.ts";

interface ModuleControlsProps {
  url: AutomergeUrl;
  repo: Repo;
  settingsHandle: DocHandle<ModuleSettingsDocWithBranches>;
  /**
   * The current user's own module-settings handle, when it differs from
   * `settingsHandle` (i.e. when viewing a foreign settings doc). Renders a
   * second "My branch" picker that writes a user-local override.
   */
  userSettingsHandle?: DocHandle<ModuleSettingsDocWithBranches>;
  plugins: ContributedPlugin[];
}

export function ModuleControls(props: ModuleControlsProps) {
  const [moduleHandle] = createResource(
    () => props.url,
    (url) => props.repo.find(url)
  );

  const moduleDoc = createMemo(() => {
    const handle = moduleHandle();
    if (!handle) return undefined;
    return makeDocumentProjection<Record<string, unknown>>(
      handle as DocHandle<Record<string, unknown>>
    );
  });

  const kind = createMemo(() => {
    const doc = moduleDoc();
    if (!doc) return "unknown";
    return getModuleEntryKind(doc);
  });

  return (
    <>
      <Show when={kind() === "branches"}>
        <BranchControls
          branchesDocUrl={props.url}
          branchesDoc={moduleDoc() as BranchesDoc | undefined}
          repo={props.repo}
          settingsHandle={props.settingsHandle}
          userSettingsHandle={props.userSettingsHandle}
          plugins={props.plugins}
        />
      </Show>
      <Show when={kind() === "folder" || kind() === "directory"}>
        <VersionControls
          folderUrl={props.url}
          repo={props.repo}
          settingsHandle={props.settingsHandle}
          userSettingsHandle={props.userSettingsHandle}
        />
        <ConvertToBranchesButton
          moduleUrl={props.url}
          repo={props.repo}
          settingsHandle={props.settingsHandle}
          kind={kind() as "folder" | "directory"}
        />
      </Show>
    </>
  );
}

interface VersionControlsProps {
  /** The folder doc whose versions can be pinned. */
  folderUrl: AutomergeUrl;
  repo: Repo;
  settingsHandle: DocHandle<ModuleSettingsDocWithBranches>;
  userSettingsHandle?: DocHandle<ModuleSettingsDocWithBranches>;
}

/**
 * Pin a folder module to a frozen previous version. Pins are written into the
 * user's own settings doc (like branch choices) under `pinned`, keyed by the
 * folder URL. The watcher then loads that exact, already-cached version instead
 * of the latest, and stops hot-reloading it until unpinned.
 */
function VersionControls(props: VersionControlsProps) {
  // Write pins to the user's own settings doc so they're user-local.
  const targetHandle = () => props.userSettingsHandle ?? props.settingsHandle;
  const targetDoc = createMemo(() => makeDocumentProjection(targetHandle()));

  const [folderHandle] = createResource(
    () => props.folderUrl,
    (url) => props.repo.find<{ lastSyncAt?: number }>(url)
  );

  const versions = createMemo(() => {
    const handle = folderHandle();
    return handle ? publishVersions(handle) : [];
  });

  const currentPin = createMemo(() =>
    chosenPinFor([targetDoc()], props.folderUrl)
  );

  const isPinned = createMemo(() => !!currentPin());

  const sameHeads = (a: UrlHeads | undefined, b: UrlHeads | undefined) =>
    !!a && !!b && a.length === b.length && a.every((h, i) => h === b[i]);

  // The <option> value currently selected: "latest" when unpinned, otherwise
  // the index of the matching version (or "latest" if the pin isn't in range).
  const selectedValue = createMemo(() => {
    const pin = currentPin();
    if (!pin) return "latest";
    const idx = versions().findIndex((v) => sameHeads(v.heads, pin));
    return idx === -1 ? "latest" : String(idx);
  });

  const pin = (heads: UrlHeads) => {
    targetHandle().change((d) => {
      if (!d.pinned) d.pinned = {} as Record<AutomergeUrl, UrlHeads>;
      d.pinned[props.folderUrl] = heads;
    });
  };

  const unpin = () => {
    targetHandle().change((d) => {
      if (d.pinned) delete d.pinned[props.folderUrl];
    });
  };

  return (
    <span class="module-settings-manager__version">
      <select
        class="module-settings-manager__version-select"
        value={selectedValue()}
        onChange={(e) => {
          const v = e.currentTarget.value;
          if (v === "latest") {
            unpin();
            return;
          }
          const chosen = versions()[Number(v)];
          if (chosen) pin(chosen.heads);
        }}
        title={
          isPinned()
            ? "Pinned to a previous version — won't update"
            : "Latest version — updates live"
        }
      >
        <option value="latest">latest</option>
        <For each={versions()}>
          {(v, i) => (
            <option value={i()}>
              {v.heads[0]?.slice(0, 7) ?? "?"}
            </option>
          )}
        </For>
      </select>
    </span>
  );
}

interface BranchControlsProps {
  branchesDocUrl: AutomergeUrl;
  branchesDoc: BranchesDoc | undefined;
  repo: Repo;
  settingsHandle: DocHandle<ModuleSettingsDocWithBranches>;
  userSettingsHandle?: DocHandle<ModuleSettingsDocWithBranches>;
  plugins: ContributedPlugin[];
}

function BranchControls(props: BranchControlsProps) {
  // Always write to the user's own settings doc so branch choices are
  // user-local. When viewing your own settings doc, that's the same handle.
  const targetHandle = () => props.userSettingsHandle ?? props.settingsHandle;
  const targetDoc = createMemo(() => makeDocumentProjection(targetHandle()));

  const branchNames = createMemo(() => {
    const branches = props.branchesDoc?.branches;
    return branches ? Object.keys(branches).sort() : [];
  });

  const currentBranch = createMemo(() =>
    chosenBranchFor([targetDoc()], props.branchesDocUrl)
  );

  const setBranch = (name: string) => {
    // Re-selecting the current branch is a no-op — the cleanup below would
    // unregister the live plugins and the doc.change wouldn't trigger a
    // reload (no diff), leaving the registry empty until the next change.
    if (name === currentBranch()) return;
    const handle = targetHandle();
    const doc = targetDoc();
    unregisterContributions(props.plugins);
    unregisterPlugins(
      doc.branches?.[props.branchesDocUrl] ?? props.branchesDocUrl
    );
    handle.change((d) => {
      if (!d.branches) d.branches = {} as Record<AutomergeUrl, string>;
      d.branches[props.branchesDocUrl] = name;
    });
  };

  const addBranch = async (name: string) => {
    const urlRaw = window.prompt(
      `Automerge URL for the folder/directory of branch "${name}":`
    );
    if (!urlRaw) return;
    const url = urlRaw.trim();
    if (!isValidAutomergeUrl(url)) {
      window.alert(`Invalid Automerge URL: ${url}`);
      return;
    }

    const branchesHandle = await props.repo.find<BranchesDoc>(
      props.branchesDocUrl
    );
    branchesHandle.change((doc) => {
      if (!doc.branches) doc.branches = {};
      doc.branches[name] = url as AutomergeUrl;
    });

    targetHandle().change((d) => {
      if (!d.branches) d.branches = {} as Record<AutomergeUrl, string>;
      d.branches[props.branchesDocUrl] = name;
    });
  };

  // True when the branch choice we're writing belongs to the user but they're
  // looking at someone else's settings doc — flag it so the user knows the
  // override is theirs alone, not part of the doc on screen.
  const isPersonal = () =>
    !!props.userSettingsHandle &&
    props.userSettingsHandle.url !== props.settingsHandle.url;

  // The folder doc the current branch resolves to — pin versions of *that*.
  const branchFolderUrl = createMemo(() => {
    const url = props.branchesDoc?.branches?.[currentBranch()];
    return url && isValidAutomergeUrl(url) ? url : undefined;
  });

  return (
    <>
      <FilterableBranchPicker
        branches={branchNames()}
        branchUrls={props.branchesDoc?.branches}
        value={currentBranch()}
        personal={isPersonal()}
        onChange={setBranch}
        onAdd={addBranch}
      />
      <Show when={branchFolderUrl()}>
        {(folderUrl) => (
          <VersionControls
            folderUrl={folderUrl()}
            repo={props.repo}
            settingsHandle={props.settingsHandle}
            userSettingsHandle={props.userSettingsHandle}
          />
        )}
      </Show>
    </>
  );
}

interface FilterableBranchPickerProps {
  branches: string[];
  branchUrls?: Record<string, AutomergeUrl>;
  value: string;
  personal?: boolean;
  onChange: (value: string) => void;
  onAdd: (name: string) => void | Promise<void>;
}

function FilterableBranchPicker(props: FilterableBranchPickerProps) {
  const [open, setOpen] = createSignal(false);
  const [filter, setFilter] = createSignal("");
  const [, copy] = useCopyToClipboard();
  let containerRef: HTMLDivElement | undefined;

  const filtered = createMemo(() => {
    const q = filter().toLowerCase();
    if (!q) return props.branches;
    return props.branches.filter((b) => b.toLowerCase().includes(q));
  });

  // Show a "create" option when the typed text isn't already a branch.
  const createCandidate = createMemo(() => {
    const q = filter().trim();
    if (!q) return null;
    if (props.branches.includes(q)) return null;
    return q;
  });

  const handleDocumentClick = (e: MouseEvent) => {
    if (containerRef && !containerRef.contains(e.target as Node)) {
      setOpen(false);
    }
  };

  onMount(() => {
    document.addEventListener("click", handleDocumentClick);
  });
  onCleanup(() => {
    document.removeEventListener("click", handleDocumentClick);
  });

  const select = (name: string) => {
    props.onChange(name);
    setOpen(false);
    setFilter("");
  };

  const create = async (name: string) => {
    await props.onAdd(name);
    setOpen(false);
    setFilter("");
  };

  const isMissing = createMemo(
    () =>
      !props.branches.includes(props.value) && props.value !== DEFAULT_BRANCH
  );

  return (
    <div class="module-settings-manager__branch-picker" ref={containerRef}>
      <button
        class="module-settings-manager__branch-picker-button"
        classList={{
          "module-settings-manager__branch-picker-button--missing": isMissing(),
        }}
        onClick={() => setOpen(!open())}
        title={
          isMissing()
            ? `Branch "${props.value}" doesn't exist in this branches doc`
            : `Current branch: ${props.value}`
        }
      >
        <BranchIcon />
        <span>{props.value}</span>
        <span class="module-settings-manager__branch-picker-caret">▼</span>
      </button>
      <Show when={props.personal}>
        <em class="module-settings-manager__branch-picker-personal">
          (personal)
        </em>
      </Show>
      <Show when={open()}>
        <div class="module-settings-manager__branch-picker-popup">
          <input
            class="module-settings-manager__branch-picker-filter"
            type="text"
            placeholder="Filter or type a new branch name…"
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const matches = filtered();
                if (matches.length === 1) {
                  e.preventDefault();
                  select(matches[0]);
                } else if (matches.length === 0 && createCandidate()) {
                  e.preventDefault();
                  void create(createCandidate()!);
                }
              }
            }}
            autofocus
          />
          <ul class="module-settings-manager__branch-picker-list">
            <For each={filtered()}>
              {(name) => (
                <li
                  class="module-settings-manager__branch-picker-item"
                  classList={{
                    "module-settings-manager__branch-picker-item--current":
                      name === props.value,
                  }}
                  onClick={() => select(name)}
                >
                  <span class="module-settings-manager__branch-picker-item-name">
                    {name}
                  </span>
                  <Show when={props.branchUrls?.[name]}>
                    <button
                      class="module-settings-manager__branch-picker-copy"
                      title="copy url"
                      onClick={(e) => {
                        e.stopPropagation();
                        void copy(props.branchUrls![name]);
                      }}
                    >
                      <CopyIcon />
                    </button>
                  </Show>
                </li>
              )}
            </For>
            <Show when={createCandidate()}>
              <li
                class="module-settings-manager__branch-picker-item module-settings-manager__branch-picker-item--create"
                onClick={() => void create(createCandidate()!)}
                title={`Add a new branch named "${createCandidate()}"`}
              >
                + Add “{createCandidate()}”
              </li>
            </Show>
            <Show when={filtered().length === 0 && !createCandidate()}>
              <li class="module-settings-manager__branch-picker-empty">
                No branches yet
              </li>
            </Show>
          </ul>
        </div>
      </Show>
    </div>
  );
}

interface ConvertToBranchesButtonProps {
  moduleUrl: AutomergeUrl;
  repo: Repo;
  settingsHandle: DocHandle<ModuleSettingsDocWithBranches>;
  kind: "folder" | "directory";
}

function ConvertToBranchesButton(props: ConvertToBranchesButtonProps) {
  const handleClick = async () => {
    const ok = window.confirm(
      "Convert this module entry to a branches doc?\n\n" +
        "A new branches document will be created with the current URL as " +
        '"default", and the entry in modules will be replaced with the ' +
        "new branches doc URL."
    );
    if (!ok) return;

    const branchesHandle = props.repo.create<BranchesDoc>({
      "@patchwork": { type: "branches" },
      branches: { [DEFAULT_BRANCH]: props.moduleUrl },
    });
    await branchesHandle.whenReady();
    const branchesUrl = branchesHandle.url;

    props.settingsHandle.change((doc) => {
      if (!Array.isArray(doc.modules)) return;
      const idx = doc.modules.indexOf(props.moduleUrl);
      if (idx === -1) return;
      doc.modules[idx] = branchesUrl;
      if (!doc.branches) doc.branches = {} as Record<AutomergeUrl, string>;
      doc.branches[branchesUrl] = DEFAULT_BRANCH;
    });
  };

  return (
    <span class="module-settings-manager__convert">
      <span class="module-settings-manager__convert-label">
        {props.kind === "folder" ? "Folder" : "Directory"}
      </span>
      <button
        class="module-settings-manager__convert-action"
        onClick={handleClick}
        title="Wrap this module in a new branches doc with this URL as the default branch"
      >
        Add branches
      </button>
    </span>
  );
}
