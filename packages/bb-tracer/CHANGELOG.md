# @aws-cdk-blocks/bb-tracer

## 1.0.1

### Patch Changes

- 8fc2801: The npm discovery keyword is now `cdk-blocks`. Every published package carries it in place of `aws-blocks`, so find them with `npm search keywords:cdk-blocks`. If you publish your own Building Block, tag it `cdk-blocks` to be listed with them. `@aws-cdk-blocks/create-block` scaffolds the new keyword, and in every mode, not only outside the monorepo.

  The Building Block catalog in the `aws-cdk-blocks` README lists keywords for every block. They come from the `keywords` of each package's `package.json`, without the `cdk-blocks` tag that every package carries. Before, the catalog read a `**Keywords:**` line in each README, which only `bb-async-job` and `bb-cron-job` had, so the other 19 rows were blank.

  The `bb-async-job` and `bb-cron-job` READMEs no longer have that line. Its terms moved to the `keywords` of each package, so `npm search` finds them too: for example `worker`, `retry` and `batch` for `bb-async-job`, and `schedule`, `periodic` and `recurring` for `bb-cron-job`.

  The README template of `@aws-cdk-blocks/create-block` no longer has a `**Keywords:**` line, and the next steps printed for a block scaffolded in this repository say to add keywords to its `package.json`.

- 750dd28: The local `Tracer` mock now keeps overlapping top-level `startSegment` calls, such as concurrent dev-server requests, in separate traces. Each keeps its own trace ID, root annotations, root metadata and child segments, and nested segments, including ones run in parallel, attach to the parent in their own async chain. When a segment's function throws a value that is not an `Error`, such as `undefined`, `null` or a string, the local mock now rethrows that value unchanged instead of a `TypeError`, as the AWS runtime does. The recorded segment error follows X-Ray: a string is recorded as the message, and `undefined`, `null` and other non-object values record no error.
- Updated dependencies [62eb34e]
- Updated dependencies [1e88d52]
- Updated dependencies [8fc2801]
- Updated dependencies [d54eef0]
- Updated dependencies [bc97b17]
- Updated dependencies [3b66b2a]
- Updated dependencies [00d30e5]
- Updated dependencies [00d30e5]
- Updated dependencies [2bba814]
- Updated dependencies [87dec66]
- Updated dependencies [67336fc]
- Updated dependencies [dc0957f]
- Updated dependencies [89d006b]
- Updated dependencies [c6cd41c]
- Updated dependencies [ae00f24]
- Updated dependencies [dcbc505]
  - @aws-cdk-blocks/core@1.0.2
  - @aws-cdk-blocks/bb-logger@1.0.1

## 1.0.0

The first stable release, with no changes since 1.0.0-rc.2. The notes for every change since 0.x are under 1.0.0-rc.0, 1.0.0-rc.1 and 1.0.0-rc.2.

### Changes since `@aws-blocks/bb-tracer` 0.x

- The package is now `@aws-cdk-blocks/bb-tracer`. Install it in place of `@aws-blocks/bb-tracer`, and change the import specifiers.

## 1.0.0-rc.2

### Patch Changes

- 0b422ee: The docs state that `enabled: false` does not remove X-Ray cost while another `Tracer` in the app is enabled. The local mock samples by `samplingRate` instead of recording every trace.

## 1.0.0-rc.1

### Patch Changes

- fbe48c5: Local data moved from `.bb-data/{fullId}/` to `.cdk-blocks/local/data/{fullId}/`, and existing data is copied over on first use. The `@aws-cdk-blocks/core` changelog has the upgrade steps.

## 1.0.0-rc.0

### Major Changes

- e50b9e9: **Breaking: every published package moves from the `@aws-blocks` scope to `@aws-cdk-blocks`, and `@aws-blocks/blocks` becomes the unscoped `aws-cdk-blocks`.**

  To upgrade:

  1. In `package.json`, replace `@aws-blocks/blocks` with `aws-cdk-blocks` and every other `@aws-blocks/` name with `@aws-cdk-blocks/`, for example `@aws-cdk-blocks/core`.
  2. Make the same replacement in the specifier of every import.
  3. Change each `Annotations.of(stack).acknowledgeWarning('@aws-blocks/…')` call to the `@aws-cdk-blocks/` prefix, or `cdk synth --strict` fails on the warning.
  4. Keep the CDK context key `@aws-blocks/bb-data:encryptStorageByDefault` in `cdk.json` as it is, because renaming it makes CloudFormation replace the cluster.
  5. If you publish a block, move its dependency from `@aws-blocks/core` to `@aws-cdk-blocks/core`.

  No export or option moved, and the old `@aws-blocks/*` packages stop receiving releases.

## 0.3.0

### Minor Changes

- 88747f5: A Building Block's mock entry throws when it is loaded in a deployed environment, so bundle your backend with the `aws-runtime` export condition. `@aws-blocks/core/bb-utils` exports the check as `assertNotMockInDeployedEnv(bbName)`.

### Patch Changes

- a3969b5: A Building Block runtime method called at the top level of a backend module throws `<Class>.<method>() cannot be called during CDK synth` instead of `TypeError: x is not a function`.
- d366907: Updates dependencies in a manual bump dated 2026-10-19.
- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).

## 0.2.2

Dependency updates only.

## 0.2.1

Dependency updates only.

## 0.2.0

### Minor Changes

- d7312f9: **Breaking: logging, tracing, and the dashboard are driven by each compute, and `Logger` drops its `retention` option and the `LOG_LEVEL` environment variable.**

  To upgrade:

  1. Replace the `retention` option of `LoggingOptions` with the `logRetention` prop on `LambdaCompute`, which falls back to `defaults.logRetention`.
  2. Set the log level with the `level` option of each `Logger`, which defaults to `'info'`, instead of the `LOG_LEVEL` environment variable.
  3. Remove uses of the `LoggerBBRef` and `TracerBBRef` dashboard types.

  Creating any `Tracer` in the app enables X-Ray on every compute, and `DashboardOptions` gains the `logs` and `traces` display toggles.

### Patch Changes

- 5eee114: Every published package carries an npm `keywords` array with the shared `aws-blocks` tag, so `npm search keywords:aws-blocks` finds it.

## 0.1.8

Dependency updates only.

## 0.1.7

Dependency updates only.

## 0.1.6

Dependency updates only.

## 0.1.5

### Patch Changes

- 0491157: `Metrics`, `Tracer`, and `DistributedDatabase` report `bbName` and `bbVersion` to `Scope`, so they appear in telemetry like every other Building Block.

## 0.1.4

### Patch Changes

- ba3bf7b: Adds a `DESIGN.md` to each building-block package that describes its architecture, API surface, mock implementation, and key design decisions. It ships on npm alongside `README.md`.

## 0.1.3

### Patch Changes

- b90b7d9: Sampling is a per-trace decision, so all spans within a trace share the same sampling outcome.

## 0.1.2

### Patch Changes

- 18880ff: Minor test improvements

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements

## 0.1.0

Initial version
