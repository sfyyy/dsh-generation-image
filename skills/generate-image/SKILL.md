---
name: generate-image
description: Generate an image on demand with the generate_image tool. Use whenever the user asks to generate/create/draw/make/render an image, picture, photo, illustration, avatar, logo, banner, icon, meme, or 生成/制作/画一张图片/图像/照片/插画/头像/配图/壁纸/海报 — call generate_image directly, never fall back to local drawing (PIL/ImageMagick), and never require the user to name the tool.
whenToUse: The user requests any image-generation intent (生成/画/制作一张图片, or describes a visual they want).
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
- asks for variations, a different style, or a regeneration of a previously
  generated image.

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
- `size`（可选）: e.g. `1024x1024`, `1024x1792`, `1792x1024`, or `auto`/omitted
  to let the API decide.
- `quality`（可选）: `auto` (default), `low`, `medium`, `high`, or any value the
  endpoint accepts.
- `count`（可选）: 1–4 images (default 1).

Example:

```
generate_image(
  prompt: "a cute golden retriever puppy sitting on green grass, warm sunlight, shallow depth of field, photorealistic",
  size: "1024x1024",
  quality: "high",
)
```

## 结果处理

The generated image is delivered into the conversation as an assistant-side
image and saved as a durable attachment. After the call, tell the user the image
is ready, and offer variations (different breed / scene / style, or more
images) when appropriate.
