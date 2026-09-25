/**
 * Bounds for the group feature, in a module with no dependencies.
 *
 * Separate from `validation.ts` and `queries.ts` for the same reason
 * `messages/search-limits.ts` exists: the query layer is `server-only`, so a
 * client component that wants `maxLength` on an input cannot import from it. The
 * server re-applies every one of these regardless — a `maxLength` attribute is a
 * courtesy to the person typing, not a constraint on what arrives.
 */

export const GROUP_NAME_MIN_CHARS = 2;
export const GROUP_NAME_MAX_CHARS = 60;
export const GROUP_DESCRIPTION_MAX_CHARS = 200;

/**
 * Ceiling on group size, counting the owner.
 *
 * Chosen to match what a call can plausibly carry rather than what the database
 * could hold: starting a group call rings every member and enrolls every member,
 * so this is also the fan-out of one button press.
 */
export const MAX_GROUP_MEMBERS = 50;

/**
 * How many people a new group needs besides its creator.
 *
 * One, because a group of yourself is a notepad, and the create dialog has the
 * member picker in front of the person already.
 */
export const MIN_INITIAL_MEMBERS = 1;

/** Matches the direct-message limit, so moving between the two is not a surprise. */
export const MAX_GROUP_MESSAGE_CHARS = 4000;

/** Newest N messages held in a thread window. */
export const MAX_GROUP_THREAD_MESSAGES = 200;
