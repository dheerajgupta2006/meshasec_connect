# Meshasec Connect

**Meetings that move work forward.**

A self-hostable video meeting platform built on LiveKit WebRTC — instant calls, mid-call group expansion, guest access without an account, and real host moderation enforced at the media server rather than in the UI.

Built with Next.js 14 (App Router), TypeScript, Prisma and PostgreSQL.

---

## Features

### Calling

- **Instant and scheduled meetings.** Open a room in one click, or schedule one with a title, time and privacy setting. Every meeting gets a shareable code.
- **Direct 1-on-1 calls.** Call an accepted connection and their device rings — a web push notification with a ringtone, so it reaches them with the tab closed.
- **Dynamic group expansion.** Turn any 1-on-1 into a group call mid-conversation, two ways:
  - *Invite a connection* — rings their device immediately through the incoming-call banner.
  - *Share a link* — a meeting URL plus a 6-digit room passcode for anyone outside your connections.
- **Guest access, no account required.** A guest enters the passcode, gets a signed session bound to that single meeting, waits in the lobby, and the host admits them. Removing a guest writes a real ban, so the passcode won't let them back in.
- **Persistent calls.** Navigate to the dashboard or a DM thread and the call keeps running, with a mini call bar to return. The LiveKit connection lives above the router, so routing never tears down media.

### In-call

- **Screen sharing with viewer-side zoom.** Fit to window, or 50 / 100 / 150 / 200 % of the stream's real resolution, with scrollbars and click-drag panning when zoomed past the viewport.
- **Virtual backgrounds.** Blur, bundled presets, or upload your own image.
- **Polls and Q&A.** Compose a poll privately as a draft, then launch it to the room. Participants vote, ask questions and upvote them; hosts close polls and mark questions answered.
- **Collaborative whiteboard.** Shared freehand drawing over the LiveKit data channel.
- **Live captions and translation.** Speech recognition with on-device translation, so a Telugu speaker and an English speaker can follow each other. Nothing is sent to a translation service — it runs in the browser.
- **Reactions and raised hands**, in-call chat, speaker and gallery layouts, per-participant network quality and mute indicators, and a mirrored self-view toggle.

### Host moderation

Every control below is enforced server-side. The UI hides what you cannot do, but hiding it is not the security boundary.

- **Mute everyone** or one participant.
- **Remove a participant**, with a durable ban so they cannot rejoin.
- **Lock the room** to stop new arrivals without ejecting anyone already in.
- **Waiting room** with an admit queue, for both signed-in users and guests.
- **Co-hosts.** Delegate moderation without handing over ownership. Ending the meeting and appointing co-hosts stay owner-only, so the role cannot self-propagate.
- **Host succession.** If the host closes their tab without leaving, the role passes to someone still in the room — decided from live room occupancy, never guessed from enrollment records.

### Messaging

Direct messages with full-text search, link previews, edit, delete and reply-with-quote. Unread badges, web push, and an in-app toast so a message arriving while you are on another page does not go unnoticed. Optional reader-side and composer-side translation: read a thread in your language, or compose in yours and send in theirs.

### Elsewhere

Calendar invites as downloadable `.ics` files, light/dark/system theming, installable as a PWA, and optional Umami analytics with meeting codes and usernames redacted from every URL before they leave the browser.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 14.2 (App Router), React 18, TypeScript 5 |
| Realtime media | LiveKit — `livekit-client` 2.22, `livekit-server-sdk` 2.18, `@livekit/components-react` 2.9 |
| Auth | Clerk 6.39 |
| Database | PostgreSQL via Prisma 6.19 (built against Neon) |
| Styling | Tailwind CSS 3.4, Radix primitives, `next-themes` |
| Notifications | Web Push (VAPID) via `web-push`, service worker, Resend for email |
| Testing | Vitest 2.1 with `fast-check` property-based tests |

**577 tests across 20 files.** They cover the parts where being wrong is expensive: meeting authorization, poll state transitions and their authority model, guest session signing, passcode handling, SSRF classification, ICS escaping, host succession, language detection and caption buffering. The suite needs no database, no network and no secrets.

---

## Getting started

### Prerequisites

- Node.js 22+
- A PostgreSQL database (Neon works well — its pooled endpoint is what the app expects)
- A [Clerk](https://clerk.com) application
- A [LiveKit](https://livekit.io) project (cloud or self-hosted)

### Setup

```bash
git clone https://github.com/dheerajgupta2006/meshasec_connect.git
cd meshasec_connect
npm install

cp .env.example .env    # then fill in the real values
npm run db:migrate
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Environment variables

`.env.example` documents every variable with the reasoning behind it. The essentials:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Pooled Postgres connection. On Neon the host contains `-pooler`. |
| `DIRECT_URL` | Unpooled endpoint, used only by `prisma migrate` — migrations hold advisory locks a transaction pooler cannot. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` | Clerk auth. |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | Server-side token minting and moderation. |
| `NEXT_PUBLIC_LIVEKIT_URL` | `wss://` URL the browser connects to. |
| `NEXT_PUBLIC_APP_URL` | Your public origin. Used for invite links, calendar files and OG images — set it before deploying. |
| `TRUSTED_APP_ORIGIN` | Allowlist for the Server Action origin check. |

Optional, each enabling one feature:

| Variable | Enables |
|---|---|
| `GUEST_SESSION_SECRET` | Guest access. Must be 32+ chars — generate with `node scripts/generate-guest-secret.js`. Without it, guest join returns 503. |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web push. Generate with `node scripts/generate-vapid.js`. Without them, push silently does nothing. |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | Connection-request emails. |
| `NEXT_PUBLIC_UMAMI_WEBSITE_ID`, `NEXT_PUBLIC_UMAMI_SRC` | Analytics. Both must be set or no tracker is rendered. |

### LiveKit webhook (recommended)

Point your LiveKit project's webhook at `https://<your-origin>/api/livekit/webhook`.

A LiveKit token is validated at connect time and never again, so a removed participant holding a saved token could otherwise reconnect directly to the media server, bypassing the app entirely. This webhook re-checks bans, denials and room lock on every join and evicts anyone barred. Without it, the token TTL is the only bound on that window.

---

## Scripts

```bash
npm run dev          # development server
npm run build        # production build
npm run typecheck    # tsc --noEmit
npm run lint         # next lint
npm test             # vitest, single run
npm run test:watch   # vitest in watch mode

npm run db:migrate   # prisma migrate deploy
npm run db:status    # migration status
npm run db:wake      # wake a sleeping Neon branch (retries a cold start)
npm run roadmap      # feature audit across the codebase
```

Database scripts run through `scripts/with-env.js`, which forces `.env` to win over any stray shell variable and prints the resolved host — a stray `DATABASE_URL` in your shell silently overriding `.env` is a memorable way to lose an afternoon.

---

## Architecture notes

A few decisions that shaped the codebase, recorded because the reasoning is not obvious from the code alone.

**Roles come from the database, never the browser.** The room used to infer the host from metadata, falling back to the earliest connected participant. That guess drifted the moment the real host left: the crown moved to whoever remained while the controls stayed with the owner, so one person saw a badge with no controls and another had controls with no badge.

**Poll and Q&A moderation is authorized by transport, not by payload.** Voting and asking questions travel peer-to-peer, and the actor is the identity the media server stamped on the packet — never a field the sender chose. Launching, closing and marking answered never leave the moderator's browser at all: the browser calls a Server Action, the server proves the role, and the *server* publishes. Those packets arrive with no participant identity, which a browser cannot reproduce. A participant crafting `poll_closed` in the console is ignored by every client in the room.

**Guest sessions are HMAC-signed and bound to one meeting.** A session issued for meeting A is rejected against meeting B, and bans are re-checked when the token is minted rather than only when the passcode is exchanged — otherwise a removed guest's still-valid cookie would let them straight back in.

**Rate limits protect the things that cost something.** Passcode attempts are bounded both per caller and per meeting; the per-meeting counter exists because the per-caller key is derived from a request header a client may be able to choose, and a chosen key means a fresh budget.

**Link previews are fetched through an SSRF classifier** that rejects private address ranges, cloud metadata endpoints, non-HTTP schemes and the IPv4-mapped IPv6 hex form, re-validating on every redirect hop.

**Times render on the client.** Formatting a timestamp during a server render bakes the server's timezone into HTML that wins through hydration, which is how a 10:45 meeting displayed as 04:00.

---

## Deployment

Designed for Vercel. Push to `master` and Vercel's Git integration builds and deploys.

Migrations are run manually rather than in the build step, deliberately: a build runs for every preview branch, and letting it migrate would mutate the production database from unreviewed code.

```bash
npm run db:migrate
```

`.github/workflows/pipeline.yml` runs typecheck, lint and tests on every push. It also contains an opt-in deploy job, enabled with the repository variable `VERCEL_DEPLOY=true`, for teams who would rather nothing reached Vercel on a red build. Leave it unset to let Vercel own deployments.

Remember that `NEXT_PUBLIC_*` variables are inlined at build time — adding one in Vercel requires a redeploy, not just a save.

---

## Project structure

```
src/
├─ app/                        routes, Server Actions, API handlers
│  ├─ api/                     LiveKit tokens, guest admission, push, webhooks
│  ├─ dashboard/               upcoming, ongoing and past meetings
│  ├─ meeting/[code]/          lobby, room, moderation, roles, polls
│  └─ messages/                DM list and threads
├─ components/
│  ├─ meeting/                 call provider, pre-join lobby
│  │  └─ room/                 video grid, dock, drawers, whiteboard, captions
│  └─ messages/                thread, composer, translation
└─ lib/
   ├─ meetings/                authorization, host guard, succession, poll state
   ├─ translation/             on-device translation and speech
   ├─ link-preview/            SSRF guard and fetch pipeline
   └─ push/                    VAPID delivery
prisma/                        schema and 14 migrations
scripts/                       env-safe DB tooling, secret generation, audits
```

---

## License

No license file is present, so all rights are reserved by default. Add one before inviting outside contributions.
