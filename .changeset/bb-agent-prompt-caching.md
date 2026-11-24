---
"@aws-blocks/bb-agent": minor
---

feat(bb-agent): opt-in Bedrock prompt caching via `ModelConfig.cacheConfig`

Agents can now enable Strands prompt caching for the `bedrock` provider by
setting `cacheConfig: { strategy: 'auto' | 'anthropic' }` on a model config.
Caching reuses the cached request prefix (tools + system prompt + prior turns)
across requests, cutting input-token cost and latency for agents with long
system prompts, many tools, or multi-turn conversations.

Off by default and additive — existing configs are unaffected. Use
`'auto'` for the `BedrockModels` presets (Strands places cache points for
known model IDs) and `'anthropic'` when `modelId` is an ARN application
inference profile that `'auto'` can't detect. `'anthropic'` skips the
model-support check, so the underlying model must support prompt caching or
Bedrock rejects the invocation with a `ModelError`. Only `strategy` is
exposed; TTL and per-section caching options are not passed through. Ignored
by the `openai-api` and `canned` providers.
