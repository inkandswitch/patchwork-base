import {
  createSignal,
  createEffect,
  Show,
  For,
  onCleanup,
  createMemo,
} from "solid-js";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import {
  Access,
  ContactCard,
  type LegacyAutomergeRepoKeyhive,
  type DocMember,
} from "@automerge/automerge-repo-keyhive";

interface ShareModalProps {
  isOpen: boolean;
  docUrl: AutomergeUrl;
  hive: LegacyAutomergeRepoKeyhive;
  onClose: () => void;
}

export function ShareModal(props: ShareModalProps) {
  const [contactCardInput, setContactCardInput] = createSignal("");
  const [members, setMembers] = createSignal<DocMember[]>([]);
  const [isLoadingMembers, setIsLoadingMembers] = createSignal(true);
  const [isSubmitting, setIsSubmitting] = createSignal(false);

  // Refresh after a mutation. Ignores errors (the caller has already handled
  // the mutation error) so it is safe to await in a `finally`.
  async function refreshMembers() {
    try {
      setMembers(await props.hive.listMembers(props.docUrl));
    } catch (err) {
      console.error("[ShareModal] Error refreshing members:", err);
    }
  }

  const currentUserAccess = createMemo(
    () => members().find((m) => m.isSelf)?.access
  );

  const isAdmin = createMemo(
    () => currentUserAccess()?.atLeast(Access.admin()) ?? false
  );

  const publicAccess = createMemo(
    () => members().find((m) => m.isPublic)?.access
  );

  // Load the member list when the modal opens.
  createEffect(() => {
    if (!props.isOpen) return;

    let cancelled = false;

    async function loadMembers() {
      if (!cancelled) setIsLoadingMembers(true);

      try {
        const list = await props.hive.listMembers(props.docUrl);
        if (!cancelled) {
          setMembers(list);
          setIsLoadingMembers(false);
        }
      } catch (err) {
        if (!cancelled) {
          console.error("[ShareModal] Error loading members:", err);
          setMembers([]);
          setIsLoadingMembers(false);
        }
      }
    }

    loadMembers();

    onCleanup(() => {
      cancelled = true;
    });
  });

  // Escape key handler
  createEffect(() => {
    if (!props.isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        props.onClose();
      }
    };

    document.addEventListener("keydown", handleEscape);

    onCleanup(() => {
      document.removeEventListener("keydown", handleEscape);
    });
  });

  const handleAddMember = async (e: Event) => {
    e.preventDefault();

    const input = contactCardInput().trim();
    if (!input) return;

    setIsSubmitting(true);

    try {
      const contactCard = ContactCard.fromJson(input);
      if (!contactCard) {
        throw new Error("Invalid ContactCard JSON");
      }

      await props.hive.addMemberToDoc(props.docUrl, contactCard, Access.edit());

      setContactCardInput("");
    } catch (err) {
      console.error("[ShareModal]", err);
    } finally {
      // Refresh even on error, since the delegation may have succeeded.
      await refreshMembers();
      setIsSubmitting(false);
    }
  };

  const handleRemoveMember = async (member: DocMember) => {
    try {
      await props.hive.revokeMemberFromDoc(props.docUrl, member.id);
    } catch (err) {
      console.error("[ShareModal]", err);
    } finally {
      await refreshMembers();
    }
  };

  const handleMakePublic = async () => {
    try {
      // TODO: pass to tool
      await props.hive.setPublicAccess(props.docUrl, Access.edit());
    } catch (err) {
      console.error("[ShareModal]", err);
    } finally {
      // Refresh even on error, since the delegation may have succeeded.
      await refreshMembers();
    }
  };

  const handleMakePrivate = async () => {
    const publicMember = members().find((m) => m.isPublic);
    if (!publicMember) return;
    try {
      await props.hive.revokeMemberFromDoc(props.docUrl, publicMember.id);
    } catch (err) {
      console.error("[ShareModal]", err);
    } finally {
      await refreshMembers();
    }
  };

  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) {
      props.onClose();
    }
  };

  const formatHexId = (hexId: string) => `0x${hexId.slice(0, 12)}...`;

  const sortedMembers = createMemo(() =>
    [...members()].sort((a, b) => a.id.localeCompare(b.id))
  );

  return (
    <Show when={props.isOpen}>
      <div class="share-modal__overlay" onClick={handleBackdropClick}>
        <div
          class="share-modal__content"
          onClick={(e) => e.stopPropagation()}
        >
          <header class="share-modal__header">
            <h2>Share this document</h2>
            <button
              class="share-modal__close"
              onClick={() => props.onClose()}
              aria-label="Close modal"
            >
              &times;
            </button>
          </header>

          <div class="share-modal__body">
<section class="share-modal__public-section">
              <h3 class="share-modal__section-title">Public Access</h3>
              <div class="share-modal__public-controls">
                <Show when={publicAccess()}>
                  <span class="share-modal__public-status">
                    This document is <strong>public</strong>
                  </span>
                </Show>
                <Show when={isAdmin()}>
                  <div class="share-modal__public-actions">
                    <Show when={publicAccess()}>
                      <button
                        class="share-modal__add-button"
                        onClick={handleMakePrivate}
                      >
                        Revoke Public Access
                      </button>
                    </Show>
                    <Show when={!publicAccess()}>
                      <button
                        class="share-modal__add-button"
                        onClick={handleMakePublic}
                      >
                        Make Public
                      </button>
                    </Show>
                  </div>
                </Show>
              </div>
            </section>

            <Show when={isAdmin()}>
              <hr class="share-modal__divider" />

              <form class="share-modal__form" onSubmit={handleAddMember}>
                <textarea
                  class="share-modal__input"
                  placeholder="Paste ContactCard JSON..."
                  value={contactCardInput()}
                  onInput={(e) => setContactCardInput(e.currentTarget.value)}
                  rows={3}
                />
                <div class="share-modal__form-actions">
                  <button
                    type="submit"
                    class="share-modal__add-button"
                    disabled={isSubmitting() || !contactCardInput().trim()}
                  >
                    {isSubmitting() ? "Adding..." : "Add"}
                  </button>
                </div>
              </form>

              <hr class="share-modal__divider" />
            </Show>

            <section>
              <h3 class="share-modal__section-title">Current Access</h3>

              <Show when={isLoadingMembers()}>
                <p class="share-modal__loading">Loading...</p>
              </Show>

              <Show when={!isLoadingMembers() && sortedMembers().length === 0}>
                <p class="share-modal__empty">No users have access yet</p>
              </Show>

              <Show when={!isLoadingMembers() && sortedMembers().length > 0}>
                <div class="share-modal__member-list">
                  <For each={sortedMembers()}>
                    {(member) => {
                      const mine = currentUserAccess();
                      const canRemove =
                        !!mine &&
                        mine.atLeast(member.access) &&
                        !member.isSelf &&
                        !member.isSyncServer;

                      const displayName = () => {
                        if (member.isSelf) return "You";
                        if (member.isSyncServer) return "Sync Server";
                        if (member.isPublic) return "Public";
                        return formatHexId(member.id);
                      };

                      return (
                        <div class="share-modal__member">
                          <div class="share-modal__member-info">
                            <span
                              class="share-modal__member-id"
                              classList={{
                                "share-modal__member-id--you": member.isSelf,
                                "share-modal__member-id--public": member.isPublic,
                              }}
                            >
                              {displayName()}
                            </span>
                            <span class="share-modal__member-access">
                              {member.access.toString()}
                            </span>
                          </div>
                          <Show when={canRemove}>
                            <button
                              class="share-modal__remove-button"
                              onClick={() => handleRemoveMember(member)}
                              aria-label="Remove member"
                            >
                              <svg
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                              >
                                <path d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </section>
          </div>
        </div>
      </div>
    </Show>
  );
}
