# @dsh-extension/dsh-generation-image

> 为 DeepSeek Harness (DSH) 提供按需图像生成能力。

[![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-F7DF1E.svg?logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![npm version](https://img.shields.io/npm/v/@dsh-extension/dsh-generation-image.svg?logo=npm&color=cb3837)](https://www.npmjs.com/package/@dsh-extension/dsh-generation-image)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6BFE.svg)](https://www.npmjs.com/package/@deepseek-ai/dsh)

[English](./README.md)

这个 DSH 插件让 **DeepSeek 会话具备按需图像生成能力**：agent 获得一个
`generate_image` 工具，调用**你自己的** OpenAI 兼容图像 URL + API Key
（`POST /images/generations`），并把生成的图片送回会话。

- **自带图像端点** — 任何 OpenAI 兼容的 `/images/generations` 服务（OpenAI、
  xiaoyaoapi、vLLM 图像模型、本地网关……）。
- **图片进入会话界面** — 生成的字节会通过 DSH attachment 服务持久化保存，
  并以用户消息的形式放进会话，渲染成可点击的**缩略图**。点击可**放大**，
  放大后可**下载或关闭**。
- **文本模型保持安全** — DeepSeek 是纯文本模型，因此每次文本模型请求都会把
  image 块改写成文字标记（与
  [dsh-vision-bridge](https://github.com/sfyyy/dsh-vision-bridge) 相同的机制）；
  会话日志与界面仍然保留真实图片。
- **沿用 GPT2Image 验证过的请求形态** — `stream: true`、`partial_images: 1`、
  SSE `image_generation.completed` 事件（并兼容普通 JSON 响应），即 GPT2Image
  使用的端点（`https://api.xiaoyaoapi.cc/v1`，模型 `gpt-image-2`）。

## 工作原理

```text
agent 调用 generate_image(prompt, size?, quality?, count?)
   │
   ▼
POST {baseUrl}/images/generations      (Bearer <apiKey>)
   body: { model, prompt, response_format: "b64_json", n: count,
           size, quality, stream: true, partial_images: 1 }
   │
   ▼
SSE（image_generation.partial_image / .completed → b64_json）
   或普通 JSON（data[].b64_json）
   │
   ▼
magic bytes 识别格式 → attachments.saveImage() → 持久化图片引用
   │
   ▼
工具结果：文字摘要 + image 块，并追加一条用户角色图片消息
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

DSH Web 会把每张生成的图片渲染成会话里的**缩略图**（用户角色图片消息）。
点击缩略图即可打开放大的灯箱：

- **下载原图** — 本插件客户端在放大视图右上角注入的下载按钮，把高清原图保存
  到本地。它作用于会话里的所有图片灯箱，因此上传的图片和截图同样具备下载能力。
- **关闭** — 内置关闭按钮（以及 `Esc` / 点击遮罩）。

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
`~/.dsh/generation-image.json`：

```json
{
  "enabled": true,
  "baseUrl": "https://api.xiaoyaoapi.cc/v1",
  "apiKey": "sk-xxxx",
  "model": "gpt-image-2",
  "size": "1024x1024",
  "quality": "auto"
}
```

- `baseUrl` — OpenAI 兼容图像 API 根地址（`.../v1`）；插件会规范化并调用
  `${baseUrl}/images/generations`。
- `apiKey` 与 `apiKeyEnv` 互斥。直接填写的 key 会同步到 DSH 凭据库，并以
  `DSH_GENERATION_IMAGE_API_KEY` 引用。
- `model` — 图像模型 id（默认 `gpt-image-2`）。
- `size` — 默认图片尺寸（默认 `1024x1024`；工具可按次覆盖）。
- `quality` — 默认质量：`auto`（默认）、`low`、`medium`、`high`。
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
  - `size`（可选）：如 `1024x1024`、`1024x1792`、`1792x1024`（默认取配置的
    `size`）；
  - `quality`（可选）：`auto` | `low` | `medium` | `high`；
  - `count`（可选，1–4）：生成几张图片（默认 1）。
- **行为**：调用配置的图像端点 → 解析 SSE 流（或普通 JSON）→ 用 magic
  bytes 识别真实格式 → 通过 DSH attachment 服务持久化每张图 → 返回文字摘要
  加每张图一个 image 块。
- **结果**：生成的图片出现在会话日志与 Web 界面；文本模型收到的是文字标记
  而非 image 块。

## 验证

```sh
npm test
```

测试覆盖：工具注册开关、图像 API 调用（SSE + 普通 JSON）、规范化返回值与渲染
输出、嵌套 `run_code` 的上下文回传、图片标记改写（会话日志保持不变）、放行
补丁开关、下游工具过滤后的可见性、禁用行为、配置/环境变量优先级。

## 开发

从本地检出：

```sh
dsh plugin inject /path/to/dsh-generation-image
```

## 搜索关键词

`deepseek` · `deepseek-harness` · `dsh` · `plugin` · `image generation` ·
`text-to-image` · `generate image` · `gpt-image` · `OpenAI-compatible` ·
`images API` · `xiaoyaoapi` · `LLM agent`

## License

[MIT](./LICENSE)
