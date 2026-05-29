# E2E tests (Playwright)

Browser-level tests for the Bounty app: UI flows, real-time propagation across
two sessions, file upload, responsive layout, auth/routing, and characterization
of the known-incomplete areas. They run against the Firebase emulators and a dev
build of the Angular app, and sit alongside the existing layers:

| Layer | Location | Runner | Needs emulators? |
|-------|----------|--------|------------------|
| Unit | `tests/unit/` | vitest | no |
| Integration (CF + rules + storage + expiry) | `tests/integration/` | vitest | yes |
| **E2E** | `tests/e2e/` | **Playwright** | yes (+ dev server) |

## Running

```bash
npm run test:e2e        # builds functions → boots emulators → Playwright (which boots the e2e dev server)
npm run test:e2e:ui     # same, in Playwright's UI mode
npm run test:all        # unit + integration + e2e
```

`test:e2e` wraps Playwright in `firebase emulators:exec` so Auth/Firestore/
Functions/Storage are up for the whole run. Playwright's `webServer` then boots
the Angular dev server with **`ng serve --configuration e2e`** on
**port 4300** (a dedicated port so it never collides with your normal
`npm start` on 4200). That `e2e` build uses `src/environments/environment.e2e.ts`
(`useEmulators: true`), which points the app at the emulators and installs the
test-only sign-in hook described below.

### Prerequisites

- **JDK 21+** — the emulators require it (same as the integration layer).
- **Playwright browser**: `npx playwright install chromium` (one-time).
- Dependencies installed at the repo root and in `functions/`.

## Auth & seeding model

**Sign-in.** The real login screen only offers Google/Apple **OAuth popups**,
which can't run headless — so OAuth itself is **out of scope and verified
manually** (see below). Instead, the `e2e` build exposes a tiny, emulator-only
hook on `window.__e2e` (`app.config.ts`, gated by `useEmulators`) that signs in
a seeded email/password user against the Auth emulator. Helpers in
`helpers/auth.ts` (`signIn`, `signInAndVisit`, `newSignedInPage`) drive it. The
hook is compiled out of every non-emulator build.

**Personas** (`fixtures/seed.ts`): **A** = group owner, **B** = member,
**C** = admin, **D** = non-member.

**Seeding.** The `seed` fixture (`fixtures/test.ts`) runs before each test that
requests it: it wipes Firestore + Auth (REST `DELETE`, like the integration
layer) and rebuilds the standard state through the **real Cloud Functions**
(`createGroup`/`joinGroup`) + rule-allowed writes — A owns a group, B and C have
joined, C is promoted to admin, D stays outside. Tests run **serially**
(`workers: 1`) since they share one emulator.

- `loginSeedUser(persona)` — a live SDK actor for driving server-side state
  changes mid-test (used by the real-time specs to mutate while the browser
  observes), or to arrange a starting state without re-driving the whole UI.
- `fixtures/admin.ts` — `firebase-admin` helpers for the two things a client
  legitimately can't create: **backdated notifications** (`[I2]`) and **forcing
  an `expired` bounty** (`[F]`).

**Fixtures for upload** live in `test-assets/` (tiny committed `proof*.png`,
`sample.mp4`, `sample.pdf`). The "image over 10 MB" case (`[G3]`) uses an
**in-memory 11 MB buffer** via `setInputFiles({ buffer })` rather than committing
a large binary — file `type` is what the client/rule actually check.

## No flaky waits

Specs use Playwright web-first assertions / auto-waiting locators (`toHaveText`,
`toHaveAttribute`, `toBeVisible`) — never `waitForTimeout`. A note on a subtle
trap we hit: several handlers fire a Firestore write and then navigate
(`approveBounty`, `markNotificationRead`). A full `page.goto` mid-write cancels
the in-flight request, so after such actions we wait for the resulting state
(e.g. a row leaving the review queue) or navigate **client-side** (`goBack`)
rather than reloading.

## Still manual (not automated here)

- **Google / Apple OAuth popups** — emulator uses email/password; the real
  provider popup/redirect must be exercised by hand. This mirrors the
  "Needs manual verification" note in `tests/README.md`.
- **Pure visual polish** (exact spacing/typography at each breakpoint) — Group K
  asserts the *structural* presence/absence of the nav chrome, not pixels.

---

## Coverage report — manual plan → automated test

Every manual case A1–L2 is mapped below. Legend: **U**=unit, **I**=integration
(`functions.spec`/`rules.spec`/`storage.rules.spec`/`expiry.spec`), **E**=E2E
spec, **M**=manual-only.

| Case | Pri | Where | Test |
|------|-----|-------|------|
| A1 post | P0 | E | `a-happy-path.spec` (+ create write covered in `rules.spec`) |
| A2 claim + real-time | P0 | E + I | `a-happy-path` (`claimBounty` in `functions.spec`) |
| A3 submit proof (upload) + real-time | P0 | E + I | `a-happy-path` (`submitProof` in `functions.spec`) |
| A4 approve | P0 | E + I | `a-happy-path` (`approveBounty` in `functions.spec`) |
| A5 settle IOU (two-party) + real-time | P0 | E + I | `a-happy-path` (`markIouPaid` in `functions.spec`) |
| B1 poster can't claim own | P0 | E + I | `b-state` `[B1]` (CF in `functions.spec`) |
| B2 can't claim claimed | P0 | E + I | `b-state` `[B2]` (CF in `functions.spec`) |
| B3 can't submit pre-claim | P0 | E + I | `b-state` `[B3]` (CF in `functions.spec`) |
| B4 non-poster can't approve | P0 | E + I | `b-state` `[B4]` (CF in `functions.spec`) |
| B5 no direct state mutation | P0 | I | `rules.spec` (bounty `update: false`) |
| B6 re-claim expired | P1 | I | `functions.spec` `[B6]` |
| B7 settle settled IOU | P1 | I | `functions.spec` `[B7]` |
| C1 reject + reason surfaced | P0 | E + I | `c-reject` `[C1]` (CF in `functions.spec`) |
| C2 blank reason | P1 | E | `c-reject` `[C2]` |
| C3 points clamp at 0 | P1 | I | `functions.spec` (reject clamp) |
| D1 non-member can't read group | P1 | I | `rules.spec` |
| D2 non-member can't read bounties | P1 | I | `rules.spec` `[D2]` |
| D3 member can't edit other's role | P1 | I | `rules.spec` `[D3]` |
| D4 admin regenerate code | P1 | I | `functions.spec` `[D4]` |
| D5 member can't regenerate (UI) | P1 | E | `d-permissions` `[D5]` |
| D6 owner changes role (UI) | P1 | E + I | `d-permissions` `[D6]` (rule in `rules.spec`) |
| D7 member can leave | P2 | I | `rules.spec` |
| D8 join wires side-effects | P1 | I | `functions.spec` `[D8]` |
| D9 bad invite code | P1 | I | `functions.spec` |
| D10 idempotent join | P2 | I | `functions.spec` |
| E1 feed live | P1 | E | `e-realtime` `[E1]` |
| E2 review queue live | P1 | E | `e-realtime` `[E2]` |
| E3 inbox live | P1 | E | `e-realtime` `[E3]` |
| E4 leaderboard live | P1 | E | `e-realtime` `[E4]` |
| F1 expire from available | P1 | I | `expiry.spec` `[F1]` |
| F2 expire from claimed (no penalty) | P1 | I | `expiry.spec` `[F2]` |
| F3 excluded from active counts | P1 | I + E | `expiry.spec` `[F3]` + `f-expiry` (badge/feed) |
| G1 three files | P1 | E | `g-upload` `[G1]` |
| G2 fourth rejected | P1 | E | `g-upload` `[G2]` |
| G3 image > 10 MB rejected | P1 | E | `g-upload` `[G3]` (10 MB-vs-100 MB gap documented) |
| G4 video accepted | P1 | E + I | `g-upload` `[G4]` + `storage.rules.spec` `[G4]` |
| G5 pdf rejected | P1 | E + I | `g-upload` `[G5]` + `storage.rules.spec` `[G5]` |
| G6 lightbox | P1 | E | `g-upload` `[G6]` |
| G7 note-only | P2 | E | `g-upload` `[G7]` |
| Storage rule claimant/content-type/uid gating | — | I | `storage.rules.spec` |
| H1 points/wins/losses math | P1 | I | `functions.spec` `[H1]` (multi-cycle aggregate) |
| H2 podium top 3 | P1 | E | `h-leaderboard` `[H2]` |
| H3 rank ordering | P2 | E | `h-leaderboard` `[H3]` |
| H4 time-range no-op | P1 | E | `l-known-gaps` `[L2][H4]` (shared characterization) |
| I1 every kind + colour | P1 | E | `i-inbox` `[I1]` (creation in `functions.spec`) |
| I2 day grouping | P2 | E | `i-inbox` `[I2]` (backdated via admin) |
| I3 mark one read | P1 | E | `i-inbox` `[I3]` |
| I4 mark all read | P1 | E | `i-inbox` `[I4]` |
| J1 signed-out redirect + return path | P1 | E | `j-auth` `[J1]` (guard now sets `?redirect=`) |
| J2 public routes | P1 | E | `j-auth` `[J2]` |
| J3 unknown route fallback | P2 | E | `j-auth` `[J3]` |
| J4 session persistence | P2 | E | `j-auth` `[J4]` |
| K1 mobile chrome (<960) | P2 | E | `k-responsive` `[K1]` |
| K2 desktop right rail (≥1200) | P2 | E | `k-responsive` `[K2]` |
| K3 review split panel + `?id` | P2 | E | `k-responsive` `[K3]` |
| K visual polish | P2 | **M** | structural asserted; pixels manual |
| L1 profile page | P1 | E | `l-known-gaps` `[L1]` (characterization) |
| L2 leaderboard time-range gap | P1 | E | `l-known-gaps` `[L2][H4]` (characterization) |

### App changes made to support these tests
- `functions/src/expiry.ts` — extracted `runBountyExpiry(db, now)`; `index.ts`
  now calls it from the scheduled trigger (lets `[F]` be tested deterministically).
- `auth.guard.ts` — redirects to `/login` with `?redirect=<url>` (`[J1]`).
- `app.config.ts` + `environment.e2e.ts` + `angular.json` `e2e` config — the
  emulator-only `window.__e2e` sign-in hook and the e2e build/serve target.
- `data-testid` attributes added across the flow components (state-badge,
  bounty-card, feed, detail CTAs, claim-submit, review-queue, inbox, leaderboard,
  proof-gallery, app-shell, profile, group-settings, group-list, create, login,
  join-by-code).
