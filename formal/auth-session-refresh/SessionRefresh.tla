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
(* packages/bb-auth-cognito/src/index.aws.ts and                           *)
(* packages/bb-auth-cognito/src/sessions.ts at its parent:                 *)
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
EXTENDS Naturals, FiniteSets

CONSTANT ConditionalWrites

Requests == {"r1", "r2"}

SignInTokens == "signIn"
RefreshedTokens(r) == r
Tokens == {SignInTokens} \cup {RefreshedTokens(r) : r \in Requests}

MaxVersion == 1 + Cardinality(Requests)
Rows == [version : 1..MaxVersion, tokens : Tokens]
NoRow == [version |-> 0, tokens |-> "none"]

Steps ==
    {"read", "refreshRecord", "replaceIfUnchanged", "deleteIfUnchanged", "sessionAfterLostWrite",
     "updateSessionGet", "updateSessionPut", "deleteSession", "respond", "done"}

VARIABLES row, pc, read, result, signOutPc, lastSeenInStore, rowsDeleted, overwrittenByRefresh

vars == <<row, pc, read, result, signOutPc, lastSeenInStore, rowsDeleted, overwrittenByRefresh>>

Init ==
    /\ row = [version |-> 1, tokens |-> SignInTokens]
    /\ pc = [r \in Requests |-> "read"]
    /\ read = [r \in Requests |-> NoRow]
    /\ result = [r \in Requests |-> "pending"]
    /\ signOutPc = "lookup"
    /\ lastSeenInStore = [r \in Requests |-> "none"]
    /\ rowsDeleted = [r \in Requests |-> {}]
    /\ overwrittenByRefresh = [r \in Requests |-> {}]

Goto(r, step) == pc' = [pc EXCEPT ![r] = step]

Return(r, value) ==
    /\ result' = [result EXCEPT ![r] = value]
    /\ Goto(r, "respond")

SeeInStore(r, tokens) == lastSeenInStore' = [lastSeenInStore EXCEPT ![r] = tokens]

\* sessions.ts `unchangedSince`: the comparison is on the version alone. A
\* missing row has no version, so it never matches.
UnchangedSince(r) == row.version = read[r].version

Put(r) ==
    /\ row' = [version |-> read[r].version + 1, tokens |-> RefreshedTokens(r)]
    /\ overwrittenByRefresh' = [overwrittenByRefresh EXCEPT ![r] = @ \cup {row}]
    /\ SeeInStore(r, RefreshedTokens(r))

Delete(r) ==
    /\ row' = NoRow
    /\ rowsDeleted' = [rowsDeleted EXCEPT ![r] = IF row = NoRow THEN @ ELSE @ \cup {row}]

\* The clock is not modelled: a row that exists is either served as it is
\* (the access token has not expired) or refreshed (expired, or `forceRefresh`).
Read(r) ==
    /\ pc[r] = "read"
    /\ read' = [read EXCEPT ![r] = row]
    /\ SeeInStore(r, row.tokens)
    /\ \/ /\ row = NoRow
          /\ Return(r, "null")
       \/ /\ row # NoRow
          /\ Return(r, row.tokens)
       \/ /\ row # NoRow
          /\ Goto(r, "refreshRecord")
          /\ UNCHANGED result
    /\ UNCHANGED <<row, signOutPc, rowsDeleted, overwrittenByRefresh>>

RefreshRecordRefreshed(r) ==
    /\ pc[r] = "refreshRecord"
    /\ Goto(r, IF ConditionalWrites THEN "replaceIfUnchanged" ELSE "updateSessionGet")
    /\ UNCHANGED <<row, read, result, signOutPc, lastSeenInStore, rowsDeleted, overwrittenByRefresh>>

RefreshRecordRejected(r) ==
    /\ pc[r] = "refreshRecord"
    /\ Goto(r, IF ConditionalWrites THEN "deleteIfUnchanged" ELSE "deleteSession")
    /\ UNCHANGED <<row, read, result, signOutPc, lastSeenInStore, rowsDeleted, overwrittenByRefresh>>

RefreshRecordThrows(r) ==
    /\ pc[r] = "refreshRecord"
    /\ IF ConditionalWrites
          THEN Return(r, "throws")
          ELSE /\ Goto(r, "deleteSession")
               /\ UNCHANGED result
    /\ UNCHANGED <<row, read, signOutPc, lastSeenInStore, rowsDeleted, overwrittenByRefresh>>

ReplaceIfUnchanged(r) ==
    /\ pc[r] = "replaceIfUnchanged"
    /\ IF UnchangedSince(r)
          THEN /\ Put(r)
               /\ Return(r, RefreshedTokens(r))
          ELSE /\ Goto(r, "sessionAfterLostWrite")
               /\ UNCHANGED <<row, overwrittenByRefresh, lastSeenInStore, result>>
    /\ UNCHANGED <<read, signOutPc, rowsDeleted>>

DeleteIfUnchanged(r) ==
    /\ pc[r] = "deleteIfUnchanged"
    /\ IF UnchangedSince(r)
          THEN /\ Delete(r)
               /\ Return(r, "null")
          ELSE /\ Goto(r, "sessionAfterLostWrite")
               /\ UNCHANGED <<row, rowsDeleted, result>>
    /\ UNCHANGED <<read, signOutPc, lastSeenInStore, overwrittenByRefresh>>

\* Returns null when the row is gone, and also when the row it finds has an
\* expired access token.
SessionAfterLostWrite(r) ==
    /\ pc[r] = "sessionAfterLostWrite"
    /\ SeeInStore(r, row.tokens)
    /\ \/ Return(r, "null")
       \/ /\ row # NoRow
          /\ Return(r, row.tokens)
    /\ UNCHANGED <<row, read, signOutPc, rowsDeleted, overwrittenByRefresh>>

Respond(r) ==
    /\ pc[r] = "respond"
    /\ Goto(r, "done")
    /\ UNCHANGED <<row, read, result, signOutPc, lastSeenInStore, rowsDeleted, overwrittenByRefresh>>

\* updateSession returned without writing when the row was gone, and
\* tryRefresh still answered with the refreshed tokens.
UpdateSessionGet(r) ==
    /\ pc[r] = "updateSessionGet"
    /\ SeeInStore(r, row.tokens)
    /\ IF row = NoRow
          THEN Return(r, RefreshedTokens(r))
          ELSE /\ Goto(r, "updateSessionPut")
               /\ UNCHANGED result
    /\ UNCHANGED <<row, read, signOutPc, rowsDeleted, overwrittenByRefresh>>

UpdateSessionPut(r) ==
    /\ pc[r] = "updateSessionPut"
    /\ Put(r)
    /\ Return(r, RefreshedTokens(r))
    /\ UNCHANGED <<read, signOutPc, rowsDeleted>>

DeleteSession(r) ==
    /\ pc[r] = "deleteSession"
    /\ Delete(r)
    /\ Return(r, "null")
    /\ UNCHANGED <<read, signOutPc, lastSeenInStore, overwrittenByRefresh>>

\* The row signOut looks up only feeds `onSignOut` and the upstream
\* revocation, which the three RefreshRecord outcomes already cover.
SignOutLookup ==
    /\ signOutPc = "lookup"
    /\ signOutPc' = "delete"
    /\ UNCHANGED <<row, pc, read, result, lastSeenInStore, rowsDeleted, overwrittenByRefresh>>

SignOutDelete ==
    /\ signOutPc = "delete"
    /\ row' = NoRow
    /\ signOutPc' = "done"
    /\ UNCHANGED <<pc, read, result, lastSeenInStore, rowsDeleted, overwrittenByRefresh>>

\* The end state. Without this step TLC would report it as a deadlock.
Done ==
    /\ signOutPc = "done"
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
    /\ signOutPc \in {"lookup", "delete", "done"}
    /\ lastSeenInStore \in [Requests -> Tokens \cup {"none"}]
    /\ rowsDeleted \in [Requests -> SUBSET Rows]
    /\ overwrittenByRefresh \in [Requests -> SUBSET (Rows \cup {NoRow})]

(***************************************************************************)
(* resolveSession: "a refresh that finishes after sign-out never restores  *)
(* the session".                                                           *)
(***************************************************************************)
SignOutSticks == signOutPc = "done" => row = NoRow

(***************************************************************************)
(* resolveSession: "a request whose refresh was rejected never deletes the *)
(* session another request has just refreshed". deleteIfUnchanged: "a      *)
(* decision made on stale data never removes a newer session".             *)
(***************************************************************************)
NoStaleDelete == \A r \in Requests : rowsDeleted[r] \subseteq {read[r]}

(***************************************************************************)
(* replaceIfUnchanged: "A stale writer therefore never recreates a deleted *)
(* session or overwrites a newer one."                                     *)
(***************************************************************************)
NoStaleOverwrite == \A r \in Requests : overwrittenByRefresh[r] \subseteq {read[r]}

(***************************************************************************)
(* sessionAfterLostWrite: "Serve the session a concurrent refresh wrote if *)
(* it is still live. If the session was deleted (`signOut`, revoke), clear *)
(* the cookie — it stays signed out." replaceIfUnchanged: "Returns `true`  *)
(* when `next` was written; `false` (nothing written) when the session     *)
(* was deleted (sign-out, revoke) or replaced by a concurrent writer". So  *)
(* a request answers as authenticated only with the tokens its last store  *)
(* call read or wrote, never with tokens it read before the row changed.   *)
(***************************************************************************)
AnswersComeFromTheStore ==
    \A r \in Requests : result[r] \in Tokens => result[r] = lastSeenInStore[r]
=============================================================================
