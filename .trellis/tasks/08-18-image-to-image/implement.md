# Implement - 支持图生图并完善 Skill 指引

## Steps

1. 在 marker/session 包装附近加入最小的 session 图片引用索引，递归收集原始 image 块，并在生成图片保存后补充新 ref。
2. 扩展 `generate_image` schema 与说明，增加 `referenceImageIds` 数组及动态数量、去重、会话归属校验。
3. 从 session 索引解析 refs，使用 `ctx.attachments.readImage()` 按顺序读取和验证全部参考图。
4. 在现有 API helper 中增加 `/images/edits` multipart 分支；复用鉴权、size/quality 规则、SSE/JSON 解析与错误映射，保持 generations 分支不变。
5. 扩展 fake attachment store，并新增最小测试：多图 `image[]` 顺序和字节、无参数文生图兼容、无效/重复/超限 id 在 fetch 前失败、编辑返回保存与展示。
6. 更新 trigger system prompt、`skills/generate-image/SKILL.md` 和 Skill 注册测试，覆盖上传图片、多个参考图、继续修改生成结果及缺图提示。
7. 更新中英文 README 与 `.trellis/spec/backend/dsh-plugin.md`，移除“Image editing deferred”，记录编辑端点契约和错误边界。
8. 执行静态检查、完整测试和任务校验；在真实 DSH Web 中分别验证上传图片编辑及生成结果二次编辑。

## Validation

- `node --check lib/index.js lib/client.js`
- `npm test`
- `python3 ./.trellis/scripts/task.py validate .trellis/tasks/08-18-image-to-image`
- DSH Web：上传两张图片并要求合成，确认调用 `/images/edits`、结果显示在 assistant 左侧。
- DSH Web：对上一张生成结果要求换风格，确认使用其 attachment id 再次编辑。
- DSH Web：不附图直接生图，确认仍调用 `/images/generations`。

## Risk And Rollback Points

- 风险集中在 session 原图引用索引和 multipart 供应商兼容；相关测试必须断言跨会话 id 不可读取，且重复 `image[]` 字段顺序稳定。
- 不设置 multipart `Content-Type` header，避免 boundary 缺失；若供应商拒绝流式编辑参数，先以真实端点证据修正编辑分支，不改变文生图协议。
- 不以文生图作为图生图失败回退，否则会产生看似成功但未使用参考图的错误结果。
