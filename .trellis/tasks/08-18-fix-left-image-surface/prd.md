# 修复生图左侧显示工具结果关联

## Goal

生成图片只显示在 DSH 会话的 assistant 左侧，同时保持工具调用与工具结果历史合法，使生图完成后模型可以继续运行。

## Background

- `generate_image` 的图片 API、附件保存和四个工具结果均成功。
- 当前实现位于 `lib/index.js:735-783`，每次工具执行都会用 `surfaceOp: 'append'` 追加一条包含原工具调用的 assistant 消息。
- 四个并发调用产生了四条重复 assistant 消息；下一步模型请求因此返回 `No tool output found for tool call ...`。
- DSH 的 append surface 节点全部进入 `Session.deriveMessages()`，所以这不是上游生图 API 故障。

## Requirements

- 图片必须显示在 assistant 左侧，不得通过 `deferContext()` 产生右侧 user 消息。
- 更新左侧 assistant 图片时必须替换当前模型可见的 assistant surface 节点，不得重复追加其中的工具调用。
- 单个 step 内多个并发 `generate_image` 调用必须累积全部已完成图片，且最终只保留一份原工具调用声明。
- 每个原始工具调用必须保留且只对应一个工具结果；下一 step 和下一 turn 均可正常请求模型。
- 保持现有图片生成、附件保存、文本模型图片 marker 重写和下载行为不变。

## Acceptance Criteria

- [x] 单次 `generate_image` 后，UI append assistant 消息携带左侧图片；模型 surface 只有一份对应工具调用，且没有 deferred user context。
- [x] 四次并发 `generate_image` 后，最新 UI append 累积四张图片；模型 surface 只有一组四个工具调用和四个工具结果。
- [x] 并发完成顺序不影响图片累积，不丢图、不重复图。
- [x] 模型 replacement 保留原 assistant content/source/replayState，会话重新载入合法，下一步不再缺失工具输出。
- [x] `npm test` 与 `node --check lib/index.js lib/client.js` 通过。
- [x] 真实 DSH Web 会话并发生成两张图片后，图片仅显示在左侧，下一 step 及发送“继续”的下一 turn 均正常完成。

## Out Of Scope

- 修改 DSH 核心包或 OpenAI/pi-ai 适配器。
- 修复已经损坏的历史会话日志；现有会话通过分支恢复。
- 改变生图 API、参数、视觉样式或图片下载交互。
