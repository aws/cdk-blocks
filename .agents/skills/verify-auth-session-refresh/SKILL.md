---
name: verify-auth-session-refresh
description: Check a change to the bb-auth session refresh and sign-out path against its TLA+ model. Use when a diff touches resolveSession, sessionAfterLostWrite, refreshRecord or signOut in packages/bb-auth/src/auth-base.ts, SessionStore in packages/bb-auth/src/sessions.ts, or anything under formal/auth-session-refresh, and when `npm run check:formal` or the "Check the formal models" step of PR Checks fails.
---

# Verify the auth session refresh

Several requests can refresh one session at once, and `signOut` can delete it while a refresh is in flight. The code promises that the result does not depend on which request lands last. Unit tests reach only the orderings someone wrote down. The model in `formal/auth-session-refresh/SessionRefresh.tla` checks every ordering of two requests and one sign-out.

## What is checked

Each invariant is a sentence the code already states.

| Invariant | Sentence | Harm when it breaks |
|---|---|---|
| `SignOutSticks` | `resolveSession`: "a refresh that finishes after sign-out never restores the session" | A user signs out and a copy of the cookie keeps working. |
| `NoStaleDelete` | `resolveSession`: "a request whose refresh was rejected never deletes the session another request has just refreshed" | A user is signed out at random when two tabs refresh together. |
| `NoStaleOverwrite` | `replaceIfUnchanged`: "A stale writer therefore never recreates a deleted session or overwrites a newer one." | A deleted session comes back, or newer tokens are lost. |
| `AnswersComeFromTheStore` | `sessionAfterLostWrite`: "Serve the session a concurrent refresh wrote if it is still live. If the session was deleted (`signOut`, revoke), clear the cookie — it stays signed out." | A request is answered as signed in with tokens the store does not hold. |

`formal/models.json` lists the runs. `Head.cfg` is the code as it is and must hold. Each `PreFix.<Invariant>.cfg` sets `ConditionalWrites = FALSE`, which swaps in the writes this path had before #1314 (commit `579c6a826`), and must violate its invariant. Those runs prove that each invariant can still fail.

## Does your diff touch the covered code?

`npm run check:formal` tells you. `formal/models.json` records, under `covers`, a digest of the text of each function the model describes. When one of them changes, the check fails with `the code it describes changed` and names the function, before it runs TLC.

A change to a function in this table matters to the model when it adds, removes, reorders or makes conditional a store or engine call, or changes a value written or returned. A change that does none of that (a log line, a rename) still fails the check until you confirm it.

| Model action | File | Function |
|---|---|---|
| `Read` | `packages/bb-auth/src/auth-base.ts` | `resolveSession`, up to the expiry check. Calls `SessionStore.read` in `sessions.ts`. |
| `RefreshRecordRefreshed`, `RefreshRecordRejected`, `RefreshRecordThrows` | `packages/bb-auth/src/auth-base.ts` | `refreshRecord`, and the `try`/`catch` around it in `resolveSession` |
| `ReplaceIfUnchanged` | `packages/bb-auth/src/sessions.ts` | `SessionStore.replaceIfUnchanged`, `unchangedSince`, `versionOf` |
| `DeleteIfUnchanged` | `packages/bb-auth/src/sessions.ts` | `SessionStore.deleteIfUnchanged`, `unchangedSince`, `versionOf` |
| `SessionAfterLostWrite` | `packages/bb-auth/src/auth-base.ts` | `sessionAfterLostWrite`. Calls `SessionStore.lookup`. |
| `Respond` | `packages/bb-auth/src/auth-base.ts` | the `return` and `throw` statements of `resolveSession` |
| `SignOutLookup`, `SignOutDelete` | `packages/bb-auth/src/auth-base.ts` | `signOut`. Calls `SessionStore.lookup` and `SessionStore.delete`. |
| `Init` | `packages/bb-auth/src/sessions.ts` | `SessionStore.create` (the row starts at `version` 1) |

A new caller of a `SessionStore` method that writes or deletes a session row is covered too, because it is a new writer of the row.

## Check a change

The model does not read the code. A pass says nothing about your change until the model describes it.

1. For each function you changed, edit its action in `SessionRefresh.tla` so that it does what the code now does: the same store calls in the same order, the same condition, the same value written and returned. One `await` on the store or the engine is one action. Keep the header table of the spec in step. A change that touches no store or engine call needs no edit.
2. Record that you compared them. This rewrites the digests in `formal/models.json`:

   ```sh
   node scripts/check-formal-models.mjs --confirm
   ```

3. Run the check. It needs Java 11 or later and takes a few seconds.

   ```sh
   npm run check:formal
   ```

   The first run downloads the TLC jar of the pinned release (1.7.4) into `.cache/` and verifies its checksum. Set `TLA2TOOLS_JAR` to use a jar you already have.
4. Run the replay tests on the real code (below).

## Read a result

A pass prints one `ok` line for each run, with TLC's state count. At commit `8fc2801a4`, `Head.cfg` reports `1675 states generated, 761 distinct states found`.

A failure prints `FAIL`, the config, what TLC found and, for a violated invariant, TLC's counterexample. Each state of the counterexample names the action that led to it. The request that took the step is the one whose `pc` entry changed. Read the action names with the table above.

- `Head.cfg: violates <Invariant>`: some ordering breaks that sentence in the model of the current code.
- `PreFix.<Invariant>.cfg: holds`, or it violates another invariant: the invariant can no longer fail on the bug it was written for, so it no longer guards anything. A changed invariant or a changed pre-fix action causes this.
- `TLC failed`: TLC's whole output follows. The usual causes are a syntax error in the spec, an invariant name in a config or in `models.json` that the spec does not define, and a deadlock (a request reached a step that no action continues).

If you have the `/statechart` skill, read every result with it, on `SessionRefresh.tla` with the config in question. It reports each violated invariant as its shortest path, one line for each step, and lists the invariants that hold. Follow that skill for its commands. Without it, TLC's own counterexample above carries the same steps.

## A real bug or a model error?

A counterexample is a claim about the code. Replay it against the code before you believe it.

1. Check each step of the counterexample against its function. If the model takes a step the code cannot take, or skips an `await` where another request can run, the model is wrong. Fix the model.
2. Replay the steps as a test. Three tests in `packages/bb-auth/src/index.aws.session.test.ts` already drive these orderings. Each one runs the other request's store write inside the fake Cognito handler (`h.on('GetTokensFromRefreshTokenCommand', async () => { ... })`), which is the point between this request's `Read` and its conditional write:

   | Test | Ordering | Invariants |
   |---|---|---|
   | `a refresh that completes after sign-out does not restore the session` | `Read`, `SignOutDelete`, `RefreshRecordRefreshed`, `ReplaceIfUnchanged`, `SessionAfterLostWrite` | `SignOutSticks`, `NoStaleOverwrite`, `AnswersComeFromTheStore` |
   | `a rejected refresh never deletes the session a concurrent request just refreshed` | `Read`, the other request's write, `RefreshRecordRejected`, `DeleteIfUnchanged`, `SessionAfterLostWrite` | `NoStaleDelete` |
   | `a refresh whose write loses to a concurrent refresh serves the concurrent one and writes nothing` | `Read`, the other request's write, `RefreshRecordRefreshed`, `ReplaceIfUnchanged`, `SessionAfterLostWrite` | `NoStaleOverwrite`, `AnswersComeFromTheStore` |

   Run them on compiled output. The first build is `npm ci && npm run build` from the repository root. After each edit:

   ```sh
   npx tsc --build packages/bb-auth
   cd packages/bb-auth && node --test --test-concurrency=1 dist/index.aws.session.test.js
   ```

   A fourth test, `rewrites the same record with the new tokens (keeping the refresh token when not rotated) and slides the TTL`, pins the write itself: its version and its condition. If the counterexample is an ordering that none of these covers, add a test in the same style, one handler step for each action of the other request.
3. If the test fails as the counterexample says, the bug is real. Report it with the steps in the code's words. Do not weaken the invariant or the model to get a pass. If the test passes, treat the model as wrong until you find the step where it and the code differ.

## Update the model for an intended change

- The code changes how it keeps a promise (a new condition, a different order of calls): change the actions, keep the invariants, and run the check.
- The promise itself changes: change the JSDoc sentence first, then the invariant, and quote the new sentence above it in the spec. Keep one run in `formal/models.json` that violates the invariant with `expect: "violates"`, so that it stays able to fail. TLC stops at the first violation, so each such run lists one invariant.
- A new invariant needs a sentence in the code to quote, a place in `Head.cfg`, and its own violating run.
- Never edit `expect` or a `why` in `formal/models.json` to make the check pass.

A function the model newly describes goes under `covers` in `formal/models.json` with an empty digest; `--confirm` fills it in.

## Scope

Bounds:

- Two requests with the same session cookie, each resolving its session once, and one `signOut`. One session row.
- No version passes 3. `TypeOK` fails if one does.

Assumptions:

- Each `SessionStore` call is one step. A conditional write (`replaceIfUnchanged`, `deleteIfUnchanged`) is one step because it is one DynamoDB conditional request, built in `packages/bb-kv-store`.
- The clock is not modelled. A row that exists can be served as it is or refreshed, which covers an expired access token and `forceRefresh`. After a lost write, a row that exists can be served or answered as unauthenticated.
- Each refresh returns tokens, returns `null` or throws, whatever happened before. The model knows nothing about refresh-token rotation or about what the identity provider does after sign-out.
- Store and secret calls do not fail.

Left out:

- `SessionStore.isRevoked` and the unconditional delete that follows it in `resolveSession`.
- The other unconditional deletes of a session row (`deleteUser`, an account call for a user who no longer exists, `admin.revokeUserSessions`, the sign-in rollback, DynamoDB TTL). Each acts on the row as `SignOutDelete` does, but the model runs only one of them.
- The cookie: which response sets or clears it.
- Bearer tokens, session creation, more than two requests, a request that refreshes twice.
- Whether a request ever answers. The model checks only what must never happen.

Modelled but not checked: "an engine *throwing* is treated as transient: the session is kept" (`packages/bb-auth/DESIGN.md`, Guards). `RefreshRecordThrows` writes nothing when `ConditionalWrites` is `TRUE`, and no invariant watches it. The test `a transient refresh failure keeps the session and is a retriable 5xx (added for Auth)` in the same test file covers it.

Allowed by the model and by the code: a rejected refresh that deletes the row first ends the session, also when the identity provider accepted a concurrent refresh. That request finds the row gone and answers as unauthenticated.

## The past bug, as the model tells it

With `ConditionalWrites = FALSE`, the shortest counterexample has five steps and breaks `AnswersComeFromTheStore`:

1. A request reads the session. Its access token has expired.
2. Its refresh succeeds at the identity provider.
3. `signOut` for the same cookie looks the session up.
4. `signOut` deletes the row.
5. The request's `updateSession` reads the row, finds none and returns without writing. The request still answers as signed in, with the refreshed tokens, after sign-out finished.

One step more breaks `SignOutSticks`: `updateSession` reads the row before `signOut` deletes it and writes after, with no condition, so the session exists again.

## Last confirmed

The digests under `covers` are the text of the covered functions at the last comparison with the model, first made at commit `8fc2801a4`. Run `--confirm` only after you have read each changed function against its action and run the replay tests. A digest confirmed without that comparison makes the check pass on a model that may describe code that no longer exists.
