"use client";

import * as React from "react";

import {
  getMeetingRoles,
  type MeetingRoles,
} from "@/app/meeting/[code]/roles";

/**
 * How often roles are re-read.
 *
 * Roles change mid-call when the host promotes someone, and there is no channel
 * carrying that to the other participants — so it is polled. Unhurried, because a
 * few seconds of delay before a co-host badge appears costs nothing.
 */
const POLL_INTERVAL_MS = 5000;

const EMPTY: MeetingRoles = {
  ok: false,
  hostIdentity: null,
  coHostIdentities: [],
  creatorIdentity: null,
  isHost: false,
  isCoHost: false,
  isCreator: false,
};

interface RolesContextValue extends MeetingRoles {
  /** True for the host or a co-host: the people who see moderation controls. */
  canModerate: boolean;
  /**
   * Every identity entitled to moderate: acting host, co-hosts, and the creator.
   *
   * Exists so features that receive moderation decisions over the data channel can
   * check the actor named in a message against the same set the server gates on.
   * Mirrors `requireMeetingHost` — if these two ever disagree, legitimate actions
   * get silently dropped by recipients.
   */
  moderatorIdentities: string[];
  /** Whether a given LiveKit identity is the host. */
  isHostIdentity: (identity: string) => boolean;
  isCoHostIdentity: (identity: string) => boolean;
  /** Re-reads immediately, so a promotion shows up without waiting for a tick. */
  refresh: () => void;
}

const RolesContext = React.createContext<RolesContextValue | null>(null);

/** Roles for the current meeting. Safe to call anywhere inside the room. */
export function useMeetingRoles(): RolesContextValue {
  const value = React.useContext(RolesContext);

  if (value === null) {
    throw new Error("useMeetingRoles must be used inside MeetingRolesProvider");
  }

  return value;
}

/**
 * Supplies meeting roles from the database.
 *
 * Replaces the previous approach of guessing the host in the browser from room
 * metadata, falling back to the earliest connected participant. That guess moved
 * the crown to whoever remained when the host left, so the badge and the
 * moderation controls could point at two different people.
 */
export function MeetingRolesProvider({
  meetingCode,
  children,
}: {
  meetingCode: string;
  children: React.ReactNode;
}) {
  const [roles, setRoles] = React.useState<MeetingRoles>(EMPTY);

  const inFlightRef = React.useRef(false);
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = React.useCallback(() => {
    if (inFlightRef.current) {
      return;
    }

    inFlightRef.current = true;

    void getMeetingRoles(meetingCode)
      .then((next) => {
        if (mountedRef.current) {
          setRoles(next);
        }
      })
      .catch(() => {
        // A failed read leaves the previous roles in place, which is safer than
        // dropping someone's controls because one request failed.
      })
      .finally(() => {
        inFlightRef.current = false;
      });
  }, [meetingCode]);

  React.useEffect(() => {
    refresh();

    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    }, POLL_INTERVAL_MS);

    // Background tabs have their timers throttled to roughly once a minute, so a
    // promotion granted while the tab was hidden would not appear for a long time.
    // Re-reading on focus makes it appear as soon as the tab is looked at.
    function handleVisibility() {
      if (document.visibilityState === "visible") {
        refresh();
      }
    }

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleVisibility);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleVisibility);
    };
  }, [refresh]);

  const value = React.useMemo<RolesContextValue>(() => {
    const coHosts = new Set(roles.coHostIdentities);

    // Deduplicated because the creator is usually also the acting host, and a
    // moderator listed twice would be harmless but misleading to debug.
    const moderatorIdentities = Array.from(
      new Set(
        [roles.hostIdentity, roles.creatorIdentity, ...roles.coHostIdentities].filter(
          (identity): identity is string => identity !== null,
        ),
      ),
    );

    return {
      ...roles,
      // The creator is included so handing the room over cannot lock them out of
      // moderating a meeting they opened.
      canModerate: roles.isHost || roles.isCoHost || roles.isCreator,
      moderatorIdentities,
      isHostIdentity: (identity: string) =>
        roles.hostIdentity !== null && identity === roles.hostIdentity,
      isCoHostIdentity: (identity: string) => coHosts.has(identity),
      refresh,
    };
  }, [roles, refresh]);

  return (
    <RolesContext.Provider value={value}>{children}</RolesContext.Provider>
  );
}
