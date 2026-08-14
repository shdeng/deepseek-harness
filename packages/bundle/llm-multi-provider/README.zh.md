# `@deepseek-ai/dsh-llm-multi-provider`

[English](README.md) | 中文

这个可选 profile 组合包把休眠的 [`@deepseek-ai/dsh-llm-pi-ai`](../../llm/llm-pi-ai/README.md) 适配器插入到 [`dsh-base`](../base/README.md) 之上。需要在 Models 设置中支持内置 DeepSeek 适配器之外 provider route 的 profile 会包含此层。独立分层使仅使用 DeepSeek 的部署无需携带 pi-ai 的 OpenAI、Anthropic、Google 及其他 provider SDK 依赖。

该组合包没有运行时 API。它的 [`cordis.patch.yml`](cordis.patch.yml) 只插入一条 `llm-pi-ai` 行；只有 `llm-pi-ai` settings section 提供 profile 后，provider route 才会出现。

## 模型体验

通过插入的 row 间接影响：已配置的 provider route 会把对应模型加入模型选择，并通过 pi-ai 执行模型请求。未配置的组合包不会增加 route 或模型可见内容。

#### KV Cache 影响

无直接影响；请求缓存行为由选中的 provider 和模型负责。

## 已知限制与暂缓事项

- 即使 settings 只启用一个非 DeepSeek provider，该组合包仍携带 pi-ai 的完整生产依赖闭包。
