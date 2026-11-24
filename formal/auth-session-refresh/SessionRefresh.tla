--------------------------- MODULE SessionRefresh ---------------------------
(***************************************************************************)
(* Two requests carry the same session cookie and resolve their session    *)
(* while `signOut` runs for that cookie. Each `await` that reads or writes *)
(* the session row is one action, so any other action can run between two  *)
(* of them. A conditional write is one action because it is one DynamoDB   *)
(* conditional request.                                                    *)
(*                                                                         *)
(* Action                    Code                                          *)
(* ------------------------  --------------------------------------------- *)
(* Read                      AuthBase.resolveSession: SessionStore.read    *)
(* RefreshRecordRefreshed    AuthBase.refreshRecord: the engine returns    *)
(*                           tokens                                        *)
(* RefreshRecordRejected     AuthBase.refreshRecord: the engine returns    *)
(*                           null                                          *)
(* RefreshRecordThrows       AuthBase.refreshRecord: the engine throws     *)
(*                           (transient)                                   *)
(* ReplaceIfUnchanged        SessionStore.replaceIfUnchanged               *)
(* DeleteIfUnchanged         SessionStore.deleteIfUnchanged                *)
(* SessionAfterLostWrite     AuthBase.sessionAfterLostWrite:               *)
(*                           SessionStore.lookup                           *)
(* Respond                   AuthBase.resolveSession returns or throws     *)
(* SignOutLookup             AuthBase.signOut: SessionStore.lookup         *)
(* SignOutDelete             AuthBase.signOut: SessionStore.delete         *)
(*                                                                         *)
(* in packages/bb-auth/src/auth-base.ts and packages/bb-auth/src/          *)
(* sessions.ts.                                                            *)
(*                                                                         *)
(* ConditionalWrites = FALSE replaces the two conditional writes with the  *)
(* writes this protocol had before commit 579c6a826 (#1314), in            *)
(* packages/bb-auth-cognito/src/index.aws.ts and sessions.ts at its        *)
(* parent:                                                                 *)
(*                                                                         *)
(* UpdateSessionGet          SessionStore.updateSession: kv.get            *)
(* UpdateSessionPut          SessionStore.updateSession: kv.put, with no   *)
(*                           condition                                     *)
(* DeleteSession             SessionStore.deleteSession after tryRefresh   *)
(*                           returned null, which it did for a rejected    *)
(*                           and for a transient failure                   *)
(*                                                                         *)
(* Rows had no `version` before that commit. These three actions never     *)
(* compare it; the model keeps it so both variants share one row shape.    *)
(*                                                                         *)
(* An `await` that touches no session row (`sessionSecret`, `isRevoked`    *)
(* with no reset marker) is part of the action that follows it.            *)
(***************************************************************************)
EXTENDS Naturals

CONSTANT ConditionalWrites

Requests == {"r1", "r2"}

\* The tokens sign-in stored, and for each request the tokens the identity
\* provider returns to it on a refresh.
SignInTokens == "signIn"
Tokens == {SignInTokens} \cup Requests

\* Sign-in stores version 1 and each request writes at most once, so no
\* version passes 3. TypeOK fails if one does.
Rows == [version : 1..3, tokens : Tokens]
NoRow == [version |-> 0, tokens |-> "none"]

Steps ==
    {"read", "refreshRecord", "replaceIfUnchanged", "deleteIfUnchanged", "sessionAfterLostWrite",
     "updateSessionGet", "updateSessionPut", "deleteSession", "respond", "done"}

VARIABLES
    row,        \* what the session store holds for the cookie's session id
    pc,         \* the store or engine call each request makes next
    read,       \* the row each request got from SessionStore.read
    result,     \* what resolveSession returns: tokens, "null", or "throws"
    signOut,    \* the call signOut makes next
    observed,   \* the tokens each request read from the store or stored in it
    deleted,    \* the row each request's delete removed
    replaced    \* what the store held when each request's refresh wrote

vars == <<row, pc, read, result, signOut, observed, deleted, replaced>>

Init ==
    /\ row = [version |-> 1, tokens |-> SignInTokens]
    /\ pc = [r \in Requests |-> "read"]
    /\ read = [r \in Requests |-> NoRow]
    /\ result = [r \in Requests |-> "pending"]
    /\ signOut = "lookup"
    /\ observed = [r \in Requests |-> {}]
    /\ deleted = [r \in Requests |-> {}]
    /\ replaced = [r \in Requests |-> {}]

Goto(r, step) == pc' = [pc EXCEPT ![r] = step]

Return(r, value) ==
    /\ result' = [result EXCEPT ![r] = value]
    /\ Goto(r, "respond")

Observe(r, tokens) == observed' = [observed EXCEPT ![r] = @ \cup {tokens}]

\* sessions.ts `unchangedSince`: the comparison is on the version alone. A
\* missing row has no version, so it never matches.
UnchangedSince(r) == row.version = read[r].version

\* `kv.put` of a refresh: its own tokens, at the version after the one it read.
Put(r) ==
    /\ row' = [version |-> read[r].version + 1, tokens |-> r]
    /\ replaced' = [replaced EXCEPT ![r] = @ \cup {row}]
    /\ Observe(r, r)

\* `kv.delete`. Deleting a row that is already gone removes nothing.
Delete(r) ==
    /\ row' = NoRow
    /\ deleted' = [deleted EXCEPT ![r] = IF row = NoRow THEN @ ELSE @ \cup {row}]

\* The clock is not modelled: a row that exists is either served as it is
\* (the access token has not expired) or refreshed (expired, or `forceRefresh`).
Read(r) ==
    /\ pc[r] = "read"
    /\ read' = [read EXCEPT ![r] = row]
    /\ \/ /\ row = NoRow
          /\ Return(r, "null")
          /\ UNCHANGED observed
       \/ /\ row # NoRow
          /\ Observe(r, row.tokens)
          /\ Return(r, row.tokens)
       \/ /\ row # NoRow
          /\ Observe(r, row.tokens)
          /\ Goto(r, "refreshRecord")
          /\ UNCHANGED result
    /\ UNCHANGED <<row, signOut, deleted, replaced>>

RefreshRecordRefreshed(r) ==
    /\ pc[r] = "refreshRecord"
    /\ Goto(r, IF ConditionalWrites THEN "replaceIfUnchanged" ELSE "updateSessionGet")
    /\ UNCHANGED <<row, read, result, signOut, observed, deleted, replaced>>

RefreshRecordRejected(r) ==
    /\ pc[r] = "refreshRecord"
    /\ Goto(r, IF ConditionalWrites THEN "deleteIfUnchanged" ELSE "deleteSession")
    /\ UNCHANGED <<row, read, result, signOut, observed, deleted, replaced>>

RefreshRecordThrows(r) ==
    /\ pc[r] = "refreshRecord"
    /\ IF ConditionalWrites
          THEN Return(r, "throws")
          ELSE /\ Goto(r, "deleteSession")
               /\ UNCHANGED result
    /\ UNCHANGED <<row, read, signOut, observed, deleted, replaced>>

ReplaceIfUnchanged(r) ==
    /\ pc[r] = "replaceIfUnchanged"
    /\ IF UnchangedSince(r)
          THEN /\ Put(r)
               /\ Return(r, r)
          ELSE /\ Goto(r, "sessionAfterLostWrite")
               /\ UNCHANGED <<row, replaced, observed, result>>
    /\ UNCHANGED <<read, signOut, deleted>>

DeleteIfUnchanged(r) ==
    /\ pc[r] = "deleteIfUnchanged"
    /\ IF UnchangedSince(r)
          THEN /\ Delete(r)
               /\ Return(r, "null")
          ELSE /\ Goto(r, "sessionAfterLostWrite")
               /\ UNCHANGED <<row, deleted, result>>
    /\ UNCHANGED <<read, signOut, observed, replaced>>

\* Returns null when the row is gone, and also when the row it finds has an
\* expired access token.
SessionAfterLostWrite(r) ==
    /\ pc[r] = "sessionAfterLostWrite"
    /\ \/ /\ Return(r, "null")
          /\ UNCHANGED observed
       \/ /\ row # NoRow
          /\ Observe(r, row.tokens)
          /\ Return(r, row.tokens)
    /\ UNCHANGED <<row, read, signOut, deleted, replaced>>

Respond(r) ==
    /\ pc[r] = "respond"
    /\ Goto(r, "done")
    /\ UNCHANGED <<row, read, result, signOut, observed, deleted, replaced>>

\* updateSession returned without writing when the row was gone, and
\* tryRefresh still answered with the refreshed tokens.
UpdateSessionGet(r) ==
    /\ pc[r] = "updateSessionGet"
    /\ IF row = NoRow
          THEN Return(r, r)
          ELSE /\ Goto(r, "updateSessionPut")
               /\ UNCHANGED result
    /\ UNCHANGED <<row, read, signOut, observed, deleted, replaced>>

UpdateSessionPut(r) ==
    /\ pc[r] = "updateSessionPut"
    /\ Put(r)
    /\ Return(r, r)
    /\ UNCHANGED <<read, signOut, deleted>>

DeleteSession(r) ==
    /\ pc[r] = "deleteSession"
    /\ Delete(r)
    /\ Return(r, "null")
    /\ UNCHANGED <<read, signOut, observed, replaced>>

\* The row signOut looks up only feeds `onSignOut` and the upstream
\* revocation, which the three RefreshRecord outcomes already cover.
SignOutLookup ==
    /\ signOut = "lookup"
    /\ signOut' = "delete"
    /\ UNCHANGED <<row, pc, read, result, observed, deleted, replaced>>

SignOutDelete ==
    /\ signOut = "delete"
    /\ row' = NoRow
    /\ signOut' = "done"
    /\ UNCHANGED <<pc, read, result, observed, deleted, replaced>>

\* The end state. Without this step TLC would report it as a deadlock.
Done ==
    /\ signOut = "done"
    /\ \A r \in Requests : pc[r] = "done"
    /\ UNCHANGED vars

Next ==
    \/ \E r \in Requests :
        \/ Read(r)
        \/ RefreshRecordRefreshed(r)
        \/ RefreshRecordRejected(r)
        \/ RefreshRecordThrows(r)
        \/ ReplaceIfUnchanged(r)
        \/ DeleteIfUnchanged(r)
        \/ SessionAfterLostWrite(r)
        \/ UpdateSessionGet(r)
        \/ UpdateSessionPut(r)
        \/ DeleteSession(r)
        \/ Respond(r)
    \/ SignOutLookup
    \/ SignOutDelete
    \/ Done

TypeOK ==
    /\ row \in Rows \cup {NoRow}
    /\ pc \in [Requests -> Steps]
    /\ read \in [Requests -> Rows \cup {NoRow}]
    /\ result \in [Requests -> {"pending", "null", "throws"} \cup Tokens]
    /\ signOut \in {"lookup", "delete", "done"}
    /\ observed \in [Requests -> SUBSET Tokens]
    /\ deleted \in [Requests -> SUBSET Rows]
    /\ replaced \in [Requests -> SUBSET (Rows \cup {NoRow})]

(***************************************************************************)
(* resolveSession: "a refresh that finishes after sign-out never restores  *)
(* the session".                                                           *)
(***************************************************************************)
SignOutSticks == signOut = "done" => row = NoRow

(***************************************************************************)
(* resolveSession: "a request whose refresh was rejected never deletes the *)
(* session another request has just refreshed". deleteIfUnchanged: "a      *)
(* decision made on stale data never removes a newer session".             *)
(***************************************************************************)
NoStaleDelete == \A r \in Requests : deleted[r] \subseteq {read[r]}

(***************************************************************************)
(* replaceIfUnchanged: "A stale writer therefore never recreates a deleted *)
(* session or overwrites a newer one."                                     *)
(***************************************************************************)
NoStaleOverwrite == \A r \in Requests : replaced[r] \subseteq {read[r]}

(***************************************************************************)
(* replaceIfUnchanged: "Returns `true` when `next` was written; `false`    *)
(* (nothing written) when the session was deleted (sign-out, revoke) or    *)
(* replaced by a concurrent writer". sessionAfterLostWrite: "Serve the     *)
(* session a concurrent refresh wrote if it is still live. If the session  *)
(* was deleted (`signOut`, revoke), clear the cookie — it stays signed     *)
(* out." So a request answers as authenticated only with tokens that it    *)
(* read from the store or stored there.                                    *)
(***************************************************************************)
AnswersComeFromTheStore == \A r \in Requests : result[r] \in Tokens => result[r] \in observed[r]
=============================================================================
