# DSH Bundle Plugin Development (this repo: dsh-generation-image)

> How to build/extend a DeepSeek Harness (DSH) bundle plugin in this project.
> The reference implementation is `lib/index.js` (host) + `lib/client.js`
> (browser settings). It mirrors `dsh-vision-bridge`.

## 1. Scope / Trigger

- New DSH plugin or extending the `generate_image` tool.
- Cross-layer: host half (node ESM, cordis) ↔ browser half (ModuleLoader client)
  ↔ DSH services (`settings`, `credentials`, `attachments`, `llm`, `tools`,
  `systemPrompt`).

## 2. Signatures

- Host entry: `export async function apply(ctx, config = {})`, plain ESM.
- `export const name = '@dsh-extension/dsh-generation-image'`
- `export const inject = ['settings', 'credentials', 'attachments', 'llm', 'tools', 'systemPrompt']`
- Tool: `tools.register({ name, description, parameters, output: { schema, render }, execute(args, exec) })`.
- Image API: `generateImagesFromApi({ ..., referenceImages? }, opts)` →
  `[{ data: Uint8Array, mediaType }]`; `referenceImages` entries are verified
  `{ ref: ImageAttachmentRef, data: Uint8Array }` values.
- Settings route: `GET|POST /_dsh/generation-image/settings`.

## 3. Contracts

### Config (settings namespace `generation-image`, file `~/.dsh/generation-image.json`)

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `enabled` | bool | `true` | master switch |
| `baseUrl` | string | `''` | **empty by default** (user-supplied); normalized to `.../v1` |
| `apiKey` | string | `''` | **empty by default**; direct key synced to credential `DSH_GENERATION_IMAGE_API_KEY` |
| `apiKeyEnv` | string | `''` | env-var name holding the key (mutually exclusive with apiKey) |
| `model` | string | `gpt-image-2` | image model id |
| `size` | string | `''` | **unrestricted**: empty/`auto` = omit from request (API decides); any concrete value passes through |
| `quality` | string | `auto` | **unrestricted**: `auto`/empty = omit from request; any value passes through |

Precedence (highest wins): Settings page → env vars → config file.
Env prefix: `DSH_GENERATION_IMAGE_` + `UPPER_SNAKE(key)`.

### Tool `generate_image`

- args: `prompt` (required string), `size` (optional string, unrestricted),
  `quality` (optional string, unrestricted), `count` (optional int 1–4, default
  1), `referenceImageIds` (optional ordered unique string array; omitted means
  text-to-image, non-empty means image-to-image).
- Request body to `${baseUrl}/images/generations`:
  `{ model, prompt, response_format: 'b64_json', n, size?, quality?, stream: true, partial_images: 1 }`,
  header `Authorization: Bearer <key>`. `size`/`quality` are sent only when a
  non-empty, non-`auto` value is supplied (case-insensitive `auto` check).
- Image-to-image resolves every id only from `image` blocks in the current
  session's immutable event history, reads each ref through
  `attachments.readImage(ref, signal)`, then sends `${baseUrl}/images/edits` as
  multipart/form-data. Each verified image is appended in argument order as a
  repeated `image[]` field; scalar fields are `model`, `prompt`,
  `response_format=b64_json`, `n`, optional `size`/`quality`, `stream=true`, and
  `partial_images=1`. Do not set `Content-Type` manually; native `FormData`
  owns the multipart boundary.
- Response: SSE (`image_generation.completed` / `partial_image` events carrying
  `b64_json`) or plain JSON (`data[].b64_json`).
- Output value: `{ prompt, size, quality, count, images: [{ attachmentId, mediaType, bytes, width, height, name }] }`.
- `output.render` → `[ {type:'text',...}, ...images.map(ref => ({ type:'image', attachment: ref })) ]`.
- **UI visibility**: bare `tool-result` image blocks are NOT rendered as
  thumbnails by the DSH web UI. The tool synchronously appends an
  `assistant/message` carrying the accumulated images for left-side rendering,
  then immediately replaces the previous model surface tail plus that display
  event with the original assistant content and complete source/replayState.
  The UI consumes the append event; `Session.deriveMessages()` sees the
  unchanged replay-safe replacement followed by tool results, so tool calls are
  neither duplicated nor re-identified. Generated images must never use
  `exec.deferContext`, which would render them as a right-side user bubble.
- **Download in the enlarged view**: the built-in `ImageLightbox` has no
  download button. The client (`lib/client.js`, `installLightboxDownload`)
  injects a `下载原图` button into every opened lightbox (`[role="dialog"][aria-modal="true"]`
  containing an `<img>`); the enlarged `<img src>` is a same-origin blob:/data:
  URL, so an `<a download>` click downloads it directly.

## 4. Validation & Error Matrix

| Condition | Behavior |
|-----------|----------|
| `enabled === false` | tool not registered; no rewrite; no admission bypass |
| baseUrl missing | `generateImagesFromApi` throws `generation-image: no baseUrl configured.` |
| apiKey/apiKeyEnv missing | throws `no apiKey or apiKeyEnv configured.` |
| HTTP 401/403/404/429/5xx | mapped to readable plugin messages (see `mapHttpError`) |
| SSE error event | `parseSseImages` throws with provider message |
| SSE ends with no image | throws `stream ended without a completed image.` |
| media type unknown | `sniffMediaType` defaults to `image/png`; `attachments.saveImage` re-validates against bytes |
| `referenceImageIds` present but empty/non-string/blank | fails before attachment reads and fetch |
| duplicate reference ids | fails before attachment reads and fetch |
| reference count exceeds `imageLimits.maxImagesPerMessage` | fails before attachment reads and fetch |
| id absent from the current session event history | fails before attachment reads and fetch; cross-session ids are not accepted |
| `attachments.readImage` fails | reports the attachment id and preserves the cause; no fetch occurs |
| verified reference bytes exceed `imageLimits.maxMessageImageBytes` | fails before fetch |
| provider lacks `/images/edits` | surfaces the mapped HTTP/provider error; never falls back to text-to-image |

## 5. Good / Base / Bad Cases

- Good: configured endpoint returns SSE completed event → image saved as
  attachment, text marker for the text model, image block in session log/UI.
- Base: endpoint returns plain JSON `{ data: [{ b64_json }] }` → same path.
- Good edit: two current-session ids resolve and read successfully → repeated
  `image[]` multipart fields reach `/images/edits` in the requested order →
  SSE or JSON output follows the normal save/render path.
- Base edit: omit `referenceImageIds` → the existing JSON
  `/images/generations` request remains byte-for-byte compatible.
- Bad: aggregator returns 503 with "No available channel for model X" → the
  plugin surfaces the provider message as a tool error (upstream issue, not a
  plugin bug).
- Bad edit: a model invents or copies an id from another session → local
  session lookup rejects it before storage or network I/O.

## 6. Tests Required

- `npm test` (node --test). Assertion points:
  - tool registered iff enabled;
  - request body shape + `Authorization` header;
  - SSE parse (completed wins, `[DONE]` ignored, error throws);
  - JSON fallback parse;
  - `decodeImages` dedup + media sniff;
  - `deriveMessages` rewrites image blocks (top-level and nested tool-result)
    while session log keeps originals;
  - admission bypass on/off;
  - assembly hook keeps tool visible after downstream filter;
  - env/config precedence.
  - single and concurrent generation preserve one model-visible tool-call set
    while all generated images render from assistant append events.
  - multiple `referenceImageIds` produce ordered repeated `image[]` parts with
    verified bytes and no caller-supplied multipart `Content-Type`;
  - edit responses parse through both SSE (`image_edit.completed`) and plain
    JSON paths, then use the existing save/render behavior;
  - empty, duplicate, over-limit, and unavailable reference ids fail before
    fetch; Skill and system trigger text name `referenceImageIds` and require an
    upload when no reference exists.

## 7. Wrong vs Correct

#### Wrong
Sending generated image bytes directly as a base64 data-URL text block — the
text model sees garbage and the UI cannot render a durable attachment, and the
admission gate rejects any image block when the model reports text-only input.

#### Correct
`attachments.saveImage({ data, mediaType })` → return an `image` content block
with the durable ref; wrap `session.deriveMessages` to rewrite image blocks to
text markers for text-model requests; wrap `llm.resolveModelInfo` to add
`image` input (admission bypass) while enabled. This is the vision-bridge
pattern and keeps the text-only DeepSeek model safe.

For image-to-image, accepting a path, URL, base64 string, or caller-invented
attachment metadata is wrong: it bypasses session ownership and DSH validation.
Resolve only an attachment id found in the current session event history, call
`attachments.readImage(ref, signal)`, and append the verified bytes to native
`FormData` as `image[]`.

## Design Decisions

- **Streaming-first, JSON fallback**: mirrors GPT2Image's proven request shape
  against xiaoyaoapi while tolerating providers that answer plain JSON.
- **Media-type sniffing over trust**: `saveImage` validates against decoded
  bytes, so sniff magic bytes (default PNG) instead of trusting the API.
- **One tool, optional references**: `generate_image` uses
  `referenceImageIds` to select `/images/edits`; a second edit-only tool would
  duplicate prompt/size/quality/count, response parsing, persistence, and UI
  behavior.
- **Session history is the ownership boundary**: resolve refs from immutable
  session events on each edit call. This naturally includes uploaded and
  generated images without a second cache or persistence layer.
