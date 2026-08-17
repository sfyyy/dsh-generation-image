# DSH image generation plugin (dsh-generation-image)

## Goal

Give a DeepSeek Harness (DSH) session the ability to **generate images on demand**
by calling a user-configured, OpenAI-compatible image-generation API
(`POST /images/generations`, e.g. `https://api.xiaoyaoapi.cc/v1` with model
`gpt-image-2`, the same endpoint the existing GPT2Image app uses).

The agent gets a `generate_image` tool. When it calls it with a prompt, the
plugin:

1. Calls the configured image URL + API key,
2. Receives the generated image bytes (`b64_json`),
3. Durable-commits them through the DSH attachment service,
4. Returns the image into the session (shown in the Web UI / session log),
5. Keeps the **text-only DeepSeek model** safe: image blocks never reach the
   text-model request (marker rewrite + admission bypass), mirroring the
   existing `dsh-vision-bridge` plugin.

## Context / References

- Reference plugin to mirror: `/home/sfyyy/Documents/mine_project/2026-08/dsh-vision-bridge`
  (host `lib/index.js`, browser settings `lib/client.js`, `cordis.patch.yml`,
  package layout, node `--test` suite).
- Image API client to mirror: `/home/sfyyy/Documents/mine_project/2026-07/GPT2Image`
  `src/lib/api.ts` (OpenAI Images API, `stream: true`, `partial_images: 1`,
  SSE parsing of `image_generation.completed` events carrying `b64_json`).
- Endpoint facts (from GPT2Image `src/lib/store.ts`): fixed base URL
  `https://api.xiaoyaoapi.cc/v1`, default image model `gpt-image-2`, sizes
  `1024x1024` etc., qualities `auto | low | medium | high`.

## Requirements

### R1 — Package & wiring
- Package name `@dsh-extension/dsh-generation-image`, MIT, plain-ESM plugin
  (no compile step), structured exactly like `dsh-vision-bridge`:
  - `package.json` (peerDependencies + `dsh.bundle` block),
  - `cordis.patch.yml` (loader insert entry),
  - `lib/index.js` (host side), `lib/client.js` (Web settings form),
  - `test/index.test.js` (node --test), README.md + README.zh-CN.md, LICENSE.

### R2 — Configuration
- Settings namespace `generation-image`, surfaced in the built-in DSH
  Settings page (and via `~/.dsh/generation-image.json`).
- Fields: `enabled` (default true), `baseUrl` (image API root, e.g.
  `https://api.xiaoyaoapi.cc/v1`), `apiKey` and/or `apiKeyEnv`, `model`
  (default `gpt-image-2`), `size` (default `1024x1024`), `quality`
  (default `auto`).
- Precedence (highest wins): Settings page → env vars → config file, same as
  vision-bridge. Env prefix `DSH_GENERATION_IMAGE_`.
- Direct `apiKey` is synced to the DSH credential store
  (`DSH_GENERATION_IMAGE_API_KEY`) and referenced as an env-var name, same as
  vision-bridge.

### R3 — `generate_image` tool
- Arguments: `prompt` (required, string), `size` (optional string),
  `quality` (optional string), `count` (optional integer 1–4, default 1).
- Behavior:
  - Rejects when disabled or when baseUrl/apiKey/model are not configured.
  - POSTs to `{baseUrl}/images/generations` with OpenAI-compatible body
    (`response_format: "b64_json"`, `n: count`, `size`, `quality`,
    `stream: true`, `partial_images: 1`).
  - Parses both the SSE stream (`image_generation.completed` /
    `image_generation.partial_image` payloads) and a plain JSON response
    (`data[].b64_json`).
  - Sniffs the real media type from magic bytes, durable-commits each image via
    `attachments.saveImage`, and returns a canonical value whose `output.render`
    produces a text envelope + one `image` content block per generated image.
  - Nested (`run_code`) dispatches defer the image back into context via
    `exec.deferContext`, like the built-in `read_image` tool.
- Tool stays visible after downstream tool-surface filters
  (`system-prompt/assemble` hook, `prepend: true`), and is unregistered live
  when `enabled: false`.

### R4 — Text-model safety
- `session.deriveMessages` is wrapped so image blocks in any message
  (including nested `tool-result`) are rewritten to informative text markers;
  the session log / UI keep the real image.
- `llm.resolveModelInfo` admission bypass (adds `image` to `inputModalities`)
  while enabled, restored on disable/dispose — same pattern as vision-bridge.

### R5 — Web settings form
- `lib/client.js` registers a "Generation Image" section in the Settings page
  reading/writing the same-origin route `/_dsh/generation-image/settings`
  (GET returns effective config, POST persists), mirroring vision-bridge.

### R6 — Tests & docs
- `npm test` (node --test) passes; suite covers: tool registration gating,
  image-API call + SSE/JSON parsing, canonical value + render output,
  marker rewrite (session log untouched), admission bypass on/off,
  assembly tool visibility, disabled behavior.
- README documents install (via profile `link:` like vision-bridge / `dsh plugin
  --profile web add`), configuration, the tool contract, and verification.

## Acceptance Criteria

- [ ] `npm test` passes with the suite in R6.
- [ ] Plugin registers into a DSH web profile and the Settings page shows the
      "Generation Image" section (fields: enabled / baseUrl / apiKey / model /
      size / quality).
- [ ] With baseUrl + apiKey pointing at a real image endpoint, calling
      `generate_image` returns a durable image attachment; the image renders in
      the session UI, and no text-model request ever carries an image block.
- [ ] `enabled: false` removes the tool, disables rewriting and the admission
      bypass; re-enabling restores them.
- [ ] Config can be supplied via Settings page, env vars, or
      `~/.dsh/generation-image.json` (file wins).

## Out of scope (future)
- Image **editing** (`/images/edits` with reference images) — GPT2Image supports
  it, but this task only needs generation; the tool schema leaves room to add
  an `images` argument later.
- Prompt optimization through a text model — not needed; the agent can already
  craft the prompt itself.

## Notes
- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Technical design lives in `design.md`; execution plan in `implement.md`.
