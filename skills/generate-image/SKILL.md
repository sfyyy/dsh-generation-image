---
name: generate-image
description: Generate or edit images on demand with the generate_image tool. Use for text-to-image and image-to-image requests, including modifying, restyling, combining, or creating variations from attached or previously generated images. Pass conversation attachment ids through referenceImageIds for image-to-image; never pretend to edit a missing image or fall back to local drawing.
whenToUse: The user requests image generation or asks to modify, restyle, combine, or create a variation from images in the conversation.
---

# `generate_image` 工具使用指南

The agent has a `generate_image` tool that generates images on demand by calling
the configured OpenAI-compatible image endpoint. This skill tells you **when** to
call it and **how** to call it well.

## 触发条件 — 直接调用 `generate_image`（无需用户点名工具）

Call `generate_image` **immediately and directly** when the user:

- asks to **generate / create / draw / make / produce / render / design** an
  **image / picture / photo / illustration / artwork / avatar / logo / banner /
  icon / meme / cover / thumbnail / wallpaper / poster**;
- writes in Chinese: **生成 / 制作 / 画 / 创建 / 设计 一张 图片 / 图像 / 照片 /
  插画 / 头像 / 配图 / 壁纸 / 海报 / 示意图 / 封面**;
- describes a scene, person, animal, object, or style they want as a picture
  (e.g. `一只金毛幼犬坐在草地上`, `a cat in a hat`, `a neon cyberpunk city`);
- asks to modify, restyle, combine, or create a variation from attached or
  previously generated images (e.g. `把这张图改成水彩风格`, `combine these two
  reference images`).

**Do NOT** require the user to say "use the generate_image tool" or
"生成图片工具". Recognize the intent and call the tool yourself.

**Do NOT** draw the image locally with `bash` + PIL / ImageMagick / rsvg-convert
or any other workaround — the `generate_image` tool is the intended path.

## 不要调用 `generate_image` 的情况

- the user only wants text / explanation / code / analysis (no image needed);
- the user is asking about the plugin or the tool itself;
- the request is not an image-generation intent.

## 如何调用

- `prompt`（必填）: a **detailed description** of the image. Write it in
  **English** for best results (the image model is English-tuned), even when the
  user wrote in Chinese. Include subject, environment, style, lighting,
  composition, and mood.
- `size`（可选）: recommend `1024x1024`, `1024x1792`, or `1792x1024`;
  use `auto`/omit it to let the API decide. A custom size must use the
  `WIDTHxHEIGHT` format with positive integer width and height, and both values
  must be multiples of 16 (for example, `768x1344`). If the user supplies an
  invalid custom size, ask them to choose a valid size or suggest a nearby valid
  size; do not call `generate_image` with the invalid value.
- `quality`（可选）: `auto` (default), `low`, `medium`, `high`, or any value the
  endpoint accepts.
- `count`（可选）: 1–4 images (default 1).
- `referenceImageIds`（图生图时必填）: an ordered array of one or more image
  attachment ids from the current conversation. Use the ids shown in image
  markers or previous `generate_image` results. Omit this field for
  text-to-image.

## 图生图规则

1. Identify the image attachment id(s) from the current conversation marker or
   a previous `generate_image` result.
2. Write a prompt that states the desired edit and what must be preserved.
3. Call `generate_image` with those ids in `referenceImageIds`. For multiple
   references, preserve the user's requested order.
4. If the user asks to edit an image but no image attachment exists, ask them
   to upload the image first. Do **not** call text-to-image as a silent fallback.

Example:

```
generate_image(
  prompt: "a cute golden retriever puppy sitting on green grass, warm sunlight, shallow depth of field, photorealistic",
  size: "1024x1024",
  quality: "high",
)
```

Image-to-image after the user uploads an image whose marker contains
`sha256:abc...`:

```
generate_image(
  prompt: "restyle the reference image as a soft watercolor illustration while preserving the subject, pose, and composition",
  referenceImageIds: ["sha256:abc..."],
  quality: "high",
)
```

Combining uploaded or previously generated images:

```
generate_image(
  prompt: "create one coherent product scene using the subject from the first reference and the background style from the second reference",
  referenceImageIds: ["sha256:first...", "sha256:second..."],
)
```

## 结果处理

The generated image is delivered into the conversation as an assistant-side
image and saved as a durable attachment. After the call, tell the user the image
is ready, and offer variations (different breed / scene / style, or more
images) when appropriate.
