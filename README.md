# pi-extension-plan-mode

pi 插件：Codex 式 plan 模式（终端确认版）。AI 先探索代码、用 `submit_plan` 呈现完整计划，你在终端里批准 / 修改 / 驳回；批准之前写操作被硬拦截。**全程零 provider prompt-cache 失效**。

## 流程

```
/plan（或再按一次关闭）
   └─ 进入 plan 模式：write/edit 只能写 cwd 内的 .md/.mdx 文件，bash 放开
        │  AI 只读探索 → 计划写成 markdown 文件（如 PLAN.md / plans/auth.md）
        │  → 调 submit_plan(filePath)（提交时读盘，不传内容）
        ▼
   终端弹窗（ctx.ui.select）三选一：
     ├─ Approve — start implementation
     │     写限制立即解除，AI 在同一轮继续执行
     ├─ Revise — give feedback
     │     弹出编辑器输入修改意见 → 作为 tool result 返回 → AI 修订后重提
     └─ Reject — stop here
           AI 停下等待新指示
```

Esc 取消弹窗 = 本轮放弃评审，AI 原地等输入，模式不变。

## 缓存安全设计（与 Plannotator #922/#1380/#1381 同源的教训）

四条不变量，全部经过测试钉死（`tests/plan-mode.test.ts` 的 cache-safety 组）：

1. **从不修改 systemPrompt** —— `before_agent_start` 只注入会话消息，绝不返回
   `systemPrompt` 字段。Pi 的基础提示词（AGENTS.md、技能目录、工具说明）一次构建终身不变。
2. **工具集恒定** —— `submit_plan` 注册一次、永久 active，全程不用 `setActiveTools`
   增删。工具数组是 provider 缓存前缀的一部分（pi-ai 在最后一个工具上打
   `cache_control`），任何非纯增量的工具变更都会使 tools + system + 全部消息重建。
   注意：pi 官方示例 `examples/extensions/plan-mode` 用的正是 `setActiveTools` +
   `context` 过滤器，两处都会打爆缓存，**不要照抄**。
3. **写限制用 `tool_call` 事件拦截** —— blocked 结果作为 tool result 追加到历史尾部，
   append-only，零缓存成本，且 reason 文本本身就是对 AI 的即时纠偏。
4. **历史 append-only** —— 进入模式注入一条 framing，退出注入一条
   `[PLAN MODE OFF]` 反令；旧框架说明留在原地由反令显式作废，绝不注册
   `context` 处理器回删历史中段（那会使后续所有消息位移、整段重算——
   Plannotator 实测 88/119 条消息被 re-bill 的教训）。

代价与取舍：plan 模式下 AI 尝试写入会收到一次 blocked 提示（浪费一次工具调用），
换来相位转换零缓存重建。

## 安装

```bash
# 包管理（发布后）
pi install npm:pi-extension-plan-mode
# 或 git
pi install git:github.com/<you>/pi-extension-plan-mode

# 不安装、临时体验当前目录的包
pi -e .

# 或手动拷贝单文件
cp index.ts ~/.pi/agent/extensions/plan-mode.ts
```

装完 `/reload` 热加载。`pi list` 查看已装包，`pi remove ...` 卸载。

## 使用

| 操作 | 效果 |
|---|---|
| `/plan` | 开启 plan 模式（状态栏 `⏸ plan`） |
| `/plan`（再次） | 关闭（注入反令，写限制解除） |
| `submit_plan` | AI 提交计划，终端弹窗评审 |

无 UI 环境（`pi -p "..."` print 模式）：`submit_plan` 不阻塞，计划记录后继续，
不会把「无人值守」误判成批准或拒绝。

## 写门控与 bash

plan 模式下 write/edit 放行 **cwd 内任意 markdown 文件**（`.md`/`.mdx`；路径
resolve 后必须落在 cwd 内，目录穿越与绝对路径逃逸均拒绝）——多个计划/多个
agent 各写各的文件，文件名有意义。其余写入一律拦；bash 完全放开（pi 本无
权限弹窗，放开换来探索期零误拦），framing 只软性提醒避免有副作用的命令。
真正的写入发生在计划批准之后。

`submit_plan` 不传计划内容，只传 `filePath`：提交时校验路径（md/mdx、cwd 内）、
读盘、空文件报错。修订时改同一个文件，再次以相同路径提交。

## 会话恢复

相位状态（plan 模式开关、framing 闩锁、反令待发标记）通过 `pi.appendEntry`
持久化进会话；`session_start`（resume/fork）与 `session_tree`（树上切换）都从
活动路径重放——切到从未开过 plan 模式的分支会自动回 idle。

## 开发

```bash
pnpm test        # vitest，23 个用例
pnpm typecheck   # tsc --noEmit
pnpm check:biome # lint + format 检查
```

## License

MIT
