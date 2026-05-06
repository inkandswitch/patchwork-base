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
  getModuleEntryKind,
  type BranchesDoc,
  type ModuleSettingsDocWithBranches,
} from "../utils/module-types.ts";
import { unregisterPlugins } from "@inkandswitch/patchwork-plugins";
import {
  unregisterContributions,
  type ContributedPlugin,
} from "../utils/plugin-registry.ts";

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
    return makeDocumentProjection<unknown>(handle as DocHandle<unknown>);
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

interface BranchControlsProps {
  branchesDocUrl: AutomergeUrl;
  branchesDoc: BranchesDoc | undefined;
  repo: Repo;
  settingsHandle: DocHandle<ModuleSettingsDocWithBranches>;
  userSettingsHandle?: DocHandle<ModuleSettingsDocWithBranches>;
  plugins: ContributedPlugin[];
}

function BranchControls(props: BranchControlsProps) {
  const branches = () => props.branchesDoc?.branches;

  const showSplit = () =>
    !!props.userSettingsHandle &&
    props.userSettingsHandle.url !== props.settingsHandle.url;

  return (
    <Show
      when={showSplit()}
      fallback={
        <BranchControl
          label="Branch"
          branchesDocUrl={props.branchesDocUrl}
          targetHandle={props.settingsHandle}
          repo={props.repo}
          branches={branches()}
          plugins={props.plugins}
        />
      }
    >
      <BranchControl
        label="Module settings branch"
        branchesDocUrl={props.branchesDocUrl}
        targetHandle={props.settingsHandle}
        repo={props.repo}
        branches={branches()}
        plugins={props.plugins}
      />
      <BranchControl
        label="My branch"
        branchesDocUrl={props.branchesDocUrl}
        targetHandle={props.userSettingsHandle!}
        repo={props.repo}
        branches={branches()}
        plugins={props.plugins}
      />
    </Show>
  );
}

interface BranchControlProps {
  label: string;
  branchesDocUrl: AutomergeUrl;
  targetHandle: DocHandle<ModuleSettingsDocWithBranches>;
  repo: Repo;
  branches: Record<string, AutomergeUrl> | undefined;
  plugins: ContributedPlugin[];
}

function BranchControl(props: BranchControlProps) {
  const targetDoc = makeDocumentProjection(props.targetHandle);

  const currentBranch = createMemo(() =>
    chosenBranchFor(targetDoc, props.branchesDocUrl)
  );

  const branchNames = createMemo(() =>
    props.branches ? Object.keys(props.branches).sort() : []
  );

  const currentBranchUrl = createMemo(
    () => props.branches?.[currentBranch()]
  );

  const setBranch = (name: string) => {
    unregisterContributions(props.plugins);
    unregisterPlugins(
      targetDoc.branches?.[props.branchesDocUrl] ?? props.branchesDocUrl
    );

    props.targetHandle.change((doc) => {
      if (!doc.branches) doc.branches = {} as Record<AutomergeUrl, string>;
      doc.branches[props.branchesDocUrl] = name;
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

    props.targetHandle.change((doc) => {
      if (!doc.branches) doc.branches = {} as Record<AutomergeUrl, string>;
      doc.branches[props.branchesDocUrl] = name;
    });
  };

  return (
    <div class="module-settings-manager__branch-control">
      <FilterableBranchPicker
        label={props.label}
        branches={branchNames()}
        value={currentBranch()}
        onChange={setBranch}
        onAdd={addBranch}
      />
      <Show when={currentBranchUrl()}>
        <code class="module-settings-manager__branch-url">
          {currentBranchUrl()}
        </code>
      </Show>
    </div>
  );
}

interface FilterableBranchPickerProps {
  label?: string;
  branches: string[];
  value: string;
  onChange: (value: string) => void;
  onAdd: (name: string) => void | Promise<void>;
}

function FilterableBranchPicker(props: FilterableBranchPickerProps) {
  const [open, setOpen] = createSignal(false);
  const [filter, setFilter] = createSignal("");
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
      <span class="module-settings-manager__branch-picker-label">
        {props.label ?? "Branch"}
      </span>
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
        <span>{props.value}</span>
        <span class="module-settings-manager__branch-picker-caret">▼</span>
      </button>
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
                  {name}
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
