// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Match } from 'aws-cdk-lib/assertions';

/**
 * Shared matchers for the API Gateway access-logging audit-gap synth info,
 * imported by both `blocks-backend.test.ts` and `blocks-stack.test.ts` so the
 * two synth paths assert exactly the same contract from one definition.
 *
 * `addInfoV2(id, message)` records the annotation as `${message} [ack: ${id}]`
 * (as `addWarningV2` does), so the id a caller passes to `acknowledgeInfo`
 * surfaces as a trailing `[ack: …]` tag. The id string ALSO appears inside the
 * message body (in the acknowledge remedy), so a matcher that only looked for
 * the bare id would match the message text and stay green even after the real
 * `addInfoV2` id was changed. These matchers therefore anchor the id on the
 * trailing tag with `$`.
 *
 * The matchers say nothing about the level: a test picks it by calling
 * `hasInfo` / `hasNoInfo` or `hasWarning` / `hasNoWarning` with them.
 */
export const ACCESS_LOGGING_NOTE_ID = 'blocks:apigateway:access-logging-disabled';

/**
 * Positive matcher: freezes the message substring, the `accessLogging: true`
 * opt-in remedy, and the annotation id together — the id pinned to the trailing
 * `[ack: …]` tag that `addInfoV2` appends, not the copy inside the message
 * body. `[\s\S]*` lets the three parts appear in order anywhere across the full
 * annotation string.
 */
export const ACCESS_LOGGING_NOTE = Match.stringLikeRegexp(
	`access logging is disabled[\\s\\S]*accessLogging: true[\\s\\S]*\\[ack: ${ACCESS_LOGGING_NOTE_ID}\\]$`,
);

/**
 * Negative matcher: the trailing `[ack: <id>]` tag only. `hasNoInfo` and
 * `hasNoWarning` cases assert against this (not the full message) so a reword
 * of the message body can't make them pass vacuously — only an actually-emitted
 * annotation carrying this id trips them.
 */
export const ACCESS_LOGGING_NOTE_ACK_TAG = Match.stringLikeRegexp(`\\[ack: ${ACCESS_LOGGING_NOTE_ID}\\]$`);
