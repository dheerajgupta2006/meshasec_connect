# Implementation Plan: Meeting Creation

## Overview

Implementation follows the dependency order established in the design's [Implementation Inventory](design.md#implementation-inventory): the schema migration first (nothing that touches `MeetingCreationRequest` can compile without it), then the four isomorphic modules, then the server-only modules, then the service, then the Server Action, then the design tokens and UI primitives, and finally the page, form, and error boundary that compose everything else.

Language: TypeScript, matching the existing Next.js 14 App Router codebase.

### Minimum working `/meeting/new`

Tasks **1 through 9** are the feature path. Completing them yields a functioning protected creation page with server validation, idempotent persistence, secure code generation, accessible form behavior, and lobby navigation. No task in that range is optional.

### Hardening and verification

Tasks **10 through 18** add the test runner, the 29 correctness properties, unit and edge-case tests, integration and smoke tests, and the final build gate. Every sub-task in 10 through 17 is marked `*` because the feature is functional without it — skip them for a lean first pass and return to them before shipping. Task 18.1 is not optional.

Files the design lists as [deliberately left unchanged](design.md#files-deliberately-left-unchanged) — `src/middleware.ts`, `src/app/dashboard/page.tsx`, `src/app/meeting/[code]/lobby/page.tsx`, `src/lib/prisma.ts` — have no tasks and must not be edited.

## Tasks

- [ ] 1. Add the idempotency data model and apply the migration
  - [ ] 1.1 Add the `MeetingCreationRequest` model and the `Meeting` back-relation
    - Edit `prisma/schema.prisma`: new model with `id`, `clerkId`, `creationRequestId`, `meetingId @unique`, `createdAt @default(now())`, the `meeting` relation with `onDelete: Cascade`, `@@unique([clerkId, creationRequestId])`, and `@@index([clerkId])`
    - Add `creationRequest MeetingCreationRequest?` to `Meeting`; leave every existing field on `Meeting`, `User`, and `Participant` untouched
    - `clerkId` is a denormalized string, not a foreign key — `User.clerkId` is nullable and the replay lookup must be scoped by the Clerk subject
    - _Design: Data Models > Prisma schema change; Key decisions D3_
    - _Requirements: 6.7, 6.8, 6.9, 8.7, 10.9_

  - [ ] 1.2 Generate the migration and regenerate the Prisma Client
    - Run `npx prisma migrate dev --name add_meeting_creation_request` against the local development database
    - Run `npx prisma generate` so `prisma.meetingCreationRequest` is typed
    - Confirm the emitted `prisma/migrations/<timestamp>_add_meeting_creation_request/migration.sql` matches the design: one `CREATE TABLE`, the `meetingId` unique index, the `clerkId` index, the `(clerkId, creationRequestId)` unique index, and the cascade foreign key — purely additive, no column changes and no backfill
    - Deployed environments apply this with `prisma migrate deploy`, not `migrate dev`
    - _Design: Data Models > Migration approach_
    - _Requirements: 6.7, 6.8, 8.1_

- [ ] 2. Build the isomorphic core modules
  - [ ] 2.1 Create `src/lib/meetings/types.ts`
    - Export `MeetingMode`, `CreationFieldName`, `CreateMeetingInput`, `FORBIDDEN_INPUT_KEYS`, `CreationResult`, `CreationFailure`, `CreateMeetingActionResult`, and the limit constants `TITLE_MIN_CHARS`, `TITLE_MAX_CHARS`, `MAX_CREATION_REQUEST_ID_CHARS`, `MEETING_CODE_CHARS`, `MAX_CODE_ATTEMPTS`, `MAX_PROVISION_ATTEMPTS`
    - `CreateMeetingInput` carries exactly the five client-controlled fields and nothing else
    - `CreationFailure` is a discriminated union returned as a value, never thrown — a throw crossing the Server Action boundary becomes an opaque digest in production and would destroy the field-level error data
    - No imports of Prisma, Clerk, or `node:crypto`
    - _Design: Components and Interfaces > src/lib/meetings/types.ts_
    - _Requirements: 4.3, 6.1, 7.2, 7.5, 10.3, 10.4_

  - [ ] 2.2 Create `src/lib/meetings/validation.ts`
    - Implement `normalizeTitle` (trim only, no Unicode folding), `countCodePoints` via `Array.from`, `hasDisallowedCharacters` via `/\p{Cc}/u` and `/\p{Cf}/u`, and `parseIso8601Instant` (strict, requires an explicit UTC offset, returns `null` when ambiguous)
    - Implement `validateClientInput`: shape, title rules, mode enum, start required and parseable in scheduled mode, end-after-start. No wall-clock comparison — the browser clock can be skewed
    - Implement `validateServerInput(raw, now)`: forbidden-key check first, then all of the above plus strictly-future start against `now`, end-after-start, request-ID shape (32-char hex or UUID, capped at 64 chars), and discarding schedule input in instant mode
    - Return `ValidationOutcome` with field-attributed errors; never throw
    - _Design: Components and Interfaces > src/lib/meetings/validation.ts (rule table); Key decisions D4_
    - _Requirements: 3.3, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 10.3, 10.4_

  - [ ] 2.3 Create `src/lib/meetings/form-state.ts`
    - Implement `CreationDraft`, `FormStatus`, `FormState`, `FormEvent`, `initialFormState`, `draftSignature`, and the pure `meetingCreationReducer` — no `Date.now()`, no crypto, no side effects
    - Enforce the reducer invariants: submit ignored outside `idle`/`error`; failing validation writes `fieldErrors` and sets `focusTarget` to the first invalid field in title/mode/start/end order; `candidateRequestId` adopted only when the current ID is null or the signature changed; no branch ever clears `startsAtLocal` or `endsAtLocal`; `SERVER_FAILED` retains all four draft values and leaves retry enabled; `success` is terminal for submission
    - _Design: Components and Interfaces > src/lib/meetings/form-state.ts; Architecture > Form state machine; Key decisions D8_
    - _Requirements: 3.8, 3.9, 6.2, 6.4, 6.5, 6.6, 6.10, 9.1, 11.1, 11.5, 11.6, 12.5, 12.6_

  - [ ] 2.4 Create `src/lib/meetings/creation-request-id.ts`
    - Implement `mintCreationRequestId`: 16 bytes from `crypto.getRandomValues`, hex-encoded to 32 characters for a full 128 bits
    - Fall back to `crypto.randomUUID()` only when `getRandomValues` is unavailable; both shapes must be accepted by the server check in 2.2
    - _Design: Components and Interfaces > src/lib/meetings/creation-request-id.ts_
    - _Requirements: 6.1_

- [x] 3. Build the server-only support modules
  - [x] 3.1 Create `src/lib/meetings/meeting-code.ts`
    - Begin with `import "server-only"`
    - Implement `generateMeetingCode` as `randomBytes(16).toString("base64url")` from `node:crypto` — exactly 128 bits, exactly 22 unpadded URL-safe characters, no custom encoder and no modulo bias
    - Add a development-only assertion on the 22-character length and the `A-Za-z0-9-_` alphabet
    - _Design: Components and Interfaces > src/lib/meetings/meeting-code.ts; Key decisions D5_
    - _Requirements: 7.1, 7.2, 10.10_

  - [x] 3.2 Create `src/lib/meetings/origin.ts`
    - Begin with `import "server-only"`
    - Implement `assertTrustedOrigin(headerList)` returning `OriginCheck`: when `TRUSTED_APP_ORIGIN` is set it is the sole allowlist, otherwise compare the `Origin` host against `x-forwarded-host` then `host`
    - Exact host and port equality only; a missing `Origin` on a state-changing request is untrusted, and a host that merely ends with an allowed host is untrusted
    - _Design: Components and Interfaces > src/lib/meetings/origin.ts; Key decisions D2_
    - _Requirements: 10.6, 10.7, 10.10_

  - [x] 3.3 Configure the trusted application origin
    - Add `experimental.serverActions.allowedOrigins` to `next.config.mjs` (currently empty) so the framework origin check passes behind a proxy
    - Add `TRUSTED_APP_ORIGIN=http://localhost:3000` to `.env` — append only, do not read back or restate any existing secret values in that file
    - Create `.env.example` documenting `TRUSTED_APP_ORIGIN` alongside the existing key names with placeholder values only, since `.env` is gitignored and there is no template today
    - _Design: Files to modify #2, #6; Files to create #25; Research findings > Server Action origin protection_
    - _Requirements: 10.6, 10.7_

  - [x] 3.4 Create `src/lib/meetings/diagnostics.ts`
    - Begin with `import "server-only"`
    - Implement `FailureStage`, `newCorrelationId`, `redact`, `logOperationalFailure`, and `logProfileDegradation`
    - Implement every redaction rule in the design table: connection strings, `sk_`/`pk_` Clerk keys, three-segment JWTs, bearer tokens, and the literal values of `DATABASE_URL`, `CLERK_SECRET_KEY`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
    - Log one structured `console.error` line per failure with `event: "meeting_creation_failure"`, carrying correlation ID, stage, `clerkId`, `creationRequestId`, `error.name`, the Prisma `error.code` when present, and `redact(error.message)`. Never log the meeting title, schedule values, or session tokens; log stacks in non-production only, still redacted
    - _Design: Components and Interfaces > src/lib/meetings/diagnostics.ts_
    - _Requirements: 10.10, 11.7, 11.8, 11.9_

  - [x] 3.5 Create `src/lib/meetings/user-provisioning.ts`
    - Begin with `import "server-only"`
    - Implement `loadAuthoritativeProfile(correlationId)` mapping the Clerk Backend `User` to `name = fullName ?? firstName ?? username ?? null`, `image = imageUrl || null`, and `verifiedEmail` only when `primaryEmailAddress.verification?.status === "verified"`
    - `currentUser()` returning null or throwing is non-fatal: return `null`, log a degradation record through `logProfileDegradation`, and let provisioning proceed with empty optional fields
    - Implement `buildProvisionPlan(tx, clerkId, profile)`: resolve by `clerkId` first and return the existing row unmodified; on a miss, pre-check the candidate email with `tx.user.findUnique({ where: { email } })` and omit it when it belongs to a different user. `clerkId`-based ownership is never traded away for an email
    - _Design: Components and Interfaces > src/lib/meetings/user-provisioning.ts (resolution order)_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 10.10_

- [ ] 4. Build the Meeting_Creation_Service
  - [ ] 4.1 Create `src/lib/meetings/create-meeting.ts` with validation, replay, and user resolution
    - Begin with `import "server-only"`; export `CreateMeetingCommand` and `createMeeting`
    - Accept dependencies as an optional argument object defaulting to the real implementations (Prisma client, code generator, profile loader, log sink) — this is what makes the zero-writes, single-transaction, and collision properties assertable
    - Call `validateServerInput(rawInput, now)` with `now` as Server_Receipt_Time and return the `validation` failure before touching Prisma
    - Implement the replay read: `findUnique` on `(clerkId, creationRequestId)` joined to `Meeting`, rebuilding `CreationResult` from the committed row rather than the incoming payload, always scoped by the session's `clerkId`
    - Pre-resolve `User` by `clerkId` and load Clerk profile data outside any transaction
    - Resolve rather than reject for every anticipated failure
    - _Design: Components and Interfaces > src/lib/meetings/create-meeting.ts; Data Models > Idempotency replay; Testing Strategy > Test doubles_
    - _Requirements: 2.1, 2.2, 4.7, 5.8, 6.9, 8.1, 10.9_

  - [ ] 4.2 Add the transaction, the attempt loop, and the error taxonomy mapping
    - One interactive transaction per attempt containing only the conditional `User` insert, the `Meeting` insert, and the `MeetingCreationRequest` insert, at Read Committed with `{ maxWait: 5000, timeout: 10000 }`
    - Generate a fresh meeting code per attempt and rely on the unique index for collision detection — no pre-read of the code
    - Disambiguate `P2002` by `error.meta.target`: `meetingCode` retries with a new code up to 5 attempts then `operational`; `clerkId` re-resolves the winner in a new transaction within a 2-attempt provisioning budget; `email` drops the email and retries once; `(clerkId, creationRequestId)` re-reads the winner and replays its result; any other target is `unexpected`
    - Map `P1001`, `P1002`, `P1017`, `P2024` and every other Prisma or unexpected error to `operational` with a correlation ID, logging exactly one diagnostic record
    - Every retry is a new transaction; the previous attempt is fully rolled back, and only inserts ever occur so no preexisting meeting can change
    - _Design: Architecture > Attempt loop and transaction boundary; Error Handling > Stage-by-stage mapping; Key decisions D6, D7_
    - _Requirements: 2.6, 2.7, 2.8, 2.9, 6.8, 7.3, 7.4, 7.5, 7.6, 7.7, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10, 8.11, 11.10, 11.11_

- [ ] 5. Checkpoint - server pipeline compiles
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Expose the service through a Server Action
  - [ ] 6.1 Create `src/app/meeting/new/actions.ts`
    - `"use server"`, exporting `createMeetingAction(input: unknown)` — the parameter is `unknown` on purpose, since Next.js validates the action ID and not the argument's semantics
    - Order: mint the correlation ID, `auth()` inside a `try` (no `userId` is `authorization`/`unauthenticated`, a throw is `operational`), then `assertTrustedOrigin(await headers())`, then delegate to `createMeeting`, then `revalidatePath("/dashboard")` on success
    - Both guards return before any database work
    - `revalidatePath` is for the client Router Cache, not the server render — `/dashboard` already calls `noStore()`
    - _Design: Components and Interfaces > src/app/meeting/new/actions.ts; Key decisions D1, D2_
    - _Requirements: 1.7, 9.6, 10.1, 10.2, 10.5, 10.6, 10.7, 11.12_

- [x] 7. Add the contrast tokens and the two UI primitives
  - [x] 7.1 Add the additive design tokens and the reduced-motion block to `src/app/globals.css`
    - Add `--destructive-text`, `--input-strong`, `--primary-emphasis`, and `--primary-emphasis-foreground` to both the light and dark blocks using the HSL values in the design's token table
    - Add a global `@media (prefers-reduced-motion: reduce)` block neutralizing `animation` and `transition-duration`
    - Additive only: do not change `--destructive`, `--input`, `--primary`, or any other existing token, so no existing component can regress
    - _Design: Accessibility wiring > Contrast findings; Key decisions D9; Files to modify #3_
    - _Requirements: 12.10, 12.11, 12.13_

  - [x] 7.2 Map the new tokens in `tailwind.config.ts`
    - Extend `theme.extend.colors` so `text-destructive-text`, `border-input-strong`, `bg-primary-emphasis`, and `text-primary-emphasis-foreground` resolve
    - _Design: Accessibility wiring > Contrast findings; Files to modify #4_
    - _Requirements: 12.10, 12.11_

  - [x] 7.3 Create `src/components/ui/label.tsx`
    - `Label` forwarding refs to a native `<label>` with new-york typography (`text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70`)
    - No `@radix-ui/react-label` dependency — the wrapper only suppresses pointer-down text selection and adds no accessibility behavior a native `<label>` lacks
    - _Design: Components and Interfaces > New UI components; Key decisions D10_
    - _Requirements: 3.2, 12.2_

  - [x] 7.4 Create `src/components/ui/alert.tsx`
    - `Alert`, `AlertTitle`, `AlertDescription` built with `cva`, variants `default` and `destructive`, no Radix
    - The `destructive` variant uses `text-destructive-text` so error copy clears 4.5:1
    - Do not bake in a role; the caller sets `role="alert"` or `role="status"`
    - _Design: Components and Interfaces > New UI components; Key decisions D10_
    - _Requirements: 3.2, 11.2, 11.3, 12.3, 12.10_

- [ ] 8. Build the page, the form, and the error boundary
  - [ ] 8.1 Create `src/app/meeting/new/page.tsx`
    - Server component shell: `auth()` with a `redirect("/sign-in")` on a missing `userId` as defense in depth behind the middleware, matching the dashboard and lobby pages
    - Render the page heading, concise purpose text, and a `Card` container; export `metadata` with a `title`
    - Layout `mx-auto max-w-2xl px-4 sm:px-6` with no fixed pixel widths. No data fetching, so no `noStore()`
    - _Design: Components and Interfaces > src/app/meeting/new/page.tsx_
    - _Requirements: 1.2, 3.1, 12.8_

  - [ ] 8.2 Create `src/components/meeting/meeting-creation-form.tsx` with its controls and accessibility wiring, and mount it in the page
    - `"use client"`, `useReducer(meetingCreationReducer, initialFormState)` holding all form state
    - Labeled `Input` for the title and the already-installed Radix `Select` for the mode (defaulting to instant, no new `radio-group` dependency); instant-mode explanatory text; conditionally rendered start and optional end `datetime-local` controls with the resolved time zone shown beside them, read in a `useEffect` to avoid a hydration mismatch
    - Cancel is `<Button asChild variant="outline">` wrapping `<Link href="/dashboard">`, so no request can be sent
    - Accessibility: `<Label htmlFor>` on every control plus `aria-labelledby` on the `SelectTrigger`; `aria-invalid` and `aria-describedby` joining hint and error IDs; an unconditionally mounted `<div role="status" aria-live="polite" aria-atomic="true" className="sr-only">`; `aria-busy` on the `<form>`; schedule grid `grid-cols-1 sm:grid-cols-2`; action row `flex flex-col-reverse gap-3 sm:flex-row sm:justify-end`; `h-11 sm:h-10` on inputs and the select trigger and `size="lg"` with `w-full sm:w-auto` on buttons for the 44px target; `min-w-0` and `break-words`; theme tokens only, no hardcoded palette values
    - Import the form into the page shell from 8.1 so nothing is orphaned
    - _Design: Components and Interfaces > src/components/meeting/meeting-creation-form.tsx; Accessibility wiring; Key decisions D11_
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 12.2, 12.3, 12.4, 12.7, 12.8, 12.9, 12.12_

  - [ ] 8.3 Add the submission lifecycle to the form
    - Three duplicate-submit layers: `disabled` on the primary button while loading or successful, a `submitLockRef` flipped synchronously at the top of the handler, and the reducer ignoring submits outside `idle`/`error`
    - Call `mintCreationRequestId()` on every submit and pass it as `candidateRequestId`, letting the reducer decide adoption from `draftSignature`
    - Run `validateClientInput` before the action call; convert `startsAtLocal` with `new Date(value).toISOString()` at submit time
    - Wrap the awaited action call in `try/catch`: a rejected call dispatches an `operational` failure with connectivity guidance and no correlation ID, since no server saw the request
    - Route returned failures to `SERVER_FAILED`: field messages for `validation` with the primary action left enabled, an alert with a sign-in link carrying `redirect_url=/meeting/new` for `authorization`, a safe summary plus correlation ID for `operational`. Retry reuses the same request ID
    - Apply `focusTarget` through a `useEffect` that focuses the matching ref and dispatches `FOCUS_APPLIED`; write `state.announcement` on every state entry without moving focus
    - _Design: Components and Interfaces > meeting-creation-form.tsx (concern table); Error Handling > Client-side error handling_
    - _Requirements: 4.1, 5.3, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.10, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 12.5, 12.6, 12.7_

  - [ ] 8.4 Add success handling and lobby navigation with a fallback
    - `SERVER_SUCCEEDED` sets the success state and the announcement first, then a `useEffect` calls `router.push("/meeting/" + encodeURIComponent(code) + "/lobby")` and arms a 4-second timer
    - A throw from `push`, or the timer firing while still mounted, dispatches `NAVIGATION_FAILED`, revealing a direct `<Link>` built from the stored `CreationResult.meetingCode`
    - Convey the loading state through button text as well as the spinner so it survives reduced motion
    - _Design: Components and Interfaces > meeting-creation-form.tsx (concern table)_
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 12.6, 12.13_

  - [ ] 8.5 Create `src/app/meeting/new/error.tsx`
    - `"use client"` route error boundary receiving `error` and `reset`, rendering an operational-error page with a retry action wired to `reset()` and a link back to the dashboard
    - Render the error `digest` as the correlation reference and never `error.message`. Because the boundary replaces the page, the form is never mounted
    - _Design: Components and Interfaces > src/app/meeting/new/error.tsx_
    - _Requirements: 1.5, 1.6_

- [ ] 9. Checkpoint - minimum working `/meeting/new`
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Set up the test tooling
  - [ ]* 10.1 Add the test script and the nine pinned testing devDependencies
    - Edit `package.json`: `"test": "vitest --run"` (never watch mode in automation) and exact pins for `vitest`, `@vitejs/plugin-react`, `vite-tsconfig-paths`, `jsdom`, `@testing-library/react` (16.x for React 18), `@testing-library/user-event`, `@testing-library/jest-dom`, `fast-check`, `jest-axe` at the versions in the design table
    - _Design: Testing Strategy > Tooling; Files to modify #5_
    - _Requirements: no product requirement of its own; enables verification of 1.x-12.x through tasks 11-16_

  - [ ]* 10.2 Create `vitest.config.ts`
    - jsdom environment, `@vitejs/plugin-react`, `vite-tsconfig-paths` for the `@/*` alias, and the setup file registration
    - _Design: Testing Strategy > Tooling; Files to create #17_
    - _Requirements: no product requirement of its own; enables verification of 1.x-12.x through tasks 11-16_

  - [ ]* 10.3 Create `src/test/setup.ts`
    - Register `@testing-library/jest-dom` and the `jest-axe` matchers
    - _Design: Testing Strategy > Tooling; Files to create #18_
    - _Requirements: no product requirement of its own; enables verification of 12.1-12.3 and the component properties_

- [ ] 11. Write the validation property tests in `src/lib/meetings/__tests__/validation.property.test.ts`
  - [ ]* 11.1 Write property test for title normalization
    - **Property 1: Title normalization is idempotent, boundary-free, and identical on both sides**
    - **Validates: Requirements 4.1, 4.2, 4.6**
    - `fast-check`, minimum 100 runs, tagged `// Feature: meeting-creation, Property 1: ...`
    - _Design: Correctness Properties > Property 1_

  - [ ]* 11.2 Write property test for the title acceptance boundary
    - **Property 2: Title acceptance is exactly the stated boundary**
    - **Validates: Requirements 4.3, 4.4, 4.5**
    - _Design: Correctness Properties > Property 2_

  - [ ]* 11.3 Write property test for local-to-instant conversion
    - **Property 3: Local schedule values convert to instants that round-trip**
    - **Validates: Requirements 5.3, 5.4**
    - _Design: Correctness Properties > Property 3_

  - [ ]* 11.4 Write property test for the Start_Time boundary
    - **Property 4: Start_Time is accepted only when strictly after Server_Receipt_Time**
    - **Validates: Requirements 5.6**
    - _Design: Correctness Properties > Property 4_

  - [ ]* 11.5 Write property test for the End_Time boundary
    - **Property 5: End_Time is accepted only when strictly after Start_Time**
    - **Validates: Requirements 5.7**
    - _Design: Correctness Properties > Property 5_

  - [ ]* 11.6 Write property test for the persisted schedule columns
    - **Property 6: Persisted schedule columns are a total function of Meeting_Mode**
    - **Validates: Requirements 5.9, 5.10, 5.11, 5.12, 5.13**
    - _Design: Correctness Properties > Property 6_

  - [ ]* 11.7 Write unit tests for the validation examples and edge cases in `src/lib/meetings/__tests__/validation.test.ts`
    - Required-start and optional-end messaging, control-character-only titles surviving `.trim()`, zero-width and bidi rejection, and the forbidden-key precedence check
    - One assertion per scenario; the properties already carry input breadth
    - _Design: Testing Strategy > Dual approach; Coverage map (5.1, 5.2)_
    - _Requirements: 4.5, 5.1, 5.2, 10.4_

- [ ] 12. Write the service property tests in `src/lib/meetings/__tests__/create-meeting.property.test.ts`
  - [ ]* 12.1 Write property test for zero writes on rejected input
    - **Property 7: Rejected input produces zero persistence operations**
    - **Validates: Requirements 4.7, 5.8, 10.4**
    - Use the recording Prisma fake from the design's test-doubles table
    - _Design: Correctness Properties > Property 7; Testing Strategy > Test doubles_

  - [ ]* 12.2 Write property test for unauthenticated refusal
    - **Property 8: A request without a verified session is refused before any database work**
    - **Validates: Requirements 1.7, 10.1, 10.2**
    - _Design: Correctness Properties > Property 8_

  - [ ]* 12.3 Write property test for origin trust
    - **Property 9: Origin trust is decided by exact host equality**
    - **Validates: Requirements 10.6, 10.7**
    - _Design: Correctness Properties > Property 9_

  - [ ]* 12.4 Write property test for server-assigned field independence
    - **Property 10: Server-assigned fields are independent of the payload**
    - **Validates: Requirements 4.8, 8.3, 8.4, 8.5, 8.6, 10.3, 10.5**
    - _Design: Correctness Properties > Property 10_

  - [ ]* 12.5 Write property test for the single-transaction commit
    - **Property 11: A successful creation commits one meeting on one transaction and reports what it wrote**
    - **Validates: Requirements 8.2, 8.7, 8.8, 8.9**
    - _Design: Correctness Properties > Property 11_

  - [ ]* 12.6 Write property test for idempotent replay
    - **Property 12: Replaying a completed Creation_Request_ID returns the original result unchanged**
    - **Validates: Requirements 6.9**
    - _Design: Correctness Properties > Property 12_

  - [ ]* 12.7 Write property test for per-subject idempotency scoping
    - **Property 13: Idempotency records are scoped to the session's Clerk subject**
    - **Validates: Requirements 10.9**
    - _Design: Correctness Properties > Property 13_

  - [ ]* 12.8 Write property test for the meeting-code encoding contract
    - **Property 14: Every generated Meeting_Code satisfies the encoding contract**
    - **Validates: Requirements 7.1, 7.2**
    - _Design: Correctness Properties > Property 14_

  - [ ]* 12.9 Write property test for bounded collision retries
    - **Property 15: Bounded collision retries still commit exactly one meeting**
    - **Validates: Requirements 7.4**
    - Drive it with the injectable code generator so the produced codes are controlled exactly
    - _Design: Correctness Properties > Property 15; Testing Strategy > Test doubles_

  - [ ]* 12.10 Write property test for operational failure reporting
    - **Property 24: Operational failures carry a correlation ID, a safe message, and exactly one log record**
    - **Validates: Requirements 8.11, 11.7, 11.8**
    - Assert against the injectable log sink
    - _Design: Correctness Properties > Property 24_

  - [ ]* 12.11 Write unit and edge-case tests for the service failure paths in `src/lib/meetings/__tests__/create-meeting.test.ts`
    - Injected `P2002` schedules for the provisioning race and budget exhaustion, an always-colliding code generator for the fifth-attempt cutoff, and injected unavailability for the Prisma, provisioning, and auth-dependency operational paths
    - _Design: Testing Strategy > Coverage map (2.8, 2.9, 7.5, 7.6, 11.10-11.12)_
    - _Requirements: 2.8, 2.9, 7.5, 7.6, 11.10, 11.11, 11.12_

- [ ] 13. Write the form-state property tests in `src/lib/meetings/__tests__/form-state.property.test.ts`
  - [ ]* 13.1 Write property test for the Creation_Request_ID generator
    - **Property 16: Every generated Creation_Request_ID satisfies the accepted shape and is distinct**
    - **Validates: Requirements 6.1**
    - _Design: Correctness Properties > Property 16_

  - [ ]* 13.2 Write property test for request-ID stability and rotation
    - **Property 17: Creation_Request_ID is stable while values are unchanged and rotates when they change**
    - **Validates: Requirements 6.2, 6.5, 6.6, 6.10**
    - _Design: Correctness Properties > Property 17_

  - [ ]* 13.3 Write property test for ignored submissions
    - **Property 18: Submissions are ignored while a request or result is outstanding**
    - **Validates: Requirements 6.4**
    - _Design: Correctness Properties > Property 18_

  - [ ]* 13.4 Write property test for value preservation across mode changes
    - **Property 19: Mode changes preserve every entered value**
    - **Validates: Requirements 3.8, 3.9**
    - _Design: Correctness Properties > Property 19_

  - [ ]* 13.5 Write property test for value retention on failure
    - **Property 20: Failures preserve every entered value and mirror the reported field errors**
    - **Validates: Requirements 11.1, 11.5**
    - _Design: Correctness Properties > Property 20_

  - [ ]* 13.6 Write property test for status announcements
    - **Property 21: Every state entry produces a new announcement without moving focus**
    - **Validates: Requirements 9.2, 12.6**
    - _Design: Correctness Properties > Property 21_

  - [ ]* 13.7 Write property test for first-invalid-control focus
    - **Property 22: Focus moves to the first invalid control**
    - **Validates: Requirements 12.5**
    - _Design: Correctness Properties > Property 22_

- [ ] 14. Write the diagnostics and dashboard property tests
  - [ ]* 14.1 Write property test for redaction in `src/lib/meetings/__tests__/diagnostics.property.test.ts`
    - **Property 25: Redaction removes every secret and preserves everything else**
    - **Validates: Requirements 11.9**
    - _Design: Correctness Properties > Property 25_

  - [ ]* 14.2 Write property test for the dashboard partition in `src/lib/meetings/__tests__/dashboard-partition.property.test.ts`
    - **Property 26: The dashboard partition and ordering place new meetings correctly**
    - **Validates: Requirements 9.7, 9.8**
    - Exercise the existing partition and sort logic without modifying `src/app/dashboard/page.tsx`
    - _Design: Correctness Properties > Property 26; Data Models > Dashboard visibility_

- [ ] 15. Write the form component tests in `src/components/meeting/__tests__/meeting-creation-form.test.tsx`
  - [ ]* 15.1 Write property test for the lobby path
    - **Property 23: The lobby path round-trips the meeting code**
    - **Validates: Requirements 9.3**
    - _Design: Correctness Properties > Property 23_

  - [ ]* 15.2 Write property test for accessible names and keyboard operability
    - **Property 27: Every rendered control has an accessible name and is keyboard operable**
    - **Validates: Requirements 12.2, 12.4**
    - Use `@testing-library/user-event` for keyboard-only traversal across both modes and all four statuses
    - _Design: Correctness Properties > Property 27_

  - [ ]* 15.3 Write property test for error-to-control association
    - **Property 28: Field errors are programmatically associated with their controls**
    - **Validates: Requirements 12.3**
    - _Design: Correctness Properties > Property 28_

  - [ ]* 15.4 Write property test for token contrast in both themes
    - **Property 29: Every color pair used by the page meets its contrast threshold in both themes**
    - **Validates: Requirements 12.10, 12.11**
    - Compute WCAG 2.1 ratios from the token values in both the light and dark sets
    - _Design: Correctness Properties > Property 29; Accessibility wiring > Contrast findings_

  - [ ]* 15.5 Write rendering unit tests for the page and form
    - Heading, purpose text, card, primary and cancel actions, instant default and its explanatory text, scheduled controls with the time-zone hint, required-start and optional-end marking, the authorization alert with its sign-in action, the operational alert with retry enabled, and `aria-busy` during loading
    - _Design: Testing Strategy > Coverage map (1.1, 3.1, 3.3-3.7, 3.10, 5.1, 5.2, 11.2, 11.3, 11.6, 12.7)_
    - _Requirements: 1.1, 3.1, 3.3, 3.4, 3.5, 3.6, 3.7, 3.10, 11.2, 11.3, 11.6, 12.7_

  - [ ]* 15.6 Write edge-case tests for navigation fallback and connectivity loss
    - Navigation throw and the 4-second timer both revealing the direct lobby link, that link navigating with the stored code, and a rejected action call producing connectivity guidance with no correlation ID
    - Also cover the error boundary's retry action and the form never mounting behind it
    - _Design: Testing Strategy > Coverage map (1.5, 1.6, 9.4, 9.5, 11.4)_
    - _Requirements: 1.5, 1.6, 9.4, 9.5, 11.4_

  - [ ]* 15.7 Add an automated accessibility scan as a conformance floor
    - Run `jest-axe` over the form in both modes and in the error state
    - Record in the test file that this is a floor only: full WCAG 2.1 AA validation requires manual testing with assistive technologies and expert accessibility review, and criteria 12.8, 12.9, 12.12, and 12.13 need a real browser for layout and computed-style checks
    - _Design: Testing Strategy > Dual approach (Not automatable); Coverage map (12.1)_
    - _Requirements: 12.1_

- [ ] 16. Write the integration and smoke tests
  - [ ]* 16.1 Write database integration tests in `src/lib/meetings/__tests__/create-meeting.integration.test.ts`
    - Against a real PostgreSQL database: existing-user selection and first-time provisioning, one retained association under concurrent provisioning, one committed meeting for a concurrent duplicate `(clerkId, creationRequestId)` pair, meeting-code uniqueness enforcement, preexisting meetings unchanged after exhausted attempts, and true rollback on a failed transaction write
    - One to three representative cases each, not 100 — unique-index behavior under concurrency cannot be faked
    - _Design: Testing Strategy > Dual approach; Coverage map (2.2, 2.3, 2.7, 6.7, 6.8, 7.3, 7.7, 8.10)_
    - _Requirements: 2.2, 2.3, 2.7, 6.7, 6.8, 7.3, 7.7, 8.10_

  - [ ]* 16.2 Write route and cache integration tests in `src/app/meeting/new/__tests__/creation-flow.integration.test.ts`
    - Unauthenticated access redirecting to sign-in and returning to `/meeting/new` after completion, authenticated access being permitted, and a committed meeting appearing in the first server-rendered dashboard response
    - _Design: Testing Strategy > Coverage map (1.2, 1.3, 1.4, 9.6)_
    - _Requirements: 1.2, 1.3, 1.4, 9.6_

  - [ ]* 16.3 Write configuration smoke tests in `src/lib/meetings/__tests__/boundaries.smoke.test.ts`
    - One execution each: the code generator draws from the OS CSPRNG, the service is wired to the Prisma singleton, the feature contains no `$queryRaw` or `$executeRaw`, and every server-only module carries `import "server-only"`
    - _Design: Testing Strategy > Dual approach (Smoke tests); Coverage map (7.1, 8.1, 10.8, 10.10)_
    - _Requirements: 7.1, 8.1, 10.8, 10.10_

- [ ] 17. Checkpoint - full suite green
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 18. Final verification
  - [ ]* 18.1 Run the full test suite
    - `npm test` (`vitest --run`), never watch mode
    - Confirm all 29 correctness properties execute and pass
    - _Design: Testing Strategy > Tooling; Coverage map_
    - _Requirements: verifies 1.x-12.x as mapped in the design's coverage map_

  - [ ] 18.2 Run the typecheck, lint, and production build gate
    - `npx tsc --noEmit`, then `npm run lint`, then `npm run build`
    - Fix every reported error before considering the feature complete; a `server-only` import surfacing in a client bundle fails here by design
    - _Design: Implementation Inventory; Architecture > Layers and trust boundaries_
    - _Requirements: 10.10_

## Notes

- **Minimum working `/meeting/new`:** tasks 1-9. Everything in that range is required and none of it is marked optional.
- **Hardening and verification:** tasks 10-17 are all optional (`*`) and can be skipped for a lean first pass. Task 18.2 is required regardless; 18.1 depends on the tooling from task 10.
- Tasks marked with `*` are not implemented automatically. Unmarked sub-tasks are.
- Task 1 is genuinely blocking: Req 6.7, 6.8, 6.9, and 8.7 have no application-level substitute, and `create-meeting.ts` will not typecheck until `npx prisma generate` has run.
- `src/middleware.ts`, `src/app/dashboard/page.tsx`, `src/app/meeting/[code]/lobby/page.tsx`, and `src/lib/prisma.ts` have no tasks by design and must stay unchanged.
- Test file paths in tasks 11.7, 12.11, 16.1, 16.2, and 16.3 extend the design's Implementation Inventory, which enumerates only the property and component test files; the unit, integration, and smoke coverage the Testing Strategy calls for needs somewhere to live.
- Each of the 29 correctness properties is exactly one property-based test built with `fast-check` at a minimum of 100 runs, tagged with its feature and property number.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "2.2", "2.3", "2.4", "3.1", "3.2", "3.3", "3.4", "7.1", "7.2", "10.1"] },
    { "id": 1, "tasks": ["1.2", "3.5", "7.3", "7.4", "10.2", "10.3"] },
    { "id": 2, "tasks": ["4.1", "11.1", "11.7", "13.1", "14.1", "14.2"] },
    { "id": 3, "tasks": ["4.2", "11.2", "13.2"] },
    { "id": 4, "tasks": ["6.1", "11.3", "12.1", "12.11", "13.3"] },
    { "id": 5, "tasks": ["8.1", "11.4", "12.2", "13.4"] },
    { "id": 6, "tasks": ["8.2", "11.5", "12.3", "13.5"] },
    { "id": 7, "tasks": ["8.3", "11.6", "12.4", "13.6"] },
    { "id": 8, "tasks": ["8.4", "12.5", "13.7"] },
    { "id": 9, "tasks": ["8.5", "12.6", "15.1", "16.1", "16.2", "16.3"] },
    { "id": 10, "tasks": ["12.7", "15.2"] },
    { "id": 11, "tasks": ["12.8", "15.3"] },
    { "id": 12, "tasks": ["12.9", "15.4"] },
    { "id": 13, "tasks": ["12.10", "15.5"] },
    { "id": 14, "tasks": ["15.6"] },
    { "id": 15, "tasks": ["15.7"] },
    { "id": 16, "tasks": ["18.1"] },
    { "id": 17, "tasks": ["18.2"] }
  ]
}
```
