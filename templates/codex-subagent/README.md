# 官方 Codex 子代理配置片段

先单独安装并选中与 DSH 宿主配套的 `@deepseek-ai/dsh-subagent-codex`。官方 bundle 自带 provider 和 `subagent_codex` 工具，本目录只提供配置覆盖，不是另一个可独立安装的 bundle。

将 `cordis.patch.yml` 的对应行合并到现有 profile 数组，保留其他配置。默认不固定模型；示例模型须按原生运行时与账号实际验证后启用。

完整说明见 [可选集成指南](../../docs/OFFICIAL_CODEX_SUBAGENT.md)。
