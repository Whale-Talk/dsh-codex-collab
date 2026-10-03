/**
 * 无 scope 别名的转发层。
 *
 * 真实实现是 @whaletalk/dsh-codex-collab 的 ./bridge 子路径导出。这里只做
 * 具名导出转发，保证 DSH 加载器拿到的 name / inject / apply 与真实包完全一致。
 *
 * 不要把这里改成 default export：Cordis 插件契约读的是具名导出。
 */
export * from '@whaletalk/dsh-codex-collab/bridge'
