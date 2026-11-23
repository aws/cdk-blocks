---
'@aws-cdk-blocks/bb-metrics': minor
---

`emit` and `emitBatch` now write every data point to its own EMF key without overwriting dimensions or the `_aws` envelope.

- A metric name equal to one of its dimension keys, or a metric name or dimension key of `_aws`, now throws `MetricsErrors.InvalidMetricName` or `MetricsErrors.InvalidDimensions`. Previously the metric value replaced the dimension value or the EMF metadata.
- A metric name repeated in one `emitBatch` call is written to a separate EMF document, so every value is recorded. Previously only the last value was kept.
- Dimension sets are grouped by an unambiguous key, so `{ a: '1&b=2' }` and `{ a: '1', b: '2' }` are no longer reported under the same dimensions.
- Metrics with different timestamps in one batch are written with their own timestamps instead of the first metric's.
- New `MetricsErrors.InvalidValue` is thrown for values that are not finite numbers (`NaN`, `Infinity`), which were written as `null`.
- New `MetricsErrors.InvalidUnit` is thrown for units outside `MetricUnit`, which were passed through unchecked.
