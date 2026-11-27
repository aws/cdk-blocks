# @aws-cdk-blocks/bb-metrics

## 1.1.0

### Minor Changes

- 8d9b5e7: `emit` and `emitBatch` now write every data point to its own EMF key without overwriting dimensions or the `_aws` envelope.

  - A metric name equal to one of its dimension keys, or a metric name or dimension key of `_aws`, now throws `MetricsErrors.InvalidMetricName` or `MetricsErrors.InvalidDimensions`. Previously the metric value replaced the dimension value or the EMF metadata, so the metric was not published.
  - A metric name repeated in one `emitBatch` call is written to a separate EMF document, so every value is recorded. Previously only the last value was kept. Metrics that hit this record more data points after upgrading, so their `Sum` and `SampleCount` statistics go up.
  - Dimension sets are grouped by an unambiguous key, so `{ a: '1&b=2' }` and `{ a: '1', b: '2' }` are no longer reported under the same dimensions.
  - Metrics with different timestamps in one batch are written with their own timestamps instead of the first metric's.
  - A value that is not a finite number (`NaN`, `Infinity`) or a timestamp that is not a valid `Date` is now left out of the document with a warning through the `logger` option, and the rest of the batch is still written. Previously it was written as `null`, and an invalid timestamp made CloudWatch skip the whole document. Nothing is thrown, so a ratio that is `NaN` at zero traffic does not fail the request.
  - `MetricUnit` now lists all 27 units CloudWatch accepts, including `Count/Second`, `Bytes/Second` and `Terabytes`. A unit outside that list throws the new `MetricsErrors.InvalidUnit`. Previously it was passed through unchecked.
  - A metric named `__proto__` now gets its own value key instead of being written without a value.

### Patch Changes

- 8fc2801: The npm discovery keyword is now `cdk-blocks`. Every published package carries it in place of `aws-blocks`, so find them with `npm search keywords:cdk-blocks`. If you publish your own Building Block, tag it `cdk-blocks` to be listed with them. `@aws-cdk-blocks/create-block` scaffolds the new keyword, and in every mode, not only outside the monorepo.

  The Building Block catalog in the `aws-cdk-blocks` README lists keywords for every block. They come from the `keywords` of each package's `package.json`, without the `cdk-blocks` tag that every package carries. Before, the catalog read a `**Keywords:**` line in each README, which only `bb-async-job` and `bb-cron-job` had, so the other 19 rows were blank.

  The `bb-async-job` and `bb-cron-job` READMEs no longer have that line. Its terms moved to the `keywords` of each package, so `npm search` finds them too: for example `worker`, `retry` and `batch` for `bb-async-job`, and `schedule`, `periodic` and `recurring` for `bb-cron-job`.

  The README template of `@aws-cdk-blocks/create-block` no longer has a `**Keywords:**` line, and the next steps printed for a block scaffolded in this repository say to add keywords to its `package.json`.

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

### Changes since `@aws-blocks/bb-metrics` 0.x

- The package is now `@aws-cdk-blocks/bb-metrics`. Install it in place of `@aws-blocks/bb-metrics`, and change the import specifiers.

## 1.0.0-rc.2

### Patch Changes

- 0b422ee: The docs state that `namespace` defaults to the block's `fullId`. `InvalidNamespace` is thrown by `new Metrics(...)` at run time and in local dev, not during synth.

## 1.0.0-rc.1

### Patch Changes

- e529b00: The README error examples import the error constants and `isBlocksError` from `aws-cdk-blocks`, which works in backend and client code.
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

### Patch Changes

- 6d3077e: Docstrings, READMEs, and design notes that pointed at `DistributedTable` describe `KVStore` with a `schema` and a `key`.

## 0.2.0

### Minor Changes

- 88747f5: A Building Block's mock entry throws when it is loaded in a deployed environment, so bundle your backend with the `aws-runtime` export condition. `@aws-blocks/core/bb-utils` exports the check as `assertNotMockInDeployedEnv(bbName)`.

### Patch Changes

- a3969b5: `Metrics.fromExisting()` works during `cdk synth`. A top-level `metrics.child()` call throws the synth-time error, like `emit()`, instead of `x is not a function`.
- a3969b5: A Building Block runtime method called at the top level of a backend module throws `<Class>.<method>() cannot be called during CDK synth` instead of `TypeError: x is not a function`.
- d366907: Updates dependencies in a manual bump dated 2026-10-19.
- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).

## 0.1.9

### Patch Changes

- 92fa27b: Internal refactor that creates named errors through `@aws-blocks/core`'s `blocksError`. No behavior change.

## 0.1.8

### Patch Changes

- a23b8d8: **Breaking: a plain `Error` thrown from an API method reaches the client as a generic `500` with `"Internal error"` instead of its raw message.** To send a specific status, name, and message to the client, throw an `ApiError`, for example `new ApiError("Todo not found", 404, { name: "TodoNotFoundException" })`. Building Block errors keep their name and message on the wire.

## 0.1.7

### Patch Changes

- 5eee114: Every published package carries an npm `keywords` array with the shared `aws-blocks` tag, so `npm search keywords:aws-blocks` finds it.

## 0.1.6

Dependency updates only.

## 0.1.5

Dependency updates only.

## 0.1.4

Dependency updates only.

## 0.1.3

### Patch Changes

- 0491157: `Metrics`, `Tracer`, and `DistributedDatabase` report `bbName` and `bbVersion` to `Scope`, so they appear in telemetry like every other Building Block.

## 0.1.2

### Patch Changes

- ba3bf7b: Adds a `DESIGN.md` to each building-block package that describes its architecture, API surface, mock implementation, and key design decisions. It ships on npm alongside `README.md`.

## 0.1.1

### Patch Changes

- 270c049: Ports documentation from the internal staging repo.
- c0558f3: Minor improvements

## 0.1.0

Initial version
