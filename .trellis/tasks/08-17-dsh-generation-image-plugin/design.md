# Design — dsh-generation-image

## 1. Boundaries

The plugin is a **DSH bundle plugin** (cordis loader entry), plain ESM, no
compile step — identical to `dsh-vision-bridge`. It has two halves:

- **Host half** (`lib/index.js`): config resolution, the `generate_image` tool,
  the image-API HTTP client, session marker rewrite, admission bypass,
  system-prompt/assemble hook, and the same-origin Settings route.
- **Browser half** (`lib/client.js`): a "Generation Image" section in the DSH
  Settings page that reads/writes the host route.

## 2. Data flow

```
agent calls generate_image(prompt, size?, quality?, count?)
   │
   ▼  execute()
POST {baseUrl}/images/generations
   body: { model, prompt, response_format:"b64_json", n:count,
           size, quality(≠auto), stream:true, partial_images:1 }
   headers: Authorization: Bearer <apiKey>
   │
   ▼  response
SSE (image_generation.partial_image / .completed with b64_json)
   or plain JSON (data[].b64_json)
   │
   ▼  bytes → sniffMediaType() → attachments.saveImage()
canonical value { prompt, size, quality, images: [ImageAttachmentRef+] }
   │
   ▼  output.render()
[ {type:"text", text: envelope}, {type:"image", attachment: ref} ×N ]
   │
   ▼  session log / UI keep the image blocks
deriveMessages() → image blocks replaced by text markers (text model never
sees image blocks); llm.resolveModelInfo admission bypass lets the messages
enter the agent.
```

## 3. Config resolution

Mirror vision-bridge exactly:

- Schema (schemastery `z.object`): `enabled` (bool, true), `baseUrl`
  (string, ''), `apiKey` (string, ''), `apiKeyEnv` (string, ''),
  `model` (string, `gpt-image-2`), `size` (string, `1024x1024`),
  `quality` (string, `auto`).
- `resolveConfig(ctx, input)`: start from `ctx.settings.get(namespace)`
  (schema defaults + user layer), apply env overrides
  (`DSH_GENERATION_IMAGE_<UPPER_SNAKE>`; `enabled` parses `false`/`0`),
  then spread `readConfigFile()` (config file wins — same as vision-bridge).
- Config file: `$DSH_GENERATION_IMAGE_CONFIG` else `~/.dsh/generation-image.json`,
  re-read on every call (live edits).
- API key: if `apiKey` is set, sync to credential store
  (`ctx.credentials.set('DSH_GENERATION_IMAGE_API_KEY', apiKey)`) and use
  `apiKeyEnv = 'DSH_GENERATION_IMAGE_API_KEY'` for the HTTP call. If `apiKeyEnv`
  is set directly, read `process.env[apiKeyEnv]`.

## 4. Image API client (`lib/index.js`, exported for tests)

- `resolveBaseUrl(baseUrl)`: trim trailing `/`, normalize
  `.../chat/completions` (not applicable here but harmless), ensure `.../v1`
  suffix — same normalization as vision-bridge so `https://api.xiaoyaoapi.cc`
  works too.
- `generateImagesFromApi({ baseUrl, apiKey, model, size, quality, count }, { fetch, signal })`:
  - Build URL `${base}/images/generations`.
  - POST JSON body; `Authorization: Bearer ${key}`.
  - If `!response.ok` → read error body (`error.message` or text) and throw a
    descriptive error (401/403/404/429/5xx mapped like GPT2Image).
  - If `Content-Type` includes `text/event-stream` → `parseSseImages(text)`
    (collect `b64_json` from `data:` lines: event types
    `image_generation.completed`, `image_generation.partial_image`,
    `image_edit.*`, or a bare record with `b64_json`; ignore `[DONE]`);
    return the **last completed** image(s) b64 list.
  - Else → parse JSON; collect `data[].b64_json` (skip items with only `url`).
  - Decode base64 → `Uint8Array` per image; return `{ images: [{ data, mediaType }] }`
    where `mediaType` comes from `sniffMediaType(bytes)` (default `image/png`
    because gpt-image returns PNG; PNG magic bytes are authoritative when present).
- `sniffMediaType(bytes)`: PNG / JPEG / WebP / GIF magic-byte detection
  (copied from vision-bridge).

## 5. `generate_image` tool

- Schema: `prompt` (string, required), `size` (string, optional),
  `quality` (string, optional, enum `auto|low|medium|high`), `count`
  (integer 1–4, default 1).
- `execute(args, exec)`:
  1. `cfg = resolveConfig(ctx, config)`; if `enabled === false` → throw
     "disabled". Resolve effective `baseUrl`, `apiKey` (env), `model`, `size`,
     `quality`, `count`.
  2. Validate prompt non-empty; validate size against the known set (or pass
     through as the API allows custom sizes).
  3. `generateImagesFromApi(...)` (with `exec.signal`).
  4. For each image: `attachments.saveImage({ data, mediaType, name: 'generated-<n>.png' })`.
  5. If `exec.parent !== undefined`: `exec.deferContext(createUserMessage({...}))`
     with the rendered content, `source: { kind: 'plugin', plugin: 'generation-image' }`.
  6. Return canonical value `{ prompt, size, quality, count, images: [{ attachmentId, mediaType, bytes, width, height, name }] }`.
- `output.schema`: object matching the canonical value (JSON schema, like
  read_image's).
- `output.render(_args, value)`: `[{ type:'text', text: envelope }, ...value.images.map(ref => ({ type:'image', attachment: ref }))]`
  where envelope is a small markdown-ish summary (prompt, size, image count).
- `isConcurrencySafe: () => true`.
- `presentCall(args)`: `{ card: 'generic', title: 'Generate image', kind: 'other', ... }` (best-effort, non-fatal if the presentation helper differs).

## 6. Text-model safety (mirror vision-bridge)

- `rewriteImagesDeep(content, replace)` / `rewriteImageBlocksToMarkers(message)`
  / `contentHasImage(content)` — copied verbatim from vision-bridge.
- `imageMarker(block)`: text like
  `[图片「<name>」已生成，附件 id「<id>」]` (generation flavor).
- `session.deriveMessages` wrapper installed per-session from `agent/pre-step`,
  idempotent per session, disabled live when `enabled === false`.
- `llm.resolveModelInfo` admission bypass wrapped under a `Symbol.for` key
  with owner refcounting — exactly vision-bridge's `installAdmissionBypass`.

## 7. Tool visibility (mirror vision-bridge)

- `ctx.on('system-prompt/assemble', handler, { prepend: true })`: after the
  downstream filter, re-add the registered `generate_image` schema if it was
  dropped while still registered and enabled; remove it when disabled.
- Tool registered/unregistered dynamically via `tools.register` disposer,
  driven by `syncToolRegistration(cfg)` (enabled gate), also called from the
  Settings route POST.

## 8. Settings route + client

- Route `/_dsh/generation-image/settings`: GET → `{ ok, value: { stored,
  effective, services } }`; POST `{ value }` → persist config file, re-sync
  tool registration, apply live. Same-origin POST check, 64KB body cap,
  `responseJson` helper — copied from vision-bridge.
- `lib/client.js`: ModuleLoader format form (enabled/baseUrl/apiKey/model/size/
  quality) hitting the route, styled with the same primitives as vision-bridge.

## 9. Package metadata

- `package.json`: `@dsh-extension/dsh-generation-image`, peerDependencies list
  copied from vision-bridge, `dsh.bundle.patch = ./cordis.patch.yml`,
  `dsh.client.inject` = the same client packages, `dsh.client.platform = "web"`.
- `cordis.patch.yml`: `- insert: - id: generation-image name: '@dsh-extension/dsh-generation-image'`.
- `inject = ['settings', 'credentials', 'attachments', 'llm', 'tools', 'systemPrompt']`.

## 10. Testability

- `lib/index.js` exports pure helpers (`resolveConfig`, `resolveBaseUrl`,
  `sniffMediaType`, `generateImagesFromApi`, `rewriteImageBlocksToMarkers`,
  `contentHasImage`, `parseSseImages`, `SETTINGS_ROUTE`, `apply`, `inject`).
- `generateImagesFromApi` accepts an injected `fetch` so tests can return
  canned SSE/JSON without network.
- Test harness: fake ctx mirroring vision-bridge's `createFakeCtx`, with a
  stubbed `attachments.saveImage` returning realistic refs and a recorded
  `fetch` via the injected option.

## 11. Tradeoffs / decisions

- **Streaming first, JSON fallback**: mirrors GPT2Image's proven request shape
  against xiaoyaoapi while tolerating providers that answer plain JSON.
- **Media-type sniffing over trust**: `saveImage` validates against decoded
  bytes, so we sniff magic bytes (default PNG) instead of trusting the API.
- **No image editing** in v1 (out of scope per prd.md); schema leaves room.
- **Admission bypass kept**: even though generated images enter via tool
  results (not the upload inbox), the bypass + marker pair is the
  vision-bridge-proven combination and also covers any future image sources
  in the same session.
