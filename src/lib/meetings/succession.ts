/**
 * Choosing the next host when the acting one leaves.
 *
 * Pure and dependency-free so the rule is directly testable. The database and
 * LiveKit calls that feed it live in `host-succession.ts`.
 */

export interface SuccessionCandidate {
  /** Local user id. */
  userId: string;
  /** LiveKit identity, i.e. the Clerk subject. */
  identity: string;
  /** When they were enrolled. Earlier wins, so the longest-present takes over. */
  joinedAt: number;
  /** A co-host is preferred: the host already delegated moderation to them. */
  isCoHost: boolean;
  /** False for someone enrolled but not currently connected. */
  isPresent: boolean;
}

/**
 * Picks who should take over, or null when nobody should.
 *
 * Order:
 * 1. Only people actually connected are eligible. Handing the room to someone who
 *    has closed their tab would leave it unmoderated again.
 * 2. A co-host wins over a plain participant — the host already chose to trust
 *    them with these controls.
 * 3. Within a tier, the longest-present person takes over. Deterministic, so every
 *    participant polling concurrently reaches the same answer and the handoff does
 *    not flap between two candidates.
 * 4. `identity` breaks a tie on identical join times, so the result is stable even
 *    for two people enrolled in the same transaction.
 */
export function pickSuccessor(
  candidates: readonly SuccessionCandidate[],
  leavingUserId: string,
): SuccessionCandidate | null {
  const eligible = candidates.filter(
    (candidate) => candidate.isPresent && candidate.userId !== leavingUserId,
  );

  if (eligible.length === 0) {
    return null;
  }

  const ranked = [...eligible].sort((first, second) => {
    if (first.isCoHost !== second.isCoHost) {
      return first.isCoHost ? -1 : 1;
    }

    if (first.joinedAt !== second.joinedAt) {
      return first.joinedAt - second.joinedAt;
    }

    return first.identity.localeCompare(second.identity);
  });

  return ranked[0] ?? null;
}

/**
 * Whether the acting host needs replacing.
 *
 * `actingHostPresent` is a required argument rather than something derived from
 * `candidates`, and that is the whole point. It used to be inferred by looking for
 * the host in the roster — but the roster is built from enrollment rows, and a host
 * who created a meeting through `/meeting/new` has none: nothing enrolls them,
 * because the admission check already lets them in as the owner. Their absence from
 * the roster was therefore read as absence from the *room*, and the host role was
 * handed away the instant anybody else joined.
 *
 * Presence must come from the live room. Making the caller supply it means a
 * missing row can no longer be mistaken for a missing person.
 *
 * True only when the host is genuinely absent *and* somebody else is present. An
 * empty room is left alone: there is nobody to hand it to, and the meeting is about
 * to be retired as finished anyway.
 */
export function needsSuccession(
  candidates: readonly SuccessionCandidate[],
  actingHostId: string,
  actingHostPresent: boolean,
): boolean {
  if (actingHostPresent) {
    return false;
  }

  return candidates.some(
    (candidate) => candidate.isPresent && candidate.userId !== actingHostId,
  );
}
