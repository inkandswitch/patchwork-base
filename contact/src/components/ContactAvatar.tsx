import { type AutomergeUrl } from "@automerge/automerge-repo";
import {
  useDocument,
  useDocHandle,
  useRemoteAwareness,
} from "@automerge/automerge-repo-react-hooks";
import { useSubscribeDoc } from "@inkandswitch/patchwork-providers-react";
import type { ContactDoc } from "../types";
import { Avatar, AvatarFallback, AvatarImage } from "./Avatar";
import { User as UserIcon } from "lucide-react";
import { generateColorFromString } from "../ui";
import { useMemo } from "react";
import { getImportableUrlFromAutomergeUrl } from "@inkandswitch/patchwork-filesystem";
import type { TinyPatchworkLayoutDoc } from "../types";

// Extend the Window interface to include accountDocHandle
declare global {
  interface Window {
    accountDocHandle?: { url: AutomergeUrl };
  }
}

export const ContactAvatar = ({
  docUrl,
  element,
}: {
  docUrl: AutomergeUrl;
  element: HTMLElement;
}) => {
  const [contact] = useDocument<ContactDoc>(docUrl);
  const handle = useDocHandle(docUrl, { suspense: true });

  const [ownContact, ownContactHandle] = useSubscribeDoc<ContactDoc>(
    element,
    { type: "patchwork:contact" }
  );
  const accountDocHandle = window.accountDocHandle;
  const [fallbackAccount] = useDocument<TinyPatchworkLayoutDoc>(
    ownContactHandle ? undefined : accountDocHandle?.url
  );
  const [fallbackSelf] = useDocument<ContactDoc>(
    ownContactHandle ? undefined : fallbackAccount?.contactUrl
  );
  const self = ownContact ?? fallbackSelf;

  const avatarHandle = useDocHandle(
    contact?.type === "registered" ? contact.avatarUrl : undefined
  );
  const avatarImgUrl =
    avatarHandle && getImportableUrlFromAutomergeUrl(avatarHandle.url);

  // Listen for presence on this contact's awareness
  const [_, heartbeats] = useRemoteAwareness({
    handle,
    localUserId: self?.type == "registered" ? self.name : "me",
  });

  const isPresent = !!heartbeats[docUrl];

  // Get user's color for the presence ring
  const userColor = useMemo(() => {
    if (contact && "color" in contact && contact.color) {
      return contact.color;
    }
    return generateColorFromString(docUrl);
  }, [contact, docUrl]);

  if (!contact) {
    return null;
  }

  const name = contact.type === "registered" ? contact.name : "Anonymous";
  const isRegistered = contact.type === "registered";

  return (
    <Avatar
      size="default"
      className={`shrink-0 ${isPresent ? "ring-2" : ""}`}
      style={
        isPresent
          ? ({ "--tw-ring-color": userColor } as React.CSSProperties)
          : undefined
      }
    >
      {isRegistered && avatarImgUrl && (
        <AvatarImage src={avatarImgUrl} alt={name} />
      )}
      <AvatarFallback>
        {isRegistered && name ? (
          <span className="text-sm">
            {name
              .split(" ")
              .map((word) => word[0])
              .join("")}
          </span>
        ) : (
          <UserIcon size={20} />
        )}
      </AvatarFallback>
    </Avatar>
  );
};
