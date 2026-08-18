# OpenAI-Compatible Image Edits Research

## Official Image API

Source: https://platform.openai.com/docs/guides/image-generation (accessed 2026-08-18).

- The Image API separates text generation (`POST /images/generations`) from edits and reference-image generation (`POST /images/edits`).
- The edits endpoint accepts one or more reference images.
- The official multipart curl example sends multiple images as repeated `image[]` fields, followed by `model` and `prompt`.
- GPT Image endpoints return `data[].b64_json`; Image API streaming uses image-generation events carrying `b64_json`, matching the plugin's existing response parsers.

## Local DSH Attachment Contract

Source: `node_modules/@deepseek-ai/dsh-attachment/lib/types/index.d.ts` and `types.d.ts`.

- `ImageAttachmentRef` carries the opaque id, verified media type, byte length, dimensions, and optional safe display name.
- `AttachmentStore.readImage(ref, signal)` returns verified bytes plus the canonical ref and preserves cancellation.
- `imageLimits.maxImagesPerMessage` and `maxMessageImageBytes` are deployment policy boundaries; the tool should reuse these rather than inventing a second fixed local limit.

## Implementation Consequences

- Use native `FormData`/`Blob`; do not add the OpenAI SDK or a multipart dependency.
- Resolve full refs from the current session before calling `readImage`; an attachment id alone is insufficient for the verified read contract.
- Keep reference ids as the model-facing parameter and enforce session ownership before upstream I/O.
