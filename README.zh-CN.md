# @dsh-extension/dsh-generation-image

> 为 DeepSeek Harness (DSH) 提供按需图像生成能力。

[![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-F7DF1E.svg?logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![npm version](https://img.shields.io/npm/v/@dsh-extension/dsh-generation-image.svg?logo=npm&color=cb3837)](https://www.npmjs.com/package/@dsh-extension/dsh-generation-image)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6BFE.svg)](https://www.npmjs.com/package/@deepseek-ai/dsh)

[English](./README.md)

这个 DSH 插件让 **DeepSeek 会话具备按需图像生成能力**：agent 获得一个
`generate_image` 工具，调用**你自己的** OpenAI 兼容图像 URL + API Key
（`POST /images/generations` 或 `/images/edits`），并把生成的图片送回会话。

- **文生图与图生图** — 可从提示词生成图片，也可通过 OpenAI 兼容
  `/images/edits` 端点编辑或组合一张、多张 DSH 图片附件。
- **自带图像端点** — OpenAI、xiaoyaoapi、vLLM 图像模型、本地网关等兼容服务。
- **图片进入会话界面** — 生成的字节会通过 DSH attachment 服务持久化保存，
  并以 assistant 左侧消息的形式放进会话，渲染成可点击的**缩略图**。点击可**放大**，
  放大后可**下载或关闭**。
- **文本模型保持安全** — DeepSeek 是纯文本模型，因此每次文本模型请求都会把
  image 块改写成文字标记（与
  [dsh-vision-bridge](https://github.com/sfyyy/dsh-vision-bridge) 相同的机制）；
  会话日志与界面仍然保留真实图片。
- **沿用 GPT2Image 验证过的请求形态** — `stream: true`、`partial_images: 1`、
  SSE `image_generation.completed` 事件（并兼容普通 JSON 响应），即 GPT2Image
  使用的端点（`https://api.xiaoyaoapi.cc/v1`，模型 `gpt-image-2`）。
- **同时兼容 b64_json 与 url 结果** — 内联返回图片的渠道（SSE 或普通 JSON 的
  `b64_json`）照常工作；返回远程 `url` 的渠道（如 `data[].url` 或 SSE 事件里的
  `url` 字段）会自动下载图片字节后再保存为附件，无需额外配置。

## 工作原理

```text
agent 调用 generate_image(prompt, size?, quality?, count?, referenceImageIds?)
   │
   ▼
未传 referenceImageIds → POST {baseUrl}/images/generations（JSON）
传入 referenceImageIds → attachments.readImage() → POST {baseUrl}/images/edits
                       （multipart，重复 image[] 字段）
   │
   ▼
SSE（image_generation.partial_image / .completed → b64_json 或 url）
   或普通 JSON（data[].b64_json / data[].url）
   │                        （url 结果会自动下载）
   ▼
magic bytes 识别格式 → attachments.saveImage() → 持久化图片引用
   │
   ▼
工具结果：文字摘要 + image 块，并追加一条 assistant 左侧展示消息
→ 会话中渲染为可点击缩略图
   │
   ▼
点击缩略图 → 内置灯箱放大，含「下载原图」+「关闭」
   │
   ▼
deriveMessages() 把 image 块改写为文字标记（文本模型永不收到 image 块）；
llm.resolveModelInfo 放行补丁让消息能进入 agent。
```

## 查看生成的图片

DSH Web 会把每张生成的图片渲染成会话左侧的**缩略图**（assistant 图片消息）。
同一消息里的多张图会**堆叠展示**；点击任意一张即可打开放大预览：

- **下载原图** — 放大预览右上角的下载按钮，把当前高清原图保存到本地。
- **关闭** — 右上角关闭按钮（以及点击遮罩）。
- **左右切换** — 多图时预览底部显示 `n / N`，两侧有上一张/下一张按钮。

无需额外配置；只要客户端 bundle 加载（升级插件后刷新一次 DSH 页面）即生效。

## 安装

从 npm 安装（而非本地检出）：

```sh
# 如果你已经有 dsh CLI：
dsh plugin --profile web add @dsh-extension/dsh-generation-image

# 或者你一直用 npx：
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add @dsh-extension/dsh-generation-image
```

> `--profile` 指定你启动的 profile（`web` 是浏览器 UI profile）。名字不同就
> 改成你自己的 profile。
>
> 新增 client bundle 后，重启一次 `dsh web` 让 UI 生效。

### 本地开发（与 vision-bridge 一致）

从本地检出把插件 link 进你的 profile，然后重启 `dsh web`：

```jsonc
// ~/.dsh/profiles/web/package.json → dependencies
{
  "@dsh-extension/dsh-generation-image": "link:/path/to/dsh-generation-image"
}
// ~/.dsh/profiles/web/package.json → dsh.profile.bundles
"@dsh-extension/dsh-generation-image"
```

或在已运行的实例上使用超级注入器：
```sh
dsh plugin inject /path/to/dsh-generation-image
```

## 配置

在 **Settings → Generation Image**（DSH Web）中配置，或编辑
`~/.dsh/generation-image.json`。**插件默认不带任何 key/url（均为空）**——
端点 URL 和 API Key 由你自己填（Settings 页、环境变量或配置文件均可）：

```json
{
  "enabled": true,
  "baseUrl": "https://your-image-endpoint.example/v1",
  "apiKey": "sk-xxxx",
  "model": "gpt-image-2",
  "size": "",
  "quality": "auto"
}
```

- `baseUrl` — OpenAI 兼容图像 API 根地址（`.../v1`）；**默认为空**，插件会规范
  化并根据工具参数调用 `${baseUrl}/images/generations` 或
  `${baseUrl}/images/edits`。
- `apiKey` / `apiKeyEnv` — **默认为空**，二者互斥。直接填写的 key 会同步到
  DSH 凭据库，并以 `DSH_GENERATION_IMAGE_API_KEY` 引用。
- `model` — 图像模型 id（默认 `gpt-image-2`）。
- `size` — 默认尺寸提示，**默认为空 = 不限制**：模型每次调用可传任意尺寸，
  或传 `"auto"` 让 API 自己决定；不会强制任何尺寸。
- `quality` — 默认质量提示：`auto`（默认，请求中省略该字段，由 API 决定），
  或模型/端点接受的任意值。
- `enabled: false` 会禁用整条链路：不注册工具、不做图片改写、不启用放行补丁
  （恢复原生行为）。

**优先级（高者胜）：** Settings 页（含 schema 默认值）→ 环境变量 → 配置文件。

**环境变量覆盖：** `DSH_GENERATION_IMAGE_BASE_URL`、
`DSH_GENERATION_IMAGE_API_KEY`、`DSH_GENERATION_IMAGE_API_KEY_ENV`、
`DSH_GENERATION_IMAGE_MODEL`、`DSH_GENERATION_IMAGE_SIZE`、
`DSH_GENERATION_IMAGE_QUALITY`、`DSH_GENERATION_IMAGE_ENABLED`。

## `generate_image` 工具

- **参数**
  - `prompt`（必填）：对要生成图片的详细描述；
  - `size`（可选，**不限制**）：可传端点接受的任意尺寸（如 `1024x1024`、
    `1024x1792`、`1792x1024`），或 `"auto"`/省略让 API 决定。要真 4K 请传
    **`3840x2160`** 或 **`3840x3840`**——当前上游最大边为 3840px，`4096` 会
    超出上限导致失败。插件 bundle patch 会同时调高 DSH attachment-local 限制
    （`normalizedImageMaxDimension: 4096`、`normalizedImageMaxBytes: 26214400`），
    避免保存时把 4K 原图压到 2048；
  - `quality`（可选，**不限制**）：常见值 `auto`（默认）、`low`、`medium`、
    `high`，或端点接受的任意值；
  - `count`（可选，1–4）：生成几张图片（默认 1）。上游图像端点目前要求 `n=1`，
    插件会自动把 `count > 1` 拆成多次 `n=1` 请求；DSH 客户端会把同一条 assistant
    消息里的多张图**堆叠展示**。
  - `referenceImageIds`（可选）：当前会话中有序且不重复的图片附件 id。文生图时
    省略；图生图或组合多张参考图时传入一张或多张，数量受当前 DSH 图片策略限制。
- **行为**：调用配置的图像端点 → 解析 SSE 流（或普通 JSON）→ 用 magic
  bytes 识别真实格式 → 通过 DSH attachment 服务持久化每张图 → 返回文字摘要
  加每张图一个 image 块。
- **结果**：生成的图片出现在会话日志与 Web 界面；文本模型收到的是文字标记
  而非 image 块。
- **图生图用法**：上传一张或多张图片后，直接要求修改、换风格或组合。内置 Skill
  会读取图片 marker 中的附件 id 并传入 `referenceImageIds`；没有参考图片时会先
  请用户上传，不会静默退化为文生图。

## 验证

```sh
npm test
```

测试覆盖：工具注册开关、图像 API 调用（SSE + 普通 JSON）、多参考图
`/images/edits` multipart 请求、附件隔离、规范化返回值与渲染输出、嵌套
`run_code` 行为、图片标记改写（会话日志保持不变）、放行
补丁开关、下游工具过滤后的可见性、禁用行为、配置/环境变量优先级。

## 开发

从本地检出：

```sh
dsh plugin inject /path/to/dsh-generation-image
```

## 搜索关键词

`deepseek` · `deepseek-harness` · `dsh` · `plugin` · `image generation` ·
`text-to-image` · `image-to-image` · `img2img` · `generate image` · `gpt-image` · `OpenAI-compatible` ·
`images API` · `xiaoyaoapi` · `LLM agent`

## License

[MIT](./LICENSE)
