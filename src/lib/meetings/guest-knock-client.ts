/**
 * Client helper for the guest knock endpoint.
 *
 * A guest's identity is a signed cookie rather than a Clerk session, so this goes
 * through the API instead of a Server Action — every action in this app resolves
 * the caller from Clerk and would see nobody.
 */

export type GuestKnockState = "admitted" | "waiting" | "denied";

/**
 * Asks to be let in, and reports where the request stands.
 *
 * Safe to poll: the endpoint never resets an existing decision, so repeatedly
 * asking cannot clear a denial. A network failure reports "waiting" rather than
 * "denied" — dropping someone out of the queue because one request failed would be
 * worse than making them wait for the next tick.
 */
export async function requestGuestKnock(
  meetingCode: string,
): Promise<GuestKnockState> {
  try {
    const response = await fetch("/api/meetings/guest/knock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meetingCode }),
      cache: "no-store",
    });

    if (!response.ok) {
      return "waiting";
    }

    const payload: unknown = await response.json();
    const state =
      typeof payload === "object" &&
      payload !== null &&
      typeof (payload as { state?: unknown }).state === "string"
        ? (payload as { state: string }).state
        : null;

    if (state === "admitted" || state === "denied" || state === "waiting") {
      return state;
    }

    return "waiting";
  } catch {
    return "waiting";
  }
}
