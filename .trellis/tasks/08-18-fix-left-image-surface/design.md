# Design - 修复生图左侧显示工具结果关联

## Boundary

只修改插件的 `generate_image.execute()` 左侧展示逻辑及其测试。DSH session、tool scheduler 和客户端渲染保持不变。

## Root Cause

工具执行期间调用 `session.append('assistant/message', ..., { surfaceOp: 'append' })`。append 会新增模型可见节点；合并后的消息仍携带原 `tool-call` blocks，因此每次图片完成都会重复声明整组工具调用。并发四次时，模型历史出现多组重复调用和一组结果。

## Data Flow

1. 找到当前 turn/step 最新的模型可见 assistant surface event，读取其原始 content、source/replayState 和 seq。
2. 从最新 UI append assistant 事件读取已展示图片，按 attachment id 合并本次生成的 image blocks。
3. 用 `surfaceOp: 'append'` 同步追加一条 assistant 展示事件；DSH 客户端只渲染 append 事件，因此图片出现在左侧。
4. 紧接着用 `surfaceOp: { op: 'replace', start: currentSeq, end: displaySeq }` 把原 surface 节点和展示节点折叠成一条模型可见 assistant 消息。replacement 保持原 content 与完整 source/replayState 不变，并用 `sourceEventSeqs: [currentSeq, displaySeq]` 声明完整来源。
5. 下一次并发完成时以最新 replacement 为基底，重复“展示 append + 模型 replacement”，因此 UI 逐张累积图片，而模型 surface 始终只有一个 assistant 节点。
6. DSH 随后按原流程追加每个 `tool/result`，调用与结果保持一一对应。

## Contracts

- replacement 目标必须属于当前 turn/step 且为最新 assistant message。
- UI append 与 surface replacement 必须在同一同步代码块连续完成，中间不得 `await`。
- 图片仅存在于 UI append 事件；不得加入模型 replacement，否则 pi-ai replay block 数量变化会触发跨 API ID 归一化并破坏 tool result 配对。
- 找不到可替换节点或 replacement 失败时记录 warning；不得退回右侧 `deferContext`，避免违反“仅左侧显示”。工具结果本身仍返回图片，不影响附件数据。
- 图片按 `attachmentId` 去重，避免重试或重复完成造成重复展示。
- 保持 `isConcurrencySafe: () => true`。

## Tradeoffs

- 不新增抽象层；在现有 execute 块内完成最小修复。
- DSH 客户端忽略 replacement assistant 事件，因此需要一个 append 事件负责左侧渲染，再由 replacement 立即消除它在模型历史中的重复调用；真实 `Session` 验证后 surface 只保留 replacement 节点。
- 展示失败时宁可缺少左侧缩略图，也不制造右侧消息或再次破坏工具协议。

## Rollback

回滚 `lib/index.js` 和对应测试即可；不涉及持久化格式迁移。
