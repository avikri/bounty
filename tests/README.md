# Tests

Two layers:

| Layer | Location | Needs emulators? | What it covers |
|-------|----------|------------------|----------------|
| Unit | `tests/unit/` | No | DataService's synchronous helpers and Firestore→model mappers (`src/app/core/mappers.ts`). |
| Integration | `tests/integration/` | Yes | Every Cloud Functions callable walking a bounty `available → claimed → pending_review → successful/failed`, plus the allow/deny behaviour of `firestore.rules`. |

## Running

```bash
npm test              # build functions → unit tests → integration tests (one command)

npm run test:unit         # fast, no emulators
npm run test:integration  # boots the emulator suite via `firebase emulators:exec`, runs, tears down
npm run emulators         # just start the emulators (manual poking)
```

`npm run test:integration` starts the Auth, Firestore, Functions and Storage
emulators (ports in `firebase.json`), runs the suite against them, then shuts
them down — no long-lived process to manage.

## Prerequisites

- **JDK 21+** — the Firebase emulators require it (firebase-tools refuses
  Java < 21). `java -version` should print 21 or newer.
- **firebase-tools** on your `PATH` (`firebase --version`).
- Dependencies installed in both the root and `functions/` (`npm install` in each).

The integration runner builds `functions/` first (`npm run build:functions`) so
the emulator runs the latest compiled code.

## How the integration tests work

Each test identity gets its own Web-SDK Firebase app pointed at the emulators
(`tests/integration/emulator.ts`), so a poster, claimant and stranger can act
concurrently with real Auth ID tokens. Data flows through the real surfaces:
groups are created via the `createGroup` callable, members join via
`joinGroup`, bounties are posted with a direct client write (allowed by the
rules), and state transitions go through the callables. Firestore and Auth are
wiped between tests via the emulators' REST `DELETE` endpoints.

## Needs manual verification

These aren't covered by the automated suite and need a real browser / real
services:

- **Google / Apple SSO** (`AuthService.signInWithGoogle` / `signInWithApple`):
  the Auth emulator uses email/password here; the OAuth popup/redirect flows
  must be exercised in a browser against the real providers.
- **Proof file upload from the browser** (`DataService.uploadProofFile` +
  `storage.rules`): the Storage emulator is wired into the suite, but the
  resumable upload, the progress callback, and the image/video + 100 MB
  content-type rules are best confirmed with a real file picker in the app.
- **DataService live wiring**: the `onSnapshot` listener reconciliation, signal
  updates, and the auth-state `effect` need the running Angular app (or a
  browser-based TestBed); the Node unit tests cover only the pure helpers.
- **`onBountyExpiry` scheduled sweep**: the emulator skips scheduled/pubsub
  triggers ("function ignored because the pubsub emulator … is not running"),
  so the nightly expiry sweep needs verification against a deployed environment.
