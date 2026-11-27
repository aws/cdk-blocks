// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync } from 'node:child_process';
import { shellQuote } from './isolation.mjs';

/**
 * The objective *.spec.{js,ts,jsx,tsx,cjs,mjs} test CODE files, matched on a file name. Deliberately
 * NOT framework *.spec.json manifests (e.g. blocks.spec.json), which are legit app source.
 */
export const EXCLUDED_FILE_RE = /\.spec\.[cm]?[jt]sx?$/;

/**
 * Paths under `dir` that would un-blind the judge: a `bench-tests` entry or an objective test-spec
 * CODE file. Newline-separated, empty when clean.
 * @param {string} dir
 * @returns {string}
 */
export function findSpecLeaks(dir) {
	// GNU find's posix-extended -regex matches the whole path, hence the leading `.*`.
	return execSync(
		`find ${shellQuote(dir)} \\( -name bench-tests -o -regextype posix-extended -regex '.*\\.spec\\.[cm]?[jt]sx?$' \\) -print`,
		{ encoding: 'utf-8' },
	).trim();
}
