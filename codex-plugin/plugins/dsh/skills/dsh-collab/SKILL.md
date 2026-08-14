---
name: dsh-collab
description: "与 DeepSeek Harness 编码协作。当用户要写代码、建项目、改代码时使用：把编码任务交给本机 DeepSeek Harness 的编码子代理执行（DeepSeek 写代码，你负责验收），在 --cwd 指定的工作目录（通常是 Codex 当前项目目录）中读文件验收；DeepSeek 完成后可自动 git 提交，并可用独立评审子代理审查 diff（评审员会实际跑通构建/测试）。不通过则发修正指令迭代，直到通过再向用户汇报。"
---

# DeepSeek Harness 编码协作

## 角色

- 你 = 项目经理 + 验收员。DeepSeek 编码子代理 = 程序员，在 `--cwd` 指定的工作目录中写代码（任意目录，Codex 打开哪个项目就传哪个目录）。
- 子代理保留跨任务记忆；独立评审子代理与编码员分离，不信任口头报告，只认真实文件与真实运行结果。

## 工具脚本（固定位置）

- 派活：`D:/Harness/.codex-collab-tools/task.mjs`
- 评审：`D:/Harness/.codex-collab-tools/review.mjs`

## 下发任务

```bash
node "D:/Harness/.codex-collab-tools/task.mjs" --in "<完整中文指令>" --cwd "<工作目录>" [--lane <通道>] [--model fast|pro] [--commit] [--timeout 秒]
```

- `--cwd`：**默认传 Codex 当前打开的项目目录**（绝对路径，正斜杠）；不存在时自动创建并注册为 harness 工作区。
- `--lane`：并行通道名（默认 main）。同一目录不同 lane 的任务**并行执行**（如 backend 与 frontend 各一路）；跨目录天然并行。
- `--model`：`fast`（deepseek-v4-flash，快而省）或 `pro`（deepseek-v4-pro，质量优先）；默认继承当前模型。
- `--commit`：任务完成后在 `--cwd` 自动 `git add -A` 并提交（提交信息含任务摘要）；非 git 仓库自动跳过。
- 指令必须包含：目标与产出物、验收标准、约束。`--wait` 为默认行为（结果直接回本对话），最长 10 分钟，长任务加 `--timeout 1800`。

## 读取汇报与验收

1. 脚本最后输出 `=== DeepSeek 汇报 ===`（做了什么、改动文件、如何验证、待决策问题）。
2. 读 `--cwd` 中它声称改动的文件核对；必要时自己跑构建/测试。
3. 通过 → 向用户汇报；不通过 → 发修正指令（子代理记得该目录上下文），迭代到通过。

## 双向评审（Codex 验收 DeepSeek 的变更）

DeepSeek 任务完成后，把它的变更交给独立评审子代理：

```bash
node "D:/Harness/.codex-collab-tools/review.mjs" --cwd "<工作目录>" [--diff git|git-staged|@文件|"diff 文本"] [--focus "<审查重点>"]
```

- `--diff` 默认取 `git diff`（未提交变更）；`git-staged` 取暂存区；也可直接给 diff 文本或文件（`@路径`）。
- 评审员会：读 `--cwd` 真实文件核对 diff → 静态审查（正确性/健壮性/安全/测试缺口）→ **实际运行构建与测试验证可跑通** → 输出结构化报告（结论 + 问题列表 + 跑通验证 + 修改建议）。
- 你阅读 `=== 评审报告 ===`，有问题就发修正指令给编码员，直到评审通过。

## 任务管理

```bash
node "D:/Harness/.codex-collab-tools/task.mjs" --list              # 最近任务列表
node "D:/Harness/.codex-collab-tools/task.mjs" --status <taskId>   # 查询单个任务
node "D:/Harness/.codex-collab-tools/task.mjs" --cancel <taskId>   # 取消运行中的任务
```

## 故障排查

- 连接失败：DeepSeek Harness 未运行（应监听 http://127.0.0.1:3080），请提示用户启动。
- 读不到 `--cwd` 目录：提示用户在 Codex 设置中把该目录加入可访问/可写目录。
