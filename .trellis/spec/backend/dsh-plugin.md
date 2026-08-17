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
- Image API: `generateImagesFromApi(cfg, opts)` → `[{ data: Uint8Array, mediaType }]`.
- Settings route: `GET|POST /_dsh/generation-image/settings`.

## 3. Contracts

### Config (settings namespace `generation-image`, file `~/.dsh/generation-image.json`)

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `enabled` | bool | `true` | master switch |
| `baseUrl` | string | `''` | OpenAI-compatible API root; normalized to `.../v1` |
| `apiKey` | string | `''` | direct key; synced to credential `DSH_GENERATION_IMAGE_API_KEY` |
| `apiKeyEnv` | string | `''` | env-var name holding the key (mutually exclusive with apiKey) |
| `model` | string | `gpt-image-2` | image model id |
| `size` | string | `1024x1024` | default size |
| `quality` | string | `auto` | `auto\|low\|medium\|high` |

Precedence (highest wins): Settings page → env vars → config file.
Env prefix: `DSH_GENERATION_IMAGE_` + `UPPER_SNAKE(key)`.

### Tool `generate_image`

- args: `prompt` (required string), `size` (optional), `quality` (optional enum),
  `count` (optional int 1–4, default 1).
- Request body to `${baseUrl}/images/generations`:
  `{ model, prompt, response_format: 'b64_json', n, size, quality(≠auto), stream: true, partial_images: 1 }`,
  header `Authorization: Bearer <key>`.
- Response: SSE (`image_generation.completed` / `partial_image` events carrying
  `b64_json`) or plain JSON (`data[].b64_json`).
- Output value: `{ prompt, size, quality, count, images: [{ attachmentId, mediaType, bytes, width, height, name }] }`.
- `output.render` → `[ {type:'text',...}, ...images.map(ref => ({ type:'image', attachment: ref })) ]`.
- Nested dispatch (`exec.parent !== undefined`) must
  `exec.deferContext(createUserMessage({ content, source: { kind:'plugin', plugin:'generation-image' } }))`.

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

## 5. Good / Base / Bad Cases

- Good: configured endpoint returns SSE completed event → image saved as
  attachment, text marker for the text model, image block in session log/UI.
- Base: endpoint returns plain JSON `{ data: [{ b64_json }] }` → same path.
- Bad: aggregator returns 503 with "No available channel for model X" → the
  plugin surfaces the provider message as a tool error (upstream issue, not a
  plugin bug).

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

## Design Decisions

- **Streaming-first, JSON fallback**: mirrors GPT2Image's proven request shape
  against xiaoyaoapi while tolerating providers that answer plain JSON.
- **Media-type sniffing over trust**: `saveImage` validates against decoded
  bytes, so sniff magic bytes (default PNG) instead of trusting the API.
- **Image editing deferred**: `/images/edits` is future work; the schema leaves
  room for an `images` argument.
