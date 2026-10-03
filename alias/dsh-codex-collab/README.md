# dsh-codex-collab（无 scope 别名）

这是 [`@whaletalk/dsh-codex-collab`](https://www.npmjs.com/package/@whaletalk/dsh-codex-collab) 的**转发别名**，只为让 DeepSeek Harness 客户端「插件 → 添加插件」里可以直接填一个无 scope 的包名：

```
dsh-codex-collab
```

它本身不含实现：`bridge.mjs` 只有一行 `export * from '@whaletalk/dsh-codex-collab/bridge'`，`cordis.patch.yml` 挂的也是别名自己的子路径（原因见该文件里的注释——pnpm 的嵌套布局让 profile 根目录解析不到真实包的子路径）。

装哪个都一样，**二选一即可**，不要同时装（两者用同一个行 id `dsh-bridge`）：

```sh
# 别名（无 scope，客户端插件页可填）
dsh plugin --profile web add dsh-codex-collab

# 真身（推荐，文档与 issue 都指向它）
dsh plugin --profile web add @whaletalk/dsh-codex-collab
```

## 维护约定

- **版本与真身锁步**：本目录 `version` 必须等于仓库根 `package.json` 的 `version`（CI 会断言）。真身发新版时，这里同步改版本号。
- **发布方式**：只在 `publish.yml` 的 `workflow_dispatch` 里发布，进 `alias/` 目录执行 `npm publish --provenance --access public`；不会随 tag 自动发布，避免版本错位。

## License

MIT
