// The compose panel: where a conversation, and rarely a hub, gets started.
//
// Until 2026-09-02 these were two full-width buttons at the top of the
// sidebar -- "New conversation" above the list, "New hub" above the hubs --
// each unfolding into its form in place. They sat on the most valuable rows
// of a phone's screen, and the second was pressed about once. Both now live
// behind one compose control in the list header, on the panel every other
// secondary surface (Friends, Settings, a hub's details) already uses. The
// hub forms keep their own fold inside it: creating a hub is rare, and the
// public-class copy the form carries has to be read at the moment of
// creation rather than scrolled past on the way to a contact.
//
// Moving the hub button here also closed a defect the roadmap had on file
// as "the New hub button renders a beat late and shifts the layout": it was
// gated on `useFeatures().hubs`, which starts false and flips when
// /account/settings answers, so it appeared after first paint and pushed
// the list down by its own height. Nothing in the sidebar is gated on that
// fetch any more; the same flag now gates a section of this panel, which
// is only ever opened later.

import type { StoredSession } from "../api/session";
import { Panel, PanelSection } from "./kit";
import { NewConversation } from "./sidebar/NewConversation";
import { NewHub } from "./sidebar/NewHub";

export function Compose({
  session,
  canCreateHubs,
  onClose,
  onOpened,
}: {
  session: StoredSession;
  /** The `hubs` feature flag -- gates the hub section, not the panel. */
  canCreateHubs: boolean;
  onClose: () => void;
  /** A conversation or channel to open, the panel closing with it. */
  onOpened: (conversationId: string) => void;
}) {
  return (
    <Panel title="New conversation" onClose={onClose}>
      <PanelSection
        title="Message"
        description="Pick contacts or type usernames. More than one person starts a group."
      >
        <NewConversation session={session} onOpened={onOpened} onCancel={onClose} />
      </PanelSection>

      {canCreateHubs && (
        <PanelSection
          title="Hubs"
          description="A hub is a set of channels for a community. Start one, or join a public one by its id."
        >
          <NewHub onOpened={onOpened} />
        </PanelSection>
      )}
    </Panel>
  );
}
