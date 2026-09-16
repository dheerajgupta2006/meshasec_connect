/**
 * Product naming, in one place.
 *
 * The app previously shipped both "Meshasec Connect" (header, page titles) and
 * "Meshasec Connext" (emails, calendar descriptions, invite text) — the second
 * being the repository name leaking into user-facing copy. Mixed spelling in a
 * title bar or an emailed invite is the kind of detail people read as careless, so
 * every string now comes from here.
 */

export const APP_NAME = "Meshasec Connect";

export const APP_TAGLINE = "Meetings that move work forward";

export const APP_DESCRIPTION =
  "Secure, high-quality video meetings with a focused pre-join experience and effortless collaboration.";

/** Used in calendar entries and invite text. */
export function meetingDescription(meetingCode: string): string {
  return `${APP_NAME} meeting. Code: ${meetingCode}`;
}
