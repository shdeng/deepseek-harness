# `@deepseek-ai/dsh-llm-multi-provider`

English | [中文](README.zh.md)

This optional profile bundle inserts the dormant [`@deepseek-ai/dsh-llm-pi-ai`](../../llm/llm-pi-ai/README.md) adapter over [`dsh-base`](../base/README.md). A profile includes this layer when its Models settings must support provider routes beyond the built-in DeepSeek adapter. Keeping the layer separate prevents DeepSeek-only deployments from carrying pi-ai's OpenAI, Anthropic, Google, and other provider SDK dependencies.

The bundle has no runtime API. Its [`cordis.patch.yml`](cordis.patch.yml) inserts one `llm-pi-ai` row; provider routes appear only when the `llm-pi-ai` settings section supplies profiles.

## Model Experience

Indirectly, through the inserted row: configured provider routes add their models to model selection and serve model requests through pi-ai. An unconfigured layer adds no route or model-visible content.

#### KV Cache effect

None directly; the selected provider and model own request caching behavior.

## Known Limitations and Deferred Work

- The bundle carries pi-ai's complete production dependency closure even when settings enable only one non-DeepSeek provider.
