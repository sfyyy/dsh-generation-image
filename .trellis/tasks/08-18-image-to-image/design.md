# Design - 支持图生图并完善 Skill 指引

## Boundaries

- 保留单一 `generate_image` 工具；`referenceImageIds` 缺省时走现有文生图，非空时走图生图，显式空数组按参数错误处理。
- 图生图只接受当前会话中的 DSH 图片附件 id，不接受路径、URL 或 base64 参数。
- 复用现有配置、鉴权、响应解析、图片保存和 assistant 左侧展示，不增加依赖或设置项。

## Tool Contract

新增可选参数：

```json
{
  "referenceImageIds": {
    "type": "array",
    "items": { "type": "string" },
    "minItems": 1,
    "uniqueItems": true
  }
}
```

执行时再按 `ctx.attachments.imageLimits.maxImagesPerMessage` 校验动态数量上限。数组顺序即 multipart 参考图顺序。空数组按参数错误处理，避免调用者误以为执行了图生图。

## Attachment Resolution

1. 执行图生图时递归扫描当前 session 的不可变事件历史，从 `image` 块建立临时 `attachmentId -> ImageAttachmentRef` 映射；生成结果的 assistant 展示事件也自然进入该历史，因此可继续编辑。
2. 只允许从该临时映射解析 id；找不到即在调用上游前失败，防止跨会话引用和伪造元数据。
3. 按参数顺序调用 `ctx.attachments.readImage(ref, signal)`，由 attachment 服务验证内容寻址引用与图片字节。
4. 读取后按 `maxMessageImageBytes` 校验聚合字节数，再构造上游请求。

映射仅在一次工具执行期间存在，不缓存或持久化图片字节，也不引入新的存储层。

## API Requests

### Text To Image

保持现有 `POST {baseUrl}/images/generations` JSON 请求不变。

### Image To Image

发送 `POST {baseUrl}/images/edits`，使用 Node 原生 `FormData` 与 `Blob`：

- 每张参考图按顺序追加为重复的 `image[]` 字段；文件名只使用 attachment ref 的安全显示名或生成的默认名。
- 追加 `model`、`prompt`、`n`、`response_format=b64_json`。
- `size`、`quality` 沿用现有规则：空值或 `auto` 不发送，其余值原样透传。
- 若编辑端点支持现有流式协议，发送 `stream=true`、`partial_images=1`；响应继续使用同一套 SSE/普通 JSON 解析。
- 只设置 `Authorization`，不手工设置 `Content-Type`，由 `FormData` 生成 boundary。

## Skill Behavior

- 用户附图并说“修改这张图”“按这些参考图生成”“换成某种风格”时，agent 从 marker 取得附件 id，调用 `generate_image` 并填写 `referenceImageIds`。
- 用户指明多张图时保持用户给出的顺序；未明确时使用当前请求中的相关图片。
- 用户要求图生图但会话没有图片时，先请用户上传，不得只把图片想象成文字提示后执行文生图。
- 用户要求从零生成时不传 `referenceImageIds`。
- 对刚生成图片的后续修改使用工具结果或 marker 中的 attachment id。

## Compatibility And Errors

- `/images/edits` 是新增的供应商能力要求；不支持时直接呈现现有 HTTP/provider 错误，不静默回退到文生图。
- 任一参考图解析或读取失败时不发起请求；多图读取不允许跳过失败成员。
- mask/inpainting 不在本任务内，避免把 reference edit 与局部编辑混为一个协议。

## Rollback

图生图路径由 `referenceImageIds` 是否存在隔离。回滚可删除该参数与 `/images/edits` 分支，现有 `/images/generations` 路径无需迁移配置或数据。
