// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Synth-warning check for scaffolded templates, shared by the per-PR template
// driver (templates-e2e.mjs) and the daily canary (scripts/canary/run-canary.ts).
//
// Synthesizes an untouched scaffold in every mode its scripts deploy
// (production, sandbox, preview) and fails on any error annotation and on any
// warning annotation that is not listed in EXPECTED_TEMPLATE_WARNINGS.
//
// The annotations are read from the cloud assembly, not from the CDK CLI's
// output or its `--strict` exit code: the assembly carries each warning's id
// and construct path, includes the stacks of a nested assembly (a Stage),
// which `cdk synth` does not report, and lets the expected list name a
// warning by id.
//
// A warning the app acknowledges (`Annotations.acknowledgeWarning`) is not
// written to the assembly, so the synth cannot show it. The check therefore
// also fails on any acknowledgement call in the scaffold's own source
// (findAcknowledgements): a template must not silence an annotation for the
// developer.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { runSpawn } from './_proc.mjs';

/**
 * @typedef {object} Annotation
 * @property {'warning' | 'info' | 'error'} level
 * @property {string | undefined} id the id given to `addWarningV2`/`addInfoV2`;
 *   undefined for the legacy `addWarning`/`addInfo` and for `addError`
 * @property {string} path construct path, e.g. `/my-app-prod/Hosting`
 * @property {string} message the text without the trailing ` [ack: <id>]` tag
 * @property {string} stack display name of the stack artifact that holds it
 */

/**
 * @typedef {object} SynthMode
 * @property {string} name
 * @property {string[]} context `key=value` pairs passed as `--context`
 */

/**
 * The warnings an untouched scaffold is meant to show, by template.
 *
 * The rule: an untouched scaffold synthesizes without warnings. An entry here
 * is a warning the template is meant to show because the developer must act
 * on something the template ships, and each needs a reason a customer would
 * accept. A default's tradeoff is an info annotation in the block, never an
 * entry here.
 *
 * `modes` names the {@link synthModes} in which the warning fires. An entry
 * that does not fire in one of its modes fails the check, so the list only
 * holds warnings that still exist.
 *
 * @type {Record<string, { id: string, modes: string[], reason: string }[]>}
 */
export const EXPECTED_TEMPLATE_WARNINGS = {
	demo: [
		{
			id: '@aws-cdk-blocks/bb-email-client:UnverifiableSender',
			modes: ['production', 'sandbox', 'preview'],
			reason:
				'The template ships a placeholder sender address on the reserved `.invalid` domain, so every send fails on AWS until the developer sets an address they have verified.',
		},
	],
	'auth-oidc': [
		{
			id: '@aws-cdk-blocks/bb-auth:StubIdpDeployed',
			modes: ['sandbox', 'preview'],
			reason:
				'Outside production the template signs users in through `stubIdp()`, which asks for no credentials, so anyone who can reach a deployed sandbox can sign in.',
		},
		{
			// First synth of each stack only. Preview reuses the sandbox stack name,
			// so in the order synthModes() returns the sandbox synth has already
			// written that stack's baseline and the warning does not fire in preview.
			id: '@aws-cdk-blocks/bb-auth:FirstBaselineWithoutPool',
			modes: ['production', 'sandbox'],
			reason:
				'A first baseline with no owned user pool cannot tell a new app from one migrating off a pool-backed block, so the block warns once, on the first synth of each stack.',
		},
	],
};

/** Cloud assembly metadata entry types that are annotations, by level. */
const LEVELS = new Map([
	['aws:cdk:warning', 'warning'],
	['aws:cdk:info', 'info'],
	['aws:cdk:error', 'error'],
]);

/** The tag `addWarningV2(id, …)` and `addInfoV2(id, …)` append to the message. */
const ACK_TAG = / \[ack: ([^\]]+)\]$/;

/** How much of a message a problem line shows. */
const MESSAGE_PREVIEW = 200;

/** Parse a JSON file of the assembly; a file that cannot be read is an error that names it. */
function readJson(path, what) {
	let text;
	try {
		text = readFileSync(path, 'utf-8');
	} catch (error) {
		throw new Error(`cannot read the ${what} ${path}: ${error?.message ?? error}`);
	}
	return JSON.parse(text);
}

/**
 * Append the annotations of the assembly in `assemblyDir`, and of the
 * assemblies nested in it, to `out`.
 *
 * @returns {number} how many stack artifacts were read
 */
function collectAnnotations(assemblyDir, out) {
	const manifest = readJson(join(assemblyDir, 'manifest.json'), 'cloud assembly manifest');
	let stacks = 0;
	for (const [artifactId, artifact] of Object.entries(manifest.artifacts ?? {})) {
		if (artifact.type === 'cdk:cloud-assembly') {
			stacks += collectAnnotations(join(assemblyDir, artifact.properties.directoryName), out);
			continue;
		}
		if (artifact.type !== 'aws:cloudformation:stack') continue;
		stacks++;
		const stack = artifact.displayName ?? artifactId;
		// Same merge as the CDK CLI: the sidecar file first, then the inline entries.
		const sources = [];
		if (artifact.additionalMetadataFile) {
			sources.push(readJson(join(assemblyDir, artifact.additionalMetadataFile), `metadata file of stack ${stack}`));
		}
		if (artifact.metadata) sources.push(artifact.metadata);
		for (const metadata of sources) {
			for (const [path, entries] of Object.entries(metadata)) {
				for (const entry of entries) {
					const level = LEVELS.get(entry.type);
					if (!level) continue;
					const data = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data);
					const ack = ACK_TAG.exec(data);
					out.push({ level, id: ack?.[1], path, message: ack ? data.slice(0, ack.index) : data, stack });
				}
			}
		}
	}
	return stacks;
}

/**
 * Read every warning, info and error annotation out of a synthesized cloud
 * assembly (a `cdk.out` directory).
 *
 * aws-cdk-lib writes a stack's metadata to a sidecar file next to the manifest
 * (`<stack>.metadata.json`, named by the stack artifact's
 * `additionalMetadataFile`); the assembly schema also allows it inline in the
 * manifest (`metadata`). Both are read. A nested assembly (a
 * `cdk:cloud-assembly` artifact, which is what a Stage synthesizes to) is read
 * the same way from its own directory. A nested stack's annotations are in its
 * parent stack's metadata, and each further top-level stack is an artifact of
 * its own.
 *
 * Fails closed, so a synth that produced nothing cannot read as "no
 * warnings": throws when the manifest is missing, when a stack names a
 * metadata file that is missing, and when the assembly holds no stack at all.
 *
 * @param {string} assemblyDir
 * @returns {Annotation[]}
 */
export function readAnnotations(assemblyDir) {
	const annotations = [];
	if (collectAnnotations(assemblyDir, annotations) === 0) {
		throw new Error(`the cloud assembly ${assemblyDir} holds no stack`);
	}
	return annotations;
}

/**
 * The modes an app is synthesized in, in the order they run: production,
 * sandbox, and preview when the app has a `sandbox:preview` script (the
 * templates with `Hosting`; for a backend-only template preview is the same
 * synth as sandbox).
 *
 * The order matters for a warning that fires only on the first synth of a
 * stack (see EXPECTED_TEMPLATE_WARNINGS): preview synthesizes the stack the
 * sandbox mode already synthesized.
 *
 * @param {string} appDir
 * @returns {SynthMode[]}
 */
export function synthModes(appDir) {
	const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf-8'));
	const modes = [
		{ name: 'production', context: [] },
		{ name: 'sandbox', context: ['sandboxMode=true'] },
	];
	if (pkg.scripts?.['sandbox:preview']) {
		modes.push({ name: 'preview', context: ['sandboxMode=true', 'previewMode=true'] });
	}
	return modes;
}

/** `<level> <id> at <construct path>: <start of the message>`, on one line. */
function describeAnnotation(annotation) {
	const text = annotation.message.replace(/\s+/g, ' ').trim();
	const preview = text.length > MESSAGE_PREVIEW ? `${text.slice(0, MESSAGE_PREVIEW)}…` : text;
	return `${annotation.level} ${annotation.id ?? '(no id)'} at ${annotation.path}: ${preview}`;
}

/**
 * What is wrong with the annotations of one synth: every error, every warning
 * whose id is not expected (a warning without an id can never be expected),
 * and every expected id that did not fire. Info annotations are ignored.
 *
 * @param {Annotation[]} annotations
 * @param {Iterable<string>} [expectedIds] ids of the warnings this synth is meant to show
 * @returns {string[]} one line per problem; empty when there is none
 */
export function findProblems(annotations, expectedIds = []) {
	const expected = new Set(expectedIds);
	const fired = new Set();
	const problems = [];
	for (const annotation of annotations) {
		if (annotation.level === 'error') {
			problems.push(describeAnnotation(annotation));
		} else if (annotation.level === 'warning') {
			if (annotation.id !== undefined && expected.has(annotation.id)) fired.add(annotation.id);
			else problems.push(`unexpected ${describeAnnotation(annotation)}`);
		}
	}
	for (const id of expected) {
		if (!fired.has(id)) {
			problems.push(`expected warning ${id} no longer fires: remove it from EXPECTED_TEMPLATE_WARNINGS`);
		}
	}
	return problems;
}

/** Ids of the warnings `template` is meant to show in `mode`. */
function expectedWarningIds(template, mode) {
	const entries = Object.hasOwn(EXPECTED_TEMPLATE_WARNINGS, template) ? EXPECTED_TEMPLATE_WARNINGS[template] : [];
	return entries.filter((entry) => entry.modes.includes(mode)).map((entry) => entry.id);
}

/** The aws-cdk-lib version installed in the app, or `unknown`. */
function installedCdkLibVersion(appDir) {
	try {
		const pkg = JSON.parse(readFileSync(join(appDir, 'node_modules', 'aws-cdk-lib', 'package.json'), 'utf-8'));
		return pkg.version ?? 'unknown';
	} catch {
		return 'unknown';
	}
}

/** Directories of an app that hold no source of its own: dependencies and build output. */
const NOT_APP_SOURCE = new Set(['node_modules', 'dist', 'build', 'cdk.out', 'vendor']);

/** Extensions of the files an app's CDK code can be written in. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** A call to `Annotations.acknowledgeWarning` or `Annotations.acknowledgeInfo`. */
const ACKNOWLEDGEMENT = /\backnowledge(?:Warning|Info)\s*\(/;

/**
 * Every line of source under `dir` that acknowledges an annotation, as
 * `<file>:<line>: <text>` with the file relative to `dir`.
 *
 * An acknowledged warning or info is not written to the cloud assembly, so a
 * template that acknowledges one passes the synth check while hiding it from
 * the developer who scaffolds the app. Templates therefore acknowledge
 * nothing: a warning an untouched scaffold triggers is fixed in the block, or
 * listed in EXPECTED_TEMPLATE_WARNINGS when the template is meant to show it.
 *
 * Dependencies, build output and dot-directories are skipped.
 *
 * @param {string} dir a template directory or a scaffolded app
 * @returns {string[]}
 */
export function findAcknowledgements(dir) {
	const found = [];
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				if (!NOT_APP_SOURCE.has(entry.name) && !entry.name.startsWith('.')) walk(path);
			} else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
				readFileSync(path, 'utf-8')
					.split('\n')
					.forEach((line, index) => {
						if (ACKNOWLEDGEMENT.test(line)) found.push(`${relative(dir, path)}:${index + 1}: ${line.trim()}`);
					});
			}
		}
	};
	walk(dir);
	return found.sort();
}

/**
 * Synthesize a scaffolded app in each of its {@link synthModes} and check the
 * annotations against EXPECTED_TEMPLATE_WARNINGS. An acknowledgement call in
 * the app's source is a problem too (see {@link findAcknowledgements}).
 *
 * Each mode synthesizes into `<outDir>/<mode>` with the app's own `cdk.json`
 * command, so nothing but the context differs from what the developer runs.
 * Synth needs no AWS credentials. In an app with `Hosting` it runs the app's
 * frontend build.
 *
 * When there is a problem, the aws-cdk-lib version installed in the app is
 * logged too: a scaffold installs the newest release its `^` range allows, so
 * a new aws-cdk-lib release can add a warning to an untouched app.
 *
 * @param {object} options
 * @param {string} options.template template name, the key into EXPECTED_TEMPLATE_WARNINGS
 * @param {string} options.appDir the scaffolded app
 * @param {string} options.outDir directory that receives one cloud assembly per mode
 * @param {NodeJS.ProcessEnv} options.env environment for the CDK CLI
 * @param {string} options.root repo root, for the command banner
 * @returns {string[]} problems, each prefixed with its mode; empty when the check passes
 */
export function checkTemplateSynthWarnings({ template, appDir, outDir, env, root }) {
	if (!existsSync(join(appDir, 'cdk.json'))) {
		console.log(`  Synth warning check skipped: template ${template} has no cdk.json`);
		return [];
	}
	// The region is pinned because one annotation depends on it by design: with
	// no `env` on the stack, hosting's CloudFrontAlarmRegionUnresolved is an info
	// when the CDK CLI targets us-east-1 and a warning for any other region. An
	// unpinned check would pass or fail by the region the caller's environment
	// names.
	const synthEnv = { ...env, AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1' };
	const problems = findAcknowledgements(appDir).map(
		(where) => `the scaffold acknowledges an annotation, which hides it from this check and from the developer: ${where}`,
	);
	for (const mode of synthModes(appDir)) {
		const modeOut = join(outDir, mode.name);
		const contextArgs = mode.context.flatMap((pair) => ['--context', pair]);
		const result = runSpawn(
			'npx',
			['--no', 'cdk', 'synth', '--quiet', '--output', modeOut, ...contextArgs],
			{ cwd: appDir, env: synthEnv },
			root,
		);
		if (result.status !== 0) {
			const exit = result.error ? `could not start: ${result.error.message}` : `exited ${result.status ?? `on signal ${result.signal}`}`;
			problems.push(`${mode.name}: cdk synth ${exit}`);
			continue;
		}
		let found;
		try {
			found = findProblems(readAnnotations(modeOut), expectedWarningIds(template, mode.name));
		} catch (error) {
			found = [error?.message ?? String(error)];
		}
		for (const problem of found) problems.push(`${mode.name}: ${problem}`);
	}
	if (problems.length > 0) {
		console.error(
			`  aws-cdk-lib ${installedCdkLibVersion(appDir)} is installed in the scaffolded app (a new aws-cdk-lib release can add a warning to an untouched app).`,
		);
	}
	return problems;
}
