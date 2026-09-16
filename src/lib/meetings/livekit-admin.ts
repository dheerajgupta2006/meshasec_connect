import "server-only";

/**
 * Server-side LiveKit room administration.
 *
 * These calls act on the live media server, not the database: muting or removing
 * someone here takes effect on their actual published tracks. That makes this the
 * most consequential module in the meeting feature, so every entry point is
 * host-gated by its caller in `src/app/meeting/[code]/moderation.ts`.
 *
 * The admin client is built per call rather than held as a module singleton: it
 * carries the API secret, and a long-lived instance would keep it resident in a
 * module scope that other server code can reach.
 */

import { RoomServiceClient } from "livekit-server-sdk";

export type AdminOutcome =
  | { ok: true }
  | { ok: false; message: string };

const NOT_CONFIGURED =
  "The media server is not configured, so moderation is unavailable.";

/**
 * Resolves the HTTP endpoint for the LiveKit server API.
 *
 * `NEXT_PUBLIC_LIVEKIT_URL` is a WebSocket URL because that is what the browser
 * connects with; the server SDK needs the same host over HTTP(S).
 */
function resolveAdminUrl(): string | null {
  const raw = process.env.LIVEKIT_URL ?? process.env.NEXT_PUBLIC_LIVEKIT_URL;

  if (raw === undefined || raw.trim().length === 0) {
    return null;
  }

  const trimmed = raw.trim();

  try {
    const url = new URL(trimmed);

    if (url.protocol === "wss:") {
      url.protocol = "https:";
    } else if (url.protocol === "ws:") {
      url.protocol = "http:";
    }

    return url.origin;
  } catch {
    return null;
  }
}

function client(): RoomServiceClient | null {
  const url = resolveAdminUrl();
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (
    url === null ||
    apiKey === undefined ||
    apiSecret === undefined ||
    apiKey.length === 0 ||
    apiSecret.length === 0
  ) {
    return null;
  }

  return new RoomServiceClient(url, apiKey, apiSecret);
}

/** True when moderation can work at all, used to disable the UI up front. */
export function moderationConfigured(): boolean {
  return client() !== null;
}

/**
 * Live participant counts, keyed by room name (which is the meeting code).
 *
 * One request for the whole dashboard rather than one per meeting: `listRooms`
 * returns every active room, and LiveKit only keeps a room alive while someone is
 * connected to it. A room absent from this map has nobody in it.
 *
 * Returns null — not an empty map — when LiveKit is unreachable or unconfigured.
 * The distinction matters: "nobody is in any meeting" and "we cannot tell" must
 * lead to different classifications, and conflating them would sweep live
 * meetings into the past list.
 */
export async function listActiveRooms(): Promise<Map<string, number> | null> {
  const service = client();

  if (service === null) {
    return null;
  }

  try {
    const rooms = await service.listRooms();
    const counts = new Map<string, number>();

    rooms.forEach((room) => {
      counts.set(room.name, room.numParticipants);
    });

    return counts;
  } catch {
    return null;
  }
}

export interface RoomOccupant {
  /** LiveKit identity, which this app sets to the Clerk subject. */
  identity: string;
  name: string;
  /** True when at least one microphone track is publishing and unmuted. */
  micLive: boolean;
  cameraLive: boolean;
}

/**
 * Lists who is actually in the room according to the media server.
 *
 * Distinct from `Participant` rows, which record who ever attended. Moderation
 * has to act on the live view.
 */
export async function listOccupants(room: string): Promise<RoomOccupant[]> {
  const service = client();

  if (service === null) {
    return [];
  }

  try {
    const participants = await service.listParticipants(room);

    return participants.map((participant) => {
      const tracks = participant.tracks ?? [];

      return {
        identity: participant.identity,
        name: participant.name.length > 0 ? participant.name : participant.identity,
        micLive: tracks.some(
          (track) => track.source === 2 /* MICROPHONE */ && !track.muted,
        ),
        cameraLive: tracks.some(
          (track) => track.source === 1 /* CAMERA */ && !track.muted,
        ),
      };
    });
  } catch {
    return [];
  }
}

/**
 * Mutes every published track for one participant.
 *
 * Server-side mute is not a request: LiveKit stops forwarding the track, so a
 * client that ignores the UI cannot keep transmitting. Unmuting is deliberately
 * not offered — a host must not be able to switch someone's microphone back on
 * without their consent.
 */
export async function muteParticipant(
  room: string,
  identity: string,
): Promise<AdminOutcome> {
  const service = client();

  if (service === null) {
    return { ok: false, message: NOT_CONFIGURED };
  }

  try {
    const participant = await service.getParticipant(room, identity);
    const audioTracks = (participant.tracks ?? []).filter(
      (track) => track.source === 2 /* MICROPHONE */,
    );

    if (audioTracks.length === 0) {
      // Nothing published: not an error, they simply have no live microphone.
      return { ok: true };
    }

    await Promise.all(
      audioTracks.map((track) =>
        service.mutePublishedTrack(room, identity, track.sid, true),
      ),
    );

    return { ok: true };
  } catch {
    return { ok: false, message: "We could not mute that participant." };
  }
}

/**
 * Mutes everyone except `exceptIdentity`, which is the host running the command.
 *
 * Failures are counted rather than thrown: one unreachable participant must not
 * abandon the rest of the room mid-sweep.
 */
export async function muteEveryoneElse(
  room: string,
  exceptIdentity: string,
): Promise<AdminOutcome> {
  const service = client();

  if (service === null) {
    return { ok: false, message: NOT_CONFIGURED };
  }

  try {
    const participants = await service.listParticipants(room);
    let failures = 0;

    await Promise.all(
      participants
        .filter((participant) => participant.identity !== exceptIdentity)
        .map(async (participant) => {
          const outcome = await muteParticipant(room, participant.identity);

          if (!outcome.ok) {
            failures += 1;
          }
        }),
    );

    return failures === 0
      ? { ok: true }
      : {
          ok: false,
          message: `Muted everyone except ${String(failures)} participant(s) we could not reach.`,
        };
  } catch {
    return { ok: false, message: "We could not mute the room." };
  }
}

/**
 * Disconnects a participant from the room.
 *
 * Removal alone does not prevent a return: their access token is still valid, so
 * the caller must also revoke their enrollment or lock the room. That coupling is
 * handled in the moderation action, not here.
 */
export async function removeOccupant(
  room: string,
  identity: string,
): Promise<AdminOutcome> {
  const service = client();

  if (service === null) {
    return { ok: false, message: NOT_CONFIGURED };
  }

  try {
    await service.removeParticipant(room, identity);
    return { ok: true };
  } catch {
    return { ok: false, message: "We could not remove that participant." };
  }
}
