import { type AutomergeUrl } from "@automerge/automerge-repo";
import {
  useDocument,
  useDocHandle,
} from "@automerge/automerge-repo-react-hooks";
import { type ContactDoc } from "../types";
import { Avatar, AvatarFallback, AvatarImage } from "./Avatar";
import { User as UserIcon } from "lucide-react";
import { automergeUrlToServiceWorkerUrl } from "@inkandswitch/patchwork-filesystem";

export const ContactViewer = ({ docUrl }: { docUrl: AutomergeUrl }) => {
  const [contact] = useDocument<ContactDoc>(docUrl);

  const avatarHandle = useDocHandle(
    contact?.type === "registered" ? contact.avatarUrl : undefined
  );
  const avatarImgUrl =
    avatarHandle && automergeUrlToServiceWorkerUrl(avatarHandle.url);

  if (!contact) {
    return null;
  }

  const name = contact.type === "registered" ? contact.name : "Anonymous";
  const isRegistered = contact.type === "registered";

  return (
    <div className="contact-viewer">
      <Avatar size="lg">
        {isRegistered && avatarImgUrl && (
          <AvatarImage src={avatarImgUrl} alt={name} />
        )}
        <AvatarFallback>
          {isRegistered && name ? (
            <span>
              {name
                .split(" ")
                .map((word) => word[0])
                .join("")}
            </span>
          ) : (
            <UserIcon size={32} />
          )}
        </AvatarFallback>
      </Avatar>

      <h2 className="contact-viewer-name">{name}</h2>
      {!isRegistered && (
        <p className="contact-viewer-label">Unregistered user</p>
      )}
    </div>
  );
};
