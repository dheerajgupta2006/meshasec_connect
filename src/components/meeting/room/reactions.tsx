"use client";

import { useDataChannel, useRoomContext } from "@livekit/components-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { Participant, RemoteParticipant } from "livekit-client";
import { RoomEvent } from "livekit-client";
import { Hand } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

/** The emoji palette offered by the reaction picker. */
export const REACTION_EMOJIS = ["👍", "👏", "❤️", "😂", "🎉"] as const;

export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

/**
 * All in-call UX chatter travels on one topic. LiveKit has a single data
 * channel, so the topic is only a filter — it does not open a second channel.
 */
const REACTION_TOPIC = "meshasec-room-ux";

/** How long a floating emoji lives, in milliseconds. */
const REACTION_LIFETIME_MS = 2600;

/** Ceiling on concurrent floating emojis so a spammer cannot exhaust memory. */
const MAX_FLOATING_REACTIONS = 24;

/** Longest payload we will even try to parse. Remote input is untrusted. */
const MAX_PAYLOAD_BYTES = 512;

export interface RaisedHand {
  identity: string;
  name: string;
  raisedAt: number;
}

export interface FloatingReaction {
  id: string;
  identity: string;
  emoji: ReactionEmoji;
  /** Horizontal jitter in pixels so stacked emojis do not overlap exactly. */
  offset: number;
}

interface ReactionsContextValue {
  /** Raised hands as a priority queue: earliest raise first. */
  raisedHands: readonly RaisedHand[];
  localHandRaised: boolean;
  isHandRaised: (identity: string) => boolean;
  toggleHand: () => void;
  sendReaction: (emoji: ReactionEmoji) => void;
  reactionsFor: (identity: string) => readonly FloatingReaction[];
}

const ReactionsContext = React.createContext<ReactionsContextValue | null>(null);

/** The only message shapes we accept off the wire. */
type ReactionMessage =
  | { kind: "reaction"; emoji: ReactionEmoji }
  | { kind: "hand"; raised: boolean };

function isReactionEmoji(value: unknown): value is ReactionEmoji {
  return (
    typeof value === "string" &&
    (REACTION_EMOJIS as readonly string[]).includes(value)
  );
}

/**
 * Decodes an untrusted data-channel payload. Returns `null` for anything that
 * is not an exact match for a shape we understand, so a malformed or hostile
 * message from another client can only ever be a no-op.
 */
function parsePayload(payload: Uint8Array): ReactionMessage | null {
  if (payload.byteLength === 0 || payload.byteLength > MAX_PAYLOAD_BYTES) {
    return null;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const record: Record<string, unknown> = parsed as Record<string, unknown>;

  if (record.kind === "reaction" && isReactionEmoji(record.emoji)) {
    return { kind: "reaction", emoji: record.emoji };
  }

  if (record.kind === "hand" && typeof record.raised === "boolean") {
    return { kind: "hand", raised: record.raised };
  }

  return null;
}

function displayNameOf(participant: Participant): string {
  const name = participant.name;
  if (typeof name === "string" && name.trim().length > 0) {
    return name.trim();
  }
  return participant.identity;
}

/**
 * Owns reaction and hand-raise state for the whole call.
 *
 * State is keyed by participant identity and is driven entirely by
 * data-channel messages. LiveKit does not loop your own messages back, so
 * local actions are echoed into state directly.
 */
export function ReactionsProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const room = useRoomContext();

  const [hands, setHands] = React.useState<readonly RaisedHand[]>([]);
  const [floating, setFloating] = React.useState<readonly FloatingReaction[]>(
    [],
  );
  const [localHandRaised, setLocalHandRaised] = React.useState(false);

  const timersRef = React.useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const mountedRef = React.useRef(true);
  const localHandRef = React.useRef(false);
  const sequenceRef = React.useRef(0);

  React.useEffect(() => {
    // The Set instance is created once, so capturing it here is safe and keeps
    // the cleanup honest about which collection it is draining.
    const timers = timersRef.current;
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      timers.forEach((timer) => {
        clearTimeout(timer);
      });
      timers.clear();
    };
  }, []);

  const addFloating = React.useCallback(
    (identity: string, emoji: ReactionEmoji) => {
      sequenceRef.current += 1;
      const sequence = sequenceRef.current;
      const id = `${identity}:${sequence}`;
      // Deterministic spread instead of Math.random: stable across renders.
      const offset = ((sequence * 37) % 72) - 36;

      setFloating((current) => {
        const trimmed =
          current.length >= MAX_FLOATING_REACTIONS
            ? current.slice(current.length - MAX_FLOATING_REACTIONS + 1)
            : current;
        return [...trimmed, { id, identity, emoji, offset }];
      });

      const timer = setTimeout(() => {
        timersRef.current.delete(timer);
        if (!mountedRef.current) {
          return;
        }
        setFloating((current) => current.filter((item) => item.id !== id));
      }, REACTION_LIFETIME_MS);

      timersRef.current.add(timer);
    },
    [],
  );

  const applyHand = React.useCallback(
    (identity: string, name: string, raised: boolean) => {
      setHands((current) => {
        const existing = current.find((hand) => hand.identity === identity);

        if (!raised) {
          return existing === undefined
            ? current
            : current.filter((hand) => hand.identity !== identity);
        }

        // Keep the original timestamp so queue position is not reset by a
        // duplicate or replayed "raised" message.
        if (existing !== undefined) {
          return current;
        }

        return [...current, { identity, name, raisedAt: Date.now() }];
      });
    },
    [],
  );

  const handleIncoming = React.useCallback(
    (payload: Uint8Array, from: Participant | undefined) => {
      if (from === undefined) {
        return;
      }

      const identity = from.identity;
      if (identity.length === 0) {
        return;
      }

      const message = parsePayload(payload);
      if (message === null) {
        return;
      }

      if (message.kind === "reaction") {
        addFloating(identity, message.emoji);
        return;
      }

      applyHand(identity, displayNameOf(from), message.raised);
    },
    [addFloating, applyHand],
  );

  // A ref keeps the subscription callback identity stable for the lifetime of
  // the provider, so the data-channel listener is never torn down mid-call.
  const handleIncomingRef = React.useRef(handleIncoming);
  React.useEffect(() => {
    handleIncomingRef.current = handleIncoming;
  }, [handleIncoming]);

  const onDataMessage = React.useCallback(
    (message: { payload: Uint8Array; from?: Participant }) => {
      handleIncomingRef.current(message.payload, message.from);
    },
    [],
  );

  const { send } = useDataChannel(REACTION_TOPIC, onDataMessage);

  const sendRef = React.useRef(send);
  React.useEffect(() => {
    sendRef.current = send;
  }, [send]);

  const broadcast = React.useCallback((message: ReactionMessage) => {
    const payload = new TextEncoder().encode(JSON.stringify(message));
    // A dropped reaction is cosmetic; never surface a failure to the user.
    void sendRef.current(payload, { reliable: true }).catch(() => undefined);
  }, []);

  const sendReaction = React.useCallback(
    (emoji: ReactionEmoji) => {
      addFloating(room.localParticipant.identity, emoji);
      broadcast({ kind: "reaction", emoji });
    },
    [addFloating, broadcast, room],
  );

  const toggleHand = React.useCallback(() => {
    const next = !localHandRef.current;
    localHandRef.current = next;
    setLocalHandRaised(next);

    const local = room.localParticipant;
    applyHand(local.identity, displayNameOf(local), next);
    broadcast({ kind: "hand", raised: next });
  }, [applyHand, broadcast, room]);

  React.useEffect(() => {
    function handleDisconnected(participant: RemoteParticipant) {
      const identity = participant.identity;
      setHands((current) =>
        current.some((hand) => hand.identity === identity)
          ? current.filter((hand) => hand.identity !== identity)
          : current,
      );
      setFloating((current) =>
        current.some((item) => item.identity === identity)
          ? current.filter((item) => item.identity !== identity)
          : current,
      );
    }

    function handleConnected() {
      // Late joiners have no history, so re-announce a still-raised hand.
      if (localHandRef.current) {
        broadcast({ kind: "hand", raised: true });
      }
    }

    room.on(RoomEvent.ParticipantDisconnected, handleDisconnected);
    room.on(RoomEvent.ParticipantConnected, handleConnected);

    return () => {
      room.off(RoomEvent.ParticipantDisconnected, handleDisconnected);
      room.off(RoomEvent.ParticipantConnected, handleConnected);
    };
  }, [broadcast, room]);

  const sortedHands = React.useMemo(
    () => [...hands].sort((left, right) => left.raisedAt - right.raisedAt),
    [hands],
  );

  const isHandRaised = React.useCallback(
    (identity: string) => hands.some((hand) => hand.identity === identity),
    [hands],
  );

  const reactionsFor = React.useCallback(
    (identity: string) => floating.filter((item) => item.identity === identity),
    [floating],
  );

  const value = React.useMemo<ReactionsContextValue>(
    () => ({
      raisedHands: sortedHands,
      localHandRaised,
      isHandRaised,
      toggleHand,
      sendReaction,
      reactionsFor,
    }),
    [
      isHandRaised,
      localHandRaised,
      reactionsFor,
      sendReaction,
      sortedHands,
      toggleHand,
    ],
  );

  return (
    <ReactionsContext.Provider value={value}>
      {children}
    </ReactionsContext.Provider>
  );
}

/** Reads reaction state. Throws when used outside `ReactionsProvider`. */
export function useReactions(): ReactionsContextValue {
  const context = React.useContext(ReactionsContext);
  if (context === null) {
    throw new Error("useReactions must be used inside a ReactionsProvider");
  }
  return context;
}

/**
 * Floating emojis over one participant's tile.
 *
 * Motion is skipped when the OS asks for reduced motion; the emoji still
 * appears and still disappears, it just does not travel.
 */
export function ReactionOverlay({
  identity,
}: {
  identity: string;
}): React.JSX.Element {
  const { reactionsFor } = useReactions();
  const shouldReduceMotion = useReducedMotion() === true;
  const items = reactionsFor(identity);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <AnimatePresence initial={false}>
        {items.map((item) => (
          <motion.span
            key={item.id}
            className="absolute bottom-14 left-1/2 select-none text-3xl drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]"
            initial={{ opacity: 0, y: 8, x: item.offset, scale: 0.5 }}
            animate={
              shouldReduceMotion
                ? { opacity: 1, y: 0, x: item.offset, scale: 1 }
                : { opacity: [0, 1, 1, 0], y: -150, x: item.offset, scale: 1 }
            }
            exit={{ opacity: 0, scale: 0.8 }}
            transition={
              shouldReduceMotion
                ? { duration: 0 }
                : { duration: REACTION_LIFETIME_MS / 1000, ease: "easeOut" }
            }
          >
            {item.emoji}
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  );
}

/** Small hand chip rendered on the tile of a participant with a raised hand. */
export function RaisedHandIndicator({
  className,
}: {
  className?: string;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "grid h-7 w-7 place-items-center rounded-full bg-amber-400 text-zinc-950 shadow-lg",
        className,
      )}
      title="Hand raised"
    >
      <Hand className="h-4 w-4" aria-hidden="true" />
      <span className="sr-only">Hand raised</span>
    </span>
  );
}

/** Emoji palette plus the hand-raise toggle, used inside the dock popover. */
export function ReactionPicker({
  onAfterSelect,
}: {
  onAfterSelect?: () => void;
}): React.JSX.Element {
  const { sendReaction, toggleHand, localHandRaised } = useReactions();

  return (
    <div className="p-2">
      <div
        role="group"
        aria-label="Send a reaction"
        className="flex items-center justify-between gap-1"
      >
        {REACTION_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            aria-label={`Send the ${emoji} reaction`}
            title={`Send ${emoji}`}
            onClick={() => {
              sendReaction(emoji);
              onAfterSelect?.();
            }}
            className="grid h-11 w-11 place-items-center rounded-lg text-2xl transition-transform hover:scale-110 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span aria-hidden="true">{emoji}</span>
          </button>
        ))}
      </div>

      <button
        type="button"
        aria-pressed={localHandRaised}
        aria-label={localHandRaised ? "Lower your hand" : "Raise your hand"}
        onClick={() => {
          toggleHand();
          onAfterSelect?.();
        }}
        className={cn(
          "mt-2 flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          localHandRaised
            ? "border-amber-400 bg-amber-400 text-zinc-950 hover:bg-amber-300"
            : "border-border bg-transparent hover:bg-accent",
        )}
      >
        <Hand className="h-4 w-4" aria-hidden="true" />
        {localHandRaised ? "Lower hand" : "Raise hand"}
      </button>
    </div>
  );
}
