# 支持图生图并完善 Skill 指引

## Goal

用户上传或引用会话中的图片后，可以用自然语言要求修改图片；agent 根据 `SKILL.md` 自动识别图生图意图、取得附件 id，并通过 `generate_image` 完成图生图，而不是退化为仅参考文字描述的文生图。

## Background

- 当前 `generate_image` 仅接受 `prompt`、`size`、`quality`、`count`，固定调用 JSON 格式的 `POST /images/generations`。
- DSH 图片块包含持久化的 `ImageAttachmentRef`；文本模型收到的 marker 已包含附件 id。
- `ctx.attachments.readImage(ref, signal)` 可以读取并校验会话中的图片字节，可作为图生图上传来源。
- 当前 `SKILL.md` 提到 variations/regeneration，但没有参考图参数、上传步骤或图生图调用示例，实际仍是文生图。

## Requirements

- 保持 `generate_image` 为唯一工具；没有参考图参数时继续执行现有文生图流程。
- 为工具增加有序、不可重复的参考图片附件 id 数组；提供参数时，从当前会话解析对应的完整附件引用，并通过 `ctx.attachments.readImage()` 读取图片。首版支持多张参考图，数量不得超过当前 DSH attachment 策略允许的单消息图片数。
- 图生图请求使用配置基址下的 OpenAI 兼容图片编辑端点，采用 multipart/form-data 发送参考图、prompt、model、count，以及端点接受的 size/quality 等现有选项。
- 图生图响应复用现有 SSE/普通 JSON 解析、格式识别、附件持久化和左侧图片展示流程。
- 对缺失附件 id、附件不属于当前会话、非图片附件、读取失败及上游不支持图片编辑端点给出可操作错误，不允许读取任意文件路径或外部 URL。
- 更新工具描述、系统触发提示与 `SKILL.md`：识别“基于这张图修改/换风格/保留主体生成变体”等意图；已有图片时传附件 id，没有图片时先请用户上传；明确区分文生图与图生图。
- `SKILL.md` 至少包含一次用户上传图片后的图生图调用示例，以及基于之前生成图片继续修改的示例。
- 更新中英文 README，记录参数、端点和兼容性要求。
- 保持现有文生图、图片 marker 改写、工具结果关联、下载与配置优先级行为不变。

## Acceptance Criteria

- [x] 不传参考图片时，请求仍发送至 `/images/generations`，现有测试保持通过。
- [x] 传入当前会话中一张或多张有效参考图片的附件 id 时，请求发送至 `/images/edits`，multipart 按参数顺序包含全部原始图片字节和正确的生成参数。
- [x] 图生图的 SSE 与普通 JSON 返回均能保存为 DSH 附件，并在 assistant 左侧显示。
- [x] 无效、跨会话或无法读取的附件 id 在发起上游请求前失败，并返回明确错误。
- [x] 工具 schema、系统提示和 `SKILL.md` 能让 agent 在用户上传图片并要求修改时自动选择图生图参数；没有参考图片时不会伪装执行图生图。
- [x] `SKILL.md` 明确说明用户操作方式，并覆盖上传图片、修改已生成图片两条路径。
- [x] 新增最小回归测试覆盖文生图兼容、图生图请求、无效附件和 Skill 文案契约；`npm test` 与 `node --check lib/index.js lib/client.js` 通过。

## Out Of Scope

- 本地图片路径、任意 URL 下载或未经 DSH attachment 服务验证的图片输入。
- mask/inpainting、局部涂抹编辑及前端图片编辑器。
- 修改 DSH 核心包或视觉模型对图片内容的理解能力。
- 为不同供应商增加独立协议适配层；首版只承诺 OpenAI 兼容 `/images/edits`。
