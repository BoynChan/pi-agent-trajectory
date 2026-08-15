# Pi Agent Trajectory

给 [Pi coding agent](https://github.com/badlogic/pi-mono) 增加一份独立、仅追加、可校验的执行轨迹（execution trajectory）。它记录模型实际收到的上下文和 provider payload、流式输出、工具调用与结果、压缩/分支事件，并可导出为单文件 HTML 检查页面。

这个项目把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的几个关键思路映射到 Pi 扩展 API：事件日志是真源、最终消息引用流式 chunk、工具结果引用工具调用、崩溃后补齐未闭合事件、展示层从日志派生。实现是针对 Pi API 独立编写的，没有复制 DeepSeek Harness 源码。

> 当前兼容基线：`@earendil-works/pi-coding-agent >= 0.84.2`、Node.js `>= 22.19.0`。

## 为什么不直接使用 Pi session JSONL？

Pi 自己已经保存会话、分支和压缩状态，适合恢复对话；本插件解决的是另一个问题：保留一份面向审计和调试的执行流水。

| Pi session | 本插件 trajectory |
| --- | --- |
| 用于恢复和继续会话 | 用于检查一次执行到底发生了什么 |
| 主要保存最终会话条目 | 同时保存 request context、provider payload 和流式 chunk |
| 由 Pi 管理分支和压缩 | 观察并记录分支、压缩及其后的真实请求 |
| 不应被第三方插件替代 | 独立文件，删除不影响 Pi 会话 |

## 接入已有 Pi Agent

### 方式一：从 GitHub 全局安装（推荐）

```bash
pi install git:github.com/BoynChan/pi-agent-trajectory
```

安装后正常启动已有的 Pi：

```bash
pi
```

Pi 会从包清单里的 `pi.extensions` 自动加载 `src/index.ts`。不需要修改 Pi 源码，也不需要手工注册 hook。

### 方式二：只在当前项目安装

在目标项目目录执行：

```bash
pi install -l git:github.com/BoynChan/pi-agent-trajectory
```

### 方式三：单次试运行

```bash
pi -e git:github.com/BoynChan/pi-agent-trajectory
```

### 方式四：本地开发接入

```bash
git clone https://github.com/BoynChan/pi-agent-trajectory.git
cd pi-agent-trajectory
npm install --ignore-scripts
npm run check
pi install /absolute/path/to/pi-agent-trajectory
```

调试时也可以直接加载入口：

```bash
pi --no-extensions -e /absolute/path/to/pi-agent-trajectory/src/index.ts
```

## 使用

插件默认将文件写到：

```text
~/.pi/agent/trajectories/<pi-session-id>.jsonl
```

Pi 内置命令：

```text
/trajectory                 # 当前轨迹摘要
/trajectory path            # 文件路径
/trajectory validate        # 校验 header、schema、seq 连续性
/trajectory tail 20         # 最近 20 个事件
/trajectory export          # 导出到当前目录
/trajectory export run.html # 导出到指定文件
```

独立 CLI：

```bash
pi-trajectory ~/.pi/agent/trajectories/<session-id>.jsonl
pi-trajectory <file.jsonl> --json
pi-trajectory <file.jsonl> --tail 30
pi-trajectory <file.jsonl> --html trajectory.html
```

HTML 是单文件离线页面，包含摘要、事件筛选和可展开的原始数据，不会访问外部服务。

## 配置

自定义保存目录：

```bash
pi --trajectory-dir /secure/path/to/trajectories
```

或：

```bash
export PI_TRAJECTORY_DIR=/secure/path/to/trajectories
pi
```

默认是 fail-open：记录失败会通知一次并停用当前 recorder，但不会阻断 agent。需要把持久化当作模型请求和工具执行的硬前置条件时：

```bash
pi --trajectory-strict
```

strict 模式会在 `context`、`before_provider_request` 和 `tool_call` 这些关键边界等待落盘并在失败时抛错。流式 token 仍采用顺序追加，避免每个 token 都执行 `fsync`。

## 轨迹格式

每个文件都是 JSONL。第一行是 header：

```json
{"type":"trajectory/session","schemaVersion":1,"sessionId":"...","createdAt":"...","cwd":"...","pluginVersion":"0.1.0"}
```

后续每行是一个事件：

```json
{
  "type": "assistant/message",
  "schemaVersion": 1,
  "sessionId": "...",
  "seq": 42,
  "time": "2026-08-15T08:00:00.000Z",
  "data": { "message": {} },
  "sourceEventSeqs": [31, 32, 33],
  "surfaceOp": "append"
}
```

核心约定：

- `seq` 从 1 连续递增，是文件内的稳定顺序。
- `assistant/chunk` 保存增量，不重复保存 Pi 提供的不断增长的 `partial` 快照，避免长输出出现平方级膨胀。
- `assistant/message.sourceEventSeqs` 指向组成它的 chunk。
- `tool/result.sourceEventSeqs` 指向对应的 `tool/call`。
- `user/message`、`assistant/message`、`tool/result` 带 `surfaceOp: "append"`，可投影成会话表面。
- `request/context` 保存 Pi 在 LLM 调用前给扩展的消息、system prompt、模型、thinking level 和启用工具。
- `request/payload` 保存 provider request hook 看到的实际请求体；不记录 HTTP Authorization header。
- 启动时发现未闭合 run、step 或 tool call，会先写 `recovery/interrupted`，再追加合成的闭合事件。尾部只有半行 JSON 时会安全截断；完整但缺换行的记录会保留。

主要事件族：

```text
session/*       session/start, session/info, session/end
run/*           run/start, run/end, run/settled
step/*          step/start, step/end
request/*       request/header, request/context, request/payload
assistant/*     assistant/chunk, assistant/message
tool/*          tool/call, tool/execution-start, tool/update,
                tool/execution-end, tool/result
compaction/*    compaction/start, compaction/end
tree/*          tree/start, tree/end
model/select, thinking/select, provider/response, user/bash
```

## DeepSeek Harness 到 Pi 的映射

DeepSeek Harness 的 session 设计把类型化 append-only event log 当作真源；由事件投影消息和 trajectory，并用 `sourceEventSeqs` / `surfaceOp` 表达来源与可见会话表面。本插件保留其中适合扩展层的部分：

```text
DeepSeek Harness                  Pi extension hook                  本插件事件
session / run boundary            session_* / agent_*                session/*, run/*
step boundary                     turn_start / turn_end              step/*
request inspection                context / before_provider_request  request/*
assistant stream + final          message_update / message_end       assistant/*
tool call + result                tool_call / tool_result             tool/*
derived trajectory view           /trajectory + CLI                  summary / HTML
```

和 DeepSeek Harness 核心实现不同，本插件不能把 Pi 内部状态改造成事件溯源，也不应该这样做。它是旁路观察者：Pi session 仍是可恢复对话的权威数据，本插件文件是执行审计的权威数据。

## 数据安全

轨迹可能包含高度敏感信息：完整 prompt、thinking/reasoning、用户消息、文件内容、shell 命令、工具参数/结果和 provider payload。建议：

- 不要提交 `~/.pi/agent/trajectories` 到 Git。
- 将目录权限和备份策略按密钥材料处理；目录创建权限为 `0700`，新 HTML 导出权限为 `0600`。
- 分享 HTML 或 JSONL 前先做脱敏。
- 多个 Pi 进程不要同时写同一个 session ID 对应的文件；v0.1 没有跨进程文件锁。
- 如果另一个扩展在本插件之后修改 provider payload 或 tool input，本插件 hook 看到的是它执行时刻的值；最终 `tool/result.input` 会再次记录实际执行参数。

## 开发与验证

```bash
npm install --ignore-scripts
npm run typecheck
npm test
npm run check
```

测试覆盖连续序号、断尾修复、完整无换行记录、崩溃闭合恢复，以及摘要/usage/context 投影。

## 设计边界

- v0.1 不做远程上传、数据库索引或 OpenTelemetry exporter。
- JSONL 是 append-only；HTML 和摘要是可重新生成的派生视图。
- schema 当前为 `1`。读取器拒绝不连续序号或 session ID 混写，不自动猜测迁移。
- Pi 自身的压缩和分支不会被插件重放实现；插件记录事件以及操作后的真实 request context/payload。

## License

[MIT](LICENSE)
