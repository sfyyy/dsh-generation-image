/**
 * @dsh-extension/dsh-generation-image
 *
 * On-demand image generation for DeepSeek Harness (DSH) sessions.
 *
 * The agent gets a single `generate_image` tool. Calling it with a prompt
 * POSTs to the user-configured OpenAI-compatible image endpoint
 * (`{baseUrl}/images/generations`), receives the generated image bytes either
 * inline (`b64_json`) or as a remote URL to download (`url`, SSE or plain
 * JSON), and durably commits them through the DSH
 * attachment service, and returns the image into the session — the Web UI and
 * session log keep the real image, while the text-only DeepSeek model never
 * receives an image block (they are rewritten to informative text markers, the
 * same mechanism as `dsh-vision-bridge`).
 *
 * Configuration (all optional; defaults apply, env vars override):
 *   baseUrl   — image API root, e.g. https://api.xiaoyaoapi.cc/v1
 *   apiKey    — static API key
 *   apiKeyEnv — env var name holding the key (recommended over apiKey)
 *   model     — image model id (default gpt-image-2)
 *   size      — image size (default 1024x1024)
 *   quality   — image quality (default auto; auto|low|medium|high)
 *   enabled   — master switch (default true)
 *
 * Env-var overrides use the prefix DSH_GENERATION_IMAGE_ + UPPERCASE_FIELD:
 *   DSH_GENERATION_IMAGE_BASE_URL, DSH_GENERATION_IMAGE_API_KEY,
 *   DSH_GENERATION_IMAGE_API_KEY_ENV, DSH_GENERATION_IMAGE_MODEL,
 *   DSH_GENERATION_IMAGE_SIZE, DSH_GENERATION_IMAGE_QUALITY,
 *   DSH_GENERATION_IMAGE_ENABLED, ...
 *
 * No build step needed: this is plain ESM loaded straight from lib/index.js.
 * @module @dsh-extension/dsh-generation-image
 */
import { Buffer } from 'node:buffer'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { createAssistantMessage, createSystemMessage } from '@deepseek-ai/dsh-llm'

export const name = '@dsh-extension/dsh-generation-image'
export const inject = ['settings', 'credentials', 'attachments', 'llm', 'tools', 'systemPrompt']

/** Shared resolveModelInfo wrapper state (hot-reload idempotency). */
const ADMISSION_FLAG = Symbol.for('dsh-generation-image.resolveModelInfo.patched')

/** Whether the llm.resolveModelInfo admission bypass is currently installed. */
let admissionActive = false

/** Same-origin route the browser Settings form reads/writes. */
export const SETTINGS_ROUTE = '/_dsh/generation-image/settings'

const ENV_PREFIX = 'DSH_GENERATION_IMAGE_'
const CREDENTIAL = 'DSH_GENERATION_IMAGE_API_KEY'
const MAX_IMAGES_PER_CALL = 4
const DEFAULT_MODEL = 'gpt-image-2'
const DEFAULT_QUALITY = 'auto'
/** Plugin tag stamped on the surface-shadow system message (see createGenerateImageTool). */
const DISPLAY_PLUGIN = 'generation-image'

/**
 * System-prompt section that makes the model auto-trigger `generate_image`
 * (instead of requiring the user to name the tool or falling back to local
 * drawing). Registered as a `systemPrompt.section`; its text returns '' while
 * the plugin is disabled so the guidance disappears with the tool.
 */
const TRIGGER_SECTION_ORDER = 90
const TRIGGER_SECTION_TEXT = [
  '[generate_image trigger] You have a `generate_image` tool that generates images on demand through the configured image API.',
  'Call it AUTOMATICALLY — do NOT wait for the user to name the tool — whenever the user asks to generate/create/draw/make/render an image (生成/制作/画一张图片/图像/照片/插画/头像/配图/壁纸/海报), or asks to edit/restyle/combine attached or previously generated images (修改这张图/换风格/组合参考图/生成变体).',
  'For image-to-image requests, pass the relevant attachment ids from the conversation markers as `referenceImageIds`. If no reference image exists, ask the user to upload one; never pretend to edit an image by using text-to-image alone.',
  'Write a detailed English prompt; optionally set size (e.g. 1024x1024), quality (auto|low|medium|high), and count (1-4). When the user asks for multiple images/versions, set count to the requested number (e.g. count=4) so all images are generated and displayed stacked in one assistant message. Do NOT draw locally with bash/PIL/ImageMagick — use generate_image. Do NOT call it for pure text/code/explanation requests.',
].join('\n')

/** Minimal YAML-frontmatter splitter for the shipped SKILL.md. */
function parseSkillFrontmatter(text) {
  const meta = {}
  let body = String(text || '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body)
  if (match) {
    body = body.slice(match[0].length)
    for (const line of match[1].split(/\r?\n/)) {
      const idx = line.indexOf(':')
      if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
  }
  return { meta, body: body.trim() }
}

/**
 * The `generate-image` skill shipped with this plugin (skills/generate-image/
 * SKILL.md). Loaded lazily at module scope; null when the file is missing so
 * runtime registration can be skipped gracefully.
 */
const SHIPPED_SKILL = (() => {
  try {
    const raw = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'generate-image', 'SKILL.md'),
      'utf8',
    )
    const { meta, body } = parseSkillFrontmatter(raw)
    if (!body) return null
    return {
      name: meta.name || 'generate-image',
      description: meta.description || 'Generate an image on demand with the generate_image tool.',
      ...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}),
      // dsh-skill's loader validates a loaded definition with both `source` and
      // `content` as required strings. `skills.register` defaults `provider`
      // (to "runtime") and `invocation`, but never `source` — without this the
      // skill tool crashed with:
      //   loaded skill "generate-image" source must be a string
      source: 'plugin',
      content: body,
    }
  } catch {
    return null
  }
})()

/** Settings namespace surfaced in the built-in DSH Settings page. */
export const SETTINGS_NAMESPACE = 'generation-image'

/** schemastery schema driving the Settings form (defaults apply). */
const Config = z.object({
  enabled: z.boolean().default(true),
  mode: z.string().default('native'),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  apiKeyEnv: z.string().default(''),
  model: z.string().default(DEFAULT_MODEL),
  size: z.string().default(''),
  quality: z.string().default(DEFAULT_QUALITY),
})

/** Runtime defaults mirroring the schema (used when settings are unavailable). */
const DEFAULTS = {
  enabled: true,
  mode: 'native',
  baseUrl: '',
  apiKey: '',
  apiKeyEnv: '',
  model: DEFAULT_MODEL,
  size: '',
  quality: DEFAULT_QUALITY,
}

/** camelCase → SCREAMING_SNAKE_CASE for env lookups (baseUrl → BASE_URL). */
function envName(key) {
  return ENV_PREFIX + key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
}

/** Config file path: $DSH_GENERATION_IMAGE_CONFIG, else ~/.dsh/generation-image.json. */
function configFilePath() {
  return process.env.DSH_GENERATION_IMAGE_CONFIG || join(homedir(), '.dsh', 'generation-image.json')
}

/**
 * Re-read an optional JSON config file on every call so edits take effect live
 * without a restart. Path: $DSH_GENERATION_IMAGE_CONFIG, else
 * ~/.dsh/generation-image.json. File keys override env and stored config
 * (highest precedence).
 */
function readConfigFile() {
  try {
    const raw = readFileSync(configFilePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    /* missing or invalid file — fall through to env/defaults */
  }
  return {}
}

/** Persist config to the config file (Settings form writes here). */
function writeConfigFile(value) {
  const path = configFilePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
  return value
}

/**
 * Resolve the effective config. Precedence (highest wins):
 * Settings page (ctx.settings, includes schema defaults) → env vars → config file.
 * Settings are re-read live so edits take effect without a reload.
 */
export function resolveConfig(ctx, input) {
  let cfg = ctx?.settings?.get?.(SETTINGS_NAMESPACE) ?? { ...DEFAULTS, ...(input ?? {}) }
  for (const key of Object.keys(DEFAULTS)) {
    const envNameKey = envName(key)
    if (process.env[envNameKey] !== undefined) {
      const v = process.env[envNameKey]
      cfg = { ...cfg, [key]: key === 'enabled' ? v !== 'false' && v !== '0' : v }
    }
  }
  return { ...cfg, ...readConfigFile() }
}

/**
 * Image-handling mode. `native` (default) rewrites an image block to a text
 * marker only for a route whose model cannot read images itself, so a
 * multimodal model keeps its real vision. `always` is the legacy behaviour:
 * every image becomes a marker regardless of the routed model.
 */
export function resolveMarkerMode(cfg) {
  const raw = String((cfg && cfg.mode) || 'native').trim().toLowerCase()
  if (raw === 'always' || raw === 'native' || raw === 'auto') return raw === 'always' ? 'always' : 'native'
  return 'native'
}

/** Normalize one provider/model pair; undefined unless both are non-empty. */
export function normalizeRoute(provider, model) {
  const p = typeof provider === 'string' ? provider.trim() : ''
  const m = typeof model === 'string' ? model.trim() : ''
  return p && m ? { provider: p, model: m } : undefined
}

/**
 * Whether one route's model declares native image input. Read live from the llm
 * service so an added/removed `input: [text, image]` takes effect on the next
 * request. An unknown route or a failing lookup answers `true` — the non-lossy
 * direction, because the shared LLM runtime still projects images into stable
 * text placeholders for a genuinely text-only model.
 * @param ctx - the plugin context (its `llm` service is injected).
 * @param route - `{ provider, model }`, or undefined when the step is unknown.
 * @returns true when the image must be left for the model to read.
 */
export async function routeHasNativeImage(ctx, route) {
  if (!route) return true
  try {
    const info = await ctx?.llm?.resolveModelInfo?.(route.provider, route.model)
    const modalities = info && info.inputModalities
    if (!Array.isArray(modalities)) return true
    return modalities.includes('image')
  } catch {
    return true
  }
}

/**
 * Whether images must become markers for one route. `mode: 'always'` keeps the
 * legacy unconditional rewrite; otherwise an image-capable route is left alone
 * so the model reads the image itself. The decision itself is synchronous (see
 * the cache in `apply`) because `Session.deriveMessages` is called without
 * `await` by the agent loop.
 * @param cfg - the resolved config.
 * @param hasNativeImage - whether this step's model reads images itself.
 */
export function shouldRewriteImages(cfg, hasNativeImage) {
  if (resolveMarkerMode(cfg) === 'always') return true
  return !hasNativeImage
}

/** Normalize baseUrl for the OpenAI-compatible images endpoint. */
export function resolveBaseUrl(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!b) return ''
  const base = b.replace(/\/chat\/completions$/i, '')
  return /\/v\d+$/i.test(base) ? base : `${base}/v1`
}

/**
 * Normalize common 4K UHD aliases to a concrete 3840-based size.
 * The upstream max edge is 3840px; `4096` exceeds the limit and fails.
 * The bundle patch also raises DSH attachment-local limits so these 4K
 * images are not downscaled to 2048 when saved.
 */
export function normalizeRequestedSize(size) {
  const normalized = String(size || '').trim().replace(/×/g, 'x')
  const s = normalized.toLowerCase()
  if (s === '4k' || s === '4k ultra hd' || s === 'uhd') {
    return '3840x2160'
  }
  return normalized
}

/** Resolve the effective API key from a direct key or an env-var name. */
export function resolveApiKey(cfg) {
  const direct = String(cfg?.apiKey || '').trim()
  if (direct) return direct
  const env = String(cfg?.apiKeyEnv || '').trim()
  if (env) return String(process.env[env] || '').trim()
  return ''
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Detect the image format from magic bytes (image APIs are extension-less). */
export function sniffMediaType(bytes) {
  if (!bytes || bytes.length < 12) return undefined
  const head = (offset, count) => {
    const parts = []
    for (let i = offset; i < offset + count; i++) parts.push(bytes[i].toString(16).padStart(2, '0'))
    return parts.join('')
  }
  if (head(0, 8) === '89504e470d0a1a0a') return 'image/png'
  if (head(0, 3) === 'ffd8ff') return 'image/jpeg'
  const riff = head(0, 4)
  const webp = head(8, 4)
  if (riff === '52494646' && webp === '57454250') return 'image/webp'
  if (riff === '47494638') return 'image/gif' // GIF87a / GIF89a
  return undefined
}

/** Extract a human-readable error message from a provider payload. */
function extractApiError(parsed) {
  if (isRecord(parsed.error)) {
    if (typeof parsed.error.message === 'string' && parsed.error.message) return parsed.error.message
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error
  }
  if (typeof parsed.error === 'string' && parsed.error) return parsed.error
  if (typeof parsed.message === 'string' && parsed.message) return parsed.message
  return null
}

/** Map a thrown fetch error into a plugin-readable message (abort passes through). */
function mapFetchError(err) {
  if (err && err.name === 'AbortError') return err instanceof Error ? err : new Error(String(err))
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('fetch failed') || msg.includes('ERR_')) {
    return new Error(
      `generation-image: connection failed while calling the image API (${msg}); the endpoint may be unreachable, or the long-running request was cut off by a gateway timeout. Retry, or check the baseUrl.`,
    )
  }
  return new Error(`generation-image: network error: ${msg}`)
}

async function readErrorDetail(response) {
  try {
    const text = await response.text()
    if (!text) return response.statusText
    try {
      const data = JSON.parse(text)
      if (isRecord(data) && isRecord(data.error) && typeof data.error.message === 'string') return data.error.message
      if (isRecord(data) && typeof data.message === 'string') return data.message
    } catch {
      /* not JSON — fall through to raw text */
    }
    return text
  } catch {
    return response.statusText
  }
}

/** Map a non-2xx HTTP status into a plugin-readable error. */
async function mapHttpError(response) {
  const status = response.status
  const detail = await readErrorDetail(response)
  switch (status) {
    case 401:
      return new Error('generation-image: authentication failed — check the API key.')
    case 403:
      return new Error('generation-image: access denied — the API key may lack image-generation permission.')
    case 404:
      return new Error('generation-image: image endpoint not found — verify baseUrl (e.g. https://api.xiaoyaoapi.cc/v1).')
    case 429:
      return new Error('generation-image: rate limit exceeded — wait a moment and retry.')
    default:
      if (status >= 500) {
        return new Error(`generation-image: image API server error (${status}) — temporary upstream issue: ${detail}`)
      }
      return new Error(`generation-image: image API error ${status}: ${detail}`)
  }
}

/**
 * Normalize a single image payload into a typed item.
 *
 * Providers may return images either as inline base64 (`b64_json`) or as a
 * remote URL (`url`). Both are normalized here so downstream code handles
 * them uniformly:
 *   { kind: 'b64', data }  — inline base64 payload
 *   { kind: 'url', url }   — remote URL to download
 */
export function imageItem(value) {
  if (typeof value === 'string' && value.trim()) {
    const url = value.trim()
    if (/^https?:\/\//i.test(url)) return { kind: 'url', url }
    return null
  }
  if (!isRecord(value)) return null
  if (typeof value.b64_json === 'string' && value.b64_json) return { kind: 'b64', data: value.b64_json }
  if (typeof value.url === 'string' && value.url.trim()) return { kind: 'url', url: value.url.trim() }
  return null
}

/**
 * Parse an SSE image-generation stream into typed image items.
 * Accepts `image_generation.completed` / `image_edit.completed` events (and
 * falls back to the last `partial_image` when no completed event arrives),
 * where each event may carry either `b64_json` or `url`.
 * Provider error events throw with their message.
 */
export function parseSseImageItems(text) {
  const completed = []
  let partial = null
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let parsed
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    const type = String(parsed.type || '')
    if (type === 'error' || type.endsWith('.error') || (parsed.error !== undefined && parsed.error !== null)) {
      throw new Error(`generation-image: image generation failed: ${extractApiError(parsed) || 'the provider returned an error.'}`)
    }
    const item = imageItem(parsed)
    if (!item) continue
    if (type.endsWith('.completed')) completed.push(item)
    else if (type.endsWith('.partial_image') || type.endsWith('.partial')) partial = item
    else completed.push(item) // untyped record: treat as a real image
  }
  if (completed.length > 0) return completed
  return partial ? [partial] : []
}

/** Backward-compatible b64-only view of an SSE stream (URL events skipped). */
export function parseSseImages(text) {
  return parseSseImageItems(text).filter((item) => item.kind === 'b64').map((item) => item.data)
}

/**
 * Collect typed image items from a plain (non-streaming) JSON response body.
 * Reads `data[].b64_json` / `data[].url` and tolerates bare URL strings.
 */
export function extractImageItemsFromJson(data) {
  if (!isRecord(data) || !Array.isArray(data.data)) return []
  const out = []
  for (const item of data.data) {
    const normalized = imageItem(item)
    if (normalized) out.push(normalized)
  }
  return out
}

/** Backward-compatible b64-only view of a JSON body (URL items skipped). */
export function extractB64FromJson(data) {
  return extractImageItemsFromJson(data).filter((item) => item.kind === 'b64').map((item) => item.data)
}

/** Decode base64 image payloads into bytes + sniffed media type (deduped). */
export function decodeImages(b64List) {
  const out = []
  const seen = new Set()
  for (const b64 of b64List) {
    if (!b64 || seen.has(b64)) continue
    seen.add(b64)
    let bytes
    try {
      bytes = new Uint8Array(Buffer.from(b64, 'base64'))
    } catch {
      continue
    }
    if (bytes.length === 0) continue
    out.push({ data: bytes, mediaType: sniffMediaType(bytes) || 'image/png' })
  }
  return out
}

/**
 * Download a generated image URL into bytes + media type.
 * The media type comes from magic-byte sniffing, falling back to the
 * response's Content-Type header, then `image/png`.
 */
export async function downloadImageUrl(url, opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch
  let response
  try {
    response = await fetchImpl(url, { ...(opts.signal ? { signal: opts.signal } : {}) })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`generation-image: failed to download the generated image from ${url}: ${reason}`)
  }
  if (!response.ok) {
    throw new Error(`generation-image: failed to download the generated image from ${url} (HTTP ${response.status})`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length === 0) {
    throw new Error(`generation-image: the generated image at ${url} was empty`)
  }
  const headerType = typeof response.headers?.get === 'function'
    ? String(response.headers.get('content-type') || '').split(';')[0].trim()
    : ''
  return { data: bytes, mediaType: sniffMediaType(bytes) || headerType || 'image/png' }
}

/**
 * Resolve typed image items into `{ data: Uint8Array, mediaType }`:
 * base64 payloads are decoded locally, URLs are downloaded via fetch
 * (deduped by payload/URL).
 */
export async function resolveImageItems(items, opts = {}) {
  const out = []
  const seen = new Set()
  for (const item of items) {
    if (!item) continue
    if (item.kind === 'b64') {
      if (seen.has(item.data)) continue
      seen.add(item.data)
      let bytes
      try {
        bytes = new Uint8Array(Buffer.from(item.data, 'base64'))
      } catch {
        continue
      }
      if (bytes.length === 0) continue
      out.push({ data: bytes, mediaType: sniffMediaType(bytes) || 'image/png' })
    } else if (item.kind === 'url') {
      if (seen.has(item.url)) continue
      seen.add(item.url)
      const { data, mediaType } = await downloadImageUrl(item.url, opts)
      out.push({ data, mediaType })
    }
  }
  return out
}

/**
 * Call the OpenAI-compatible `/images/generations` endpoint.
 *
 * `cfg` carries the resolved request fields; `opts.fetch` is injectable for
 * tests (defaults to globalThis.fetch). Returns an array of
 * `{ data: Uint8Array, mediaType: string }` — images arrive either inline as
 * `b64_json` (decoded locally) or as `url` (downloaded via fetch).
 */
export async function generateImagesFromApi(cfg, opts = {}) {
  const base = resolveBaseUrl(cfg.baseUrl)
  if (!base) throw new Error('generation-image: no baseUrl configured.')
  const apiKey = resolveApiKey(cfg)
  if (!apiKey) throw new Error('generation-image: no apiKey or apiKeyEnv configured.')
  const model = String(cfg.model || '').trim()
  if (!model) throw new Error('generation-image: no image model configured.')

  const prompt = String(cfg.prompt || '').trim()
  if (!prompt) throw new Error('generation-image: prompt is required.')

  const fetchImpl = opts.fetch || globalThis.fetch
  const referenceImages = Array.isArray(cfg.referenceImages) ? cfg.referenceImages : []
  const url = `${base}/images/${referenceImages.length > 0 ? 'edits' : 'generations'}`

  // Size and quality are passed through from the model/config with no
  // restriction; 'auto' (or an empty value) means "let the API decide" and the
  // field is omitted from the request.
  const rawSize = String(cfg.size || '').trim()
  const normalizedSize = normalizeRequestedSize(rawSize)
  const rawQuality = String(cfg.quality || '').trim()
  const size = normalizedSize !== '' && normalizedSize.toLowerCase() !== 'auto' ? normalizedSize : undefined
  const quality = rawQuality !== '' && rawQuality.toLowerCase() !== 'auto' ? rawQuality : undefined

  const count = Number.isInteger(cfg.count) && cfg.count >= 1 ? cfg.count : 1

  // Upstream currently requires n=1. For count > 1 we issue count sequential
  // n=1 requests and combine the results; the client displays them stacked.
  const requestOne = async () => {
    const headers = { Authorization: `Bearer ${apiKey}` }
    let body
    if (referenceImages.length > 0) {
      body = new FormData()
      body.append('model', model)
      body.append('prompt', prompt)
      body.append('response_format', 'b64_json')
      body.append('n', '1')
      if (size) body.append('size', size)
      if (quality) body.append('quality', quality)
      body.append('stream', 'true')
      body.append('partial_images', '1')
      for (let i = 0; i < referenceImages.length; i++) {
        const image = referenceImages[i]
        const mediaType = image.ref.mediaType
        const extension = mediaType.split('/')[1] || 'png'
        body.append('image[]', new Blob([image.data], { type: mediaType }), image.ref.name || `reference-${i + 1}.${extension}`)
      }
    } else {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify({
        model,
        prompt,
        response_format: 'b64_json',
        n: 1,
        ...(size ? { size } : {}),
        ...(quality ? { quality } : {}),
        stream: true,
        partial_images: 1,
      })
    }

    let response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
    } catch (err) {
      throw mapFetchError(err)
    }

    if (!response.ok) throw await mapHttpError(response)

    const contentType = String(response.headers?.get?.('content-type') || '')
    if (contentType.includes('text/event-stream')) {
      const text = await response.text()
      const items = parseSseImageItems(text)
      if (items.length === 0) {
        throw new Error('generation-image: the image API stream ended without a completed image.')
      }
      return resolveImageItems(items, { fetch: fetchImpl, signal: opts.signal })
    }

    let data
    try {
      data = await response.json()
    } catch (err) {
      throw new Error(`generation-image: the image API returned an unreadable response: ${err instanceof Error ? err.message : String(err)}`)
    }
    const items = extractImageItemsFromJson(data)
    if (items.length === 0) {
      throw new Error('generation-image: the image API returned no image data (no b64_json or url was provided, or the content was filtered).')
    }
    return resolveImageItems(items, { fetch: fetchImpl, signal: opts.signal })
  }

  const out = []
  for (let i = 0; i < count; i++) {
    const resolved = await requestOne()
    out.push(...resolved)
  }
  return out
}

/** True when a content array carries an image block, descending into tool-result. */
export function contentHasImage(content) {
  return content?.some?.(
    (block) => block?.type === 'image' || (block?.type === 'tool-result' && contentHasImage(block.content)),
  ) === true
}

/**
 * Recursively rewrite image blocks in a content tree, descending into nested
 * `tool-result` content exactly like the harness's own image walk. Returns the
 * rewritten array plus a changed flag; an untouched input array is returned
 * as-is so callers can keep object identity for unchanged messages.
 */
export function rewriteImagesDeep(content, replace) {
  if (!Array.isArray(content)) return { content, changed: false }
  let changed = false
  const next = []
  for (const block of content) {
    if (block && block.type === 'image') {
      changed = true
      const out = replace(block)
      if (out !== undefined && out !== null) {
        if (Array.isArray(out)) next.push(...out)
        else next.push(out)
      }
      continue
    }
    if (block && Array.isArray(block.content)) {
      const inner = rewriteImagesDeep(block.content, replace)
      if (inner.changed) {
        changed = true
        next.push({ ...block, content: inner.content })
        continue
      }
    }
    next.push(block)
  }
  return { content: changed ? next : content, changed }
}

/** Durable attachment-id prefix used by the attachment store. */
const SHA256_PREFIX = 'sha256:'

/**
 * This session's event log, as the current harness exposes it:
 * `snapshotEvents()` returns the whole log, fork-inherited prefix included.
 * @param session - the agent's session, or anything session-shaped.
 * @returns the event array, or an empty array when no log can be read.
 */
export function sessionEvents(session) {
  if (session === undefined || session === null || typeof session.snapshotEvents !== 'function') return []
  const events = session.snapshotEvents()
  return Array.isArray(events) ? events : []
}

/** Keys one attachment id is addressable by (bare hash and `sha256:` form). */
function imageRefKeys(attachmentId) {
  const id = String(attachmentId)
  const bare = id.startsWith(SHA256_PREFIX) ? id.slice(SHA256_PREFIX.length) : id
  return bare === id ? [id, SHA256_PREFIX + id] : [id, bare]
}

/** Register one attachment under every addressable id (first writer wins). */
function rememberImageRef(refs, attachment) {
  for (const key of imageRefKeys(attachment.attachmentId)) {
    if (!refs.has(key)) refs.set(key, attachment)
  }
}

/**
 * Collect durable image refs from this session's immutable event history.
 *
 * Events carry their content in more than one shape: `user/message` stores it
 * as `data.content`, `assistant/message` and `tool/result` as
 * `data.message.content`, and `agent/inbox/spliced` as `data.inserted[].content`.
 * All of them are walked (with nested tool-result content), so an image the
 * user uploaded, the model read, or a previous generation produced is
 * addressable as a reference either way.
 *
 * @param session - the agent's session.
 * @returns a Map from attachment id (bare and `sha256:` form) to attachment ref.
 */
export function sessionImageRefs(session) {
  const refs = new Map()
  const visit = (node, depth) => {
    if (depth > 6 || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    if (node.type === 'image' && node.attachment && typeof node.attachment.attachmentId === 'string') {
      rememberImageRef(refs, node.attachment)
    }
    for (const key of ['message', 'content', 'inserted', 'messages']) {
      if (node[key] !== undefined) visit(node[key], depth + 1)
    }
  }
  for (const event of sessionEvents(session)) {
    if (event && typeof event === 'object') visit(event.data, 0)
  }
  return refs
}

/** Short, human-readable form of an attachment id for error messages. */
function shortAttachmentId(id) {
  const bare = String(id).replace(/^sha256:/, '')
  return bare.length > 12 ? bare.slice(0, 12) : bare
}

/**
 * The error raised when a `referenceImageIds` entry is not in this session.
 * Lists what IS available, so a caller can correct itself in one retry instead
 * of guessing ids.
 *
 * @param id - the requested id.
 * @param available - the session's reference map.
 * @returns the Error to throw.
 */
export function missingReferenceError(id, available) {
  const ids = [...new Set([...available.keys()].map(shortAttachmentId))]
  const hint = ids.length > 0
    ? ` — available image attachments: ${ids.join(', ')}`
    : ' — this session has no image attachments yet'
  return new Error(`generate_image: reference image attachment ${id} is not available in this session${hint}`)
}

/**
 * Text marker replacing an image block in the model input. This plugin only
 * generates images, so the marker points the model at `generate_image` and at
 * nothing else — no other plugin's tool is advertised from here.
 * @param block - the `image` block being replaced.
 */
export function imageMarker(block) {
  const attachment = block && block.attachment ? block.attachment : {}
  const id = attachment.attachmentId || attachment.id || 'unknown'
  const name = attachment.name || '图片'
  return {
    type: 'text',
    text:
      `[图片「${name}」已在会话中（附件 id「${id}」）。当前模型为纯文本模型，无法直接查看图片；` +
      `如需基于此图生成或修改图片，请调用 generate_image 并传入 referenceImageIds: ["${id}"]。]`,
  }
}

/**
 * Replace every image block in one message (top-level or nested in tool-result)
 * with a marker. Returns the original message unchanged when it has no image;
 * changed messages are rebuilt as deep-frozen structured clones to match the
 * frozen-message contract of `Session.deriveMessages`.
 * @param message - the message whose image blocks are replaced.
 */
export function rewriteImageBlocksToMarkers(message) {
  if (!message || !Array.isArray(message.content)) return message
  const result = rewriteImagesDeep(message.content, imageMarker)
  if (!result.changed) return message
  const clone = structuredClone(message)
  clone.content = result.content
  return deepFreezeLocal(clone)
}

/** Recursively freeze a plain structured-clone tree. */
export function deepFreezeLocal(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreezeLocal(value[key])
    Object.freeze(value)
  }
  return value
}

/**
 * Admission-gate bypass, mirroring dsh-vision-bridge.
 *
 * The host api-proxy rejects ANY prompt whose content contains an image block
 * BEFORE the message reaches the agent whenever the session's current model
 * reports `inputModalities` without "image". We wrap the shared
 * `llm.resolveModelInfo` so the gate admits the message; the marker rewrite
 * then keeps image blocks out of every text-model request.
 */
function installAdmissionBypass(ctx, config) {
  try {
    ctx.effect(() => {
      const llm = ctx.llm
      if (!llm || typeof llm.resolveModelInfo !== 'function') return

      let state = llm[ADMISSION_FLAG]
      if (!state || state.patched !== llm.resolveModelInfo || !(state.owners instanceof Set)) {
        state = { original: llm.resolveModelInfo, owners: new Set(), patched: null }
        state.patched = function (provider, model, signal) {
          const result = state.original.call(this, provider, model, signal)
          const enabled = [...state.owners].some((owner) => owner())
          if (!enabled) return result
          return Promise.resolve(result).then((info) => {
            if (!info || info.inputModalities === undefined) return info
            if (info.inputModalities.includes('image')) return info
            return { ...info, inputModalities: [...info.inputModalities, 'image'] }
          })
        }
        llm.resolveModelInfo = state.patched
        llm[ADMISSION_FLAG] = state
      }

      const owner = () => resolveConfig(ctx, config).enabled !== false
      state.owners.add(owner)
      admissionActive = true
      ctx.logger?.info?.('generation-image: admission bypass active (llm.resolveModelInfo wrapped)')
      return () => {
        state.owners.delete(owner)
        if (state.owners.size > 0) return
        if (llm.resolveModelInfo === state.patched) llm.resolveModelInfo = state.original
        if (llm[ADMISSION_FLAG] === state) delete llm[ADMISSION_FLAG]
        admissionActive = false
        ctx.logger?.info?.('generation-image: admission bypass removed')
      }
    }, 'dsh-generation-image: admission bypass')
  } catch (err) {
    const msg = err instanceof Error ? (err.stack || err.message) : String(err)
    ctx.logger?.warn?.('generation-image: admission bypass unavailable: %s', msg)
  }
}

/** Text envelope describing a completed generation result. */
export function formatGenerationEnvelope(value) {
  const lines = [
    `[图片生成完成] prompt: ${value.prompt}`,
    `size: ${value.size || '-'}  quality: ${value.quality || 'auto'}  count: ${value.count}`,
  ]
  for (const img of value.images) {
    lines.push(`- attachment ${img.attachmentId} (${img.mediaType}, ${img.width}x${img.height}, ${img.bytes} bytes)`)
  }
  return lines.join('\n')
}

/** Build an `ImageAttachmentRef`-shaped canonical image entry from a saved ref. */
function imageEntryFromRef(ref, index) {
  return {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name ? { name: ref.name } : { name: `generated-${index + 1}.png` }),
  }
}

/** Build a message image block from a canonical image entry. */
function imageEntryToBlock(image) {
  return { type: 'image', attachment: image }
}

/**
 * Build the `generate_image` tool definition.
 *
 * `deps`:
 *   resolveConfig() — live effective config
 *   logger — ctx.logger
 */
function createGenerateImageTool(ctx, deps) {
  const { resolveConfig: resolveCfg, logger } = deps
  const fetchImpl = deps.fetch

  const render = (_args, value) => {
    const blocks = [{ type: 'text', text: formatGenerationEnvelope(value) }]
    for (const image of value.images) blocks.push({ type: 'image', attachment: image })
    return blocks
  }

  return {
    name: 'generate_image',
    description:
      'Generate one or more images, or edit reference images, with the configured image API. ' +
      'Provide a `prompt` describing the image you want. Optionally set `size` ' +
      '(e.g. 1024x1024, 1024x1792, 1792x1024), `quality` (auto|low|medium|high), ' +
      '`count` (1-4 images), and `referenceImageIds` with attachment ids from this ' +
      'conversation for image-to-image editing. When the user asks for multiple ' +
      'images/versions, set `count` to the requested number so all images are generated ' +
      'and displayed stacked in one assistant message. The generated images are saved into ' +
      'the session and returned as image blocks. The current text model cannot see the ' +
      'pixels itself, but the images are delivered to the user in the session UI.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'A detailed description of the image to generate',
        },
        size: {
          type: 'string',
          description: 'Image size, unrestricted — pass any size the endpoint accepts ' +
            '(e.g. 1024x1024, 1024x1792, 1792x1024, or up to 3840x2160/3840x3840 for 4K; ' +
            '4096 exceeds the upstream limit), or "auto"/omit to let the API choose',
        },
        quality: {
          type: 'string',
          description: 'Image quality, unrestricted — common values are auto (default), low, medium, high',
        },
        count: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_IMAGES_PER_CALL,
          description: `Number of images to generate (1-${MAX_IMAGES_PER_CALL}, default 1); multiple images are displayed stacked in one assistant message`,
        },
        referenceImageIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered, unique image attachment ids from this conversation. Omit for text-to-image; provide one or more for image-to-image editing.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['prompt', 'size', 'quality', 'count', 'images'],
        properties: {
          prompt: { type: 'string' },
          size: { type: 'string' },
          quality: { type: 'string' },
          count: { type: 'integer' },
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
              properties: {
                attachmentId: { type: 'string' },
                mediaType: {
                  type: 'string',
                  enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
                },
                bytes: { type: 'integer' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                name: { type: 'string' },
              },
            },
          },
        },
      },
      render,
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cfg = resolveCfg()
      if (cfg.enabled === false) throw new Error('generate_image: image generation is disabled')

      const prompt = String(args.prompt ?? '').trim()
      if (prompt === '') throw new Error('generate_image: prompt is required')

      const count = Number.isInteger(args.count) && args.count >= 1 && args.count <= MAX_IMAGES_PER_CALL
        ? args.count
        : 1
      // Size/quality are unrestricted: the model's argument wins, then the
      // configured default, else 'auto' (= "let the API decide", field omitted).
      const requestedSize = String(args.size ?? '').trim() || String(cfg.size || '').trim() || 'auto'
      const size = normalizeRequestedSize(requestedSize)
      const quality = String(args.quality ?? '').trim() || String(cfg.quality || '').trim() || DEFAULT_QUALITY
      let referenceImages = []
      if (args.referenceImageIds !== undefined) {
        if (!Array.isArray(args.referenceImageIds) || args.referenceImageIds.length === 0) {
          throw new Error('generate_image: referenceImageIds must contain at least one attachment id')
        }
        if (args.referenceImageIds.some((id) => typeof id !== 'string')) {
          throw new Error('generate_image: referenceImageIds must contain only string attachment ids')
        }
        const referenceImageIds = args.referenceImageIds.map((id) => id.trim())
        if (referenceImageIds.some((id) => id === '')) {
          throw new Error('generate_image: referenceImageIds must contain only non-empty attachment ids')
        }
        if (new Set(referenceImageIds).size !== referenceImageIds.length) {
          throw new Error('generate_image: referenceImageIds must not contain duplicates')
        }
        const limit = Number(ctx.attachments.imageLimits && ctx.attachments.imageLimits.maxImagesPerMessage)
        if (Number.isFinite(limit) && referenceImageIds.length > limit) {
          throw new Error(`generate_image: referenceImageIds exceeds the ${limit}-image session limit`)
        }

        const session = exec && exec.agent && exec.agent.session
        const available = sessionImageRefs(session)
        const refs = referenceImageIds.map((id) => {
          const ref = available.get(id)
          if (!ref) throw missingReferenceError(id, available)
          return ref
        })
        if (typeof ctx.attachments.readImage !== 'function') {
          throw new Error('generate_image: the attachment service cannot read reference images')
        }
        referenceImages = await Promise.all(refs.map(async (ref) => {
          try {
            return await ctx.attachments.readImage(ref, exec && exec.signal)
          } catch (err) {
            throw new Error(
              `generate_image: failed to read reference image ${ref.attachmentId}: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err },
            )
          }
        }))
        const byteLimit = Number(ctx.attachments.imageLimits && ctx.attachments.imageLimits.maxMessageImageBytes)
        const totalBytes = referenceImages.reduce((sum, image) => sum + image.data.byteLength, 0)
        if (Number.isFinite(byteLimit) && totalBytes > byteLimit) {
          throw new Error(`generate_image: reference images exceed the ${byteLimit}-byte session limit`)
        }
      }

      const requestCfg = {
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        apiKeyEnv: cfg.apiKeyEnv,
        model: cfg.model || DEFAULT_MODEL,
        size,
        quality,
        count,
        prompt,
        referenceImages,
      }

      // Sync a directly-entered key into the credential store (best-effort).
      if (cfg.apiKey && ctx.credentials && typeof ctx.credentials.set === 'function') {
        try {
          const current = await ctx.credentials.resolve(CREDENTIAL)
          if (!current || current.value !== cfg.apiKey) await ctx.credentials.set(CREDENTIAL, cfg.apiKey)
        } catch (err) {
          logger?.warn?.('generation-image: credential sync failed: %s', err instanceof Error ? err.message : String(err))
        }
      }

      const generated = await generateImagesFromApi(requestCfg, {
        ...(exec && exec.signal ? { signal: exec.signal } : {}),
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      })

      if (generated.length === 0) throw new Error('generate_image: the image API returned no images')

      const refs = []
      for (let i = 0; i < generated.length; i++) {
        const { data, mediaType } = generated[i]
        const ref = await ctx.attachments.saveImage({
          data,
          mediaType,
          name: `generated-${Date.now()}-${i + 1}.${mediaType.split('/')[1]}`,
        })
        refs.push(ref)
      }

      const images = refs.map(imageEntryFromRef)
      const value = { prompt, size, quality, count: images.length, images }

      // The UI renders append events, while the model reads the folded surface.
      // Append for left-side display, then synchronously shadow that append so the
      // original tool calls occur only once in the next model request.
      //
      // The shadow must be an empty `system/message`: the current harness forbids
      // `assistant/message` replacements outright (and `sourceEventSeqs` on that
      // type), which is why the previous assistant-shaped shadow was rejected and
      // the generated images never reached the conversation. An empty system node
      // is legal to replace a range, renders no UI row, and is dropped from the
      // derived transcript, so the model surface keeps a provider-valid order:
      // assistant(tool calls) -> tool result.
      const session = exec && exec.agent && exec.agent.session
      if (session && typeof session.append === 'function') {
        try {
          const phase = exec.agent.phase
          const turn = phase && Number.isInteger(phase.turn) ? phase.turn : 1
          const step = phase && Number.isInteger(phase.step) ? phase.step : 1
          const events = sessionEvents(session)
          const surfaceNodes = session.surface && session.surface.nodes
          if (!Array.isArray(events) || !Array.isArray(surfaceNodes)) {
            throw new Error('session surface is unavailable')
          }

          const eventBySeq = (seq) => events.find((event) => event && event.seq === seq)
          const isStepAssistant = (event) => event && event.type === 'assistant/message'
            && event.data && event.data.turn === turn && event.data.step === step
            && Array.isArray(event.data.message && event.data.message.content)
            && event.data.message.content.length > 0

          // Base: the current step's model assistant message (the one that
          // carries the tool calls). It may no longer be the surface tail when
          // another concurrent tool's result has already been appended.
          let baseSeq = surfaceNodes.at(-1)
          let baseEvent = eventBySeq(baseSeq)
          if (!isStepAssistant(baseEvent)) {
            baseSeq = null
            for (let i = surfaceNodes.length - 1; i >= 0; i--) {
              const candidate = eventBySeq(surfaceNodes[i])
              if (isStepAssistant(candidate)) {
                baseSeq = surfaceNodes[i]
                baseEvent = candidate
                break
              }
            }
          }
          if (!baseEvent || !isStepAssistant(baseEvent)) {
            throw new Error('current step assistant surface node was not found')
          }
          const baseSource = baseEvent.data.message.source
          if (!baseSource || baseSource.kind !== 'model' || !baseSource.provider || !baseSource.model) {
            throw new Error('current step assistant message has no model source')
          }
          const displaySource = { provider: baseSource.provider, model: baseSource.model }

          let displayContent = baseEvent.data.message.content
          for (let i = events.length - 1; i >= 0; i--) {
            const event = events[i]
            if (event && event.type === 'assistant/message' && event.surfaceOp === 'append'
              && event.data && event.data.turn === turn && event.data.step === step
              && Array.isArray(event.data.message && event.data.message.content)
              && event.data.message.content.some((block) => block && block.type === 'image')) {
              displayContent = event.data.message.content
              break
            }
          }

          const mergedContent = [...displayContent]
          const attachmentIds = new Set(
            mergedContent
              .filter((block) => block && block.type === 'image')
              .map((block) => block.attachment && block.attachment.attachmentId)
              .filter(Boolean),
          )
          for (const image of images) {
            if (attachmentIds.has(image.attachmentId)) continue
            attachmentIds.add(image.attachmentId)
            mergedContent.push(imageEntryToBlock(image))
          }

          // `stream` is part of the durable Assistant-settlement contract even
          // though the session's append-time validation does not require it:
          // `assertAssistantSettlementShape` demands an array when the log is
          // restored (a streamless settlement makes the whole session
          // unloadable), and `TokenMeter`'s `usageOf`, session-stats, the API
          // session controller and subagent text folding all read
          // `event.data.stream` unconditionally (`undefined.length` → the turn
          // dies right after the generation). This display-only node streams
          // nothing, so it carries an empty stream instead of omitting one.
          const displayEvent = session.append(
            'assistant/message',
            {
              turn,
              step,
              message: createAssistantMessage({ content: mergedContent, source: displaySource }),
              stream: [],
            },
            { surfaceOp: 'append' },
          )

          session.append(
            'system/message',
            { turn, step, message: createSystemMessage('', DISPLAY_PLUGIN) },
            {
              surfaceOp: { op: 'replace', startSeq: displayEvent.seq, endSeq: displayEvent.seq },
              sourceEventSeqs: [displayEvent.seq],
            },
          )
        } catch (err) {
          logger?.warn?.('generation-image: failed to surface assistant image: %s', err instanceof Error ? err.message : String(err))
        }
      }

      return value
    },
    presentCall(args) {
      const prompt = String((args && args.prompt) || '').trim()
      return {
        card: 'generic',
        title: prompt ? `Generate image: ${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''}` : 'Generate image',
        kind: 'other',
      }
    },
  }
}

/** HTTP helpers for the same-origin Settings route. */
function responseJson(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body))
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('Cache-Control', 'no-store')
  res.writeHead(status)
  res.end(bytes)
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += part.length
    if (bytes > maxBytes) throw new RangeError('request body too large')
    chunks.push(part)
  }
  if (chunks.length === 0) throw new TypeError('empty request body')
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sameOriginPost(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  if (host === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

/**
 * Same-origin Settings route for the browser form: GET returns the effective
 * config, POST { value } persists it to the config file (applied live).
 */
function installSettingsRoute(ctx, resolveCfg, syncToolRegistration) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      return webCtx.webServer.register({
        kind: 'exact',
        path: SETTINGS_ROUTE,
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') {
              const stored = readConfigFile()
              const effective = resolveCfg()
              return responseJson(res, 200, {
                ok: true,
                value: {
                  stored,
                  effective,
                  admissionBypass: admissionActive,
                  services: {
                    credentials: Boolean(ctx.credentials),
                    attachments: Boolean(ctx.attachments),
                    tools: Boolean(ctx.get?.('tools')),
                  },
                },
              })
            }
            if (req.method !== 'POST') {
              res.setHeader('Allow', 'GET, POST')
              return responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET or POST' } })
            }
            if (!sameOriginPost(req)) {
              return responseJson(res, 403, { ok: false, error: { code: 'origin-rejected', message: 'Origin rejected' } })
            }
            const body = await readJsonBody(req)
            if (!isRecord(body) || !isRecord(body.value)) {
              return responseJson(res, 400, { ok: false, error: { code: 'invalid-request', message: 'body.value must be an object' } })
            }
            const saved = writeConfigFile(body.value)
            const cfg = resolveCfg()
            syncToolRegistration(cfg)
            return responseJson(res, 200, { ok: true, value: { saved } })
          } catch (error) {
            ctx.logger?.warn?.('generation-image: settings route error: %s', error instanceof Error ? error.message : String(error))
            return responseJson(res, 400, { ok: false, error: { code: 'settings-rejected', message: error instanceof Error ? error.message : String(error) } })
          }
        },
      })
    }, 'dsh-generation-image: settings route')
  })
}

/** Keep the tool visible after downstream tool-surface filters (mirror vision-bridge). */
function installAssemblyHook(ctx, toolName, state, syncToolRegistration, resolveCfg) {
  ctx.on(
    'system-prompt/assemble',
    async (assembly, _context, next) => {
      const ownedAtStart = state.toolDisposer !== null
      const assembled = await next()
      const cfg = resolveCfg()
      syncToolRegistration(cfg)
      if (cfg.enabled === false) {
        if (!ownedAtStart || !assembled.tools.some((tool) => tool.name === toolName)) return assembled
        return {
          ...assembled,
          tools: assembled.tools.filter((tool) => tool.name !== toolName),
        }
      }
      const registeredSchema = assembly.tools.find((tool) => tool.name === toolName)
      if (
        state.toolDisposer === null ||
        registeredSchema === undefined ||
        assembled.tools.some((tool) => tool.name === toolName)
      ) {
        return assembled
      }
      return {
        ...assembled,
        tools: [...assembled.tools, structuredClone(registeredSchema)],
      }
    },
    { prepend: true },
  )
}

/** Register/unregister the tool according to the live enabled flag. */
function syncToolRegistration(ctx, tool, cfg, state) {
  const tools = ctx.get && ctx.get('tools')
  if (!tools || typeof tools.register !== 'function') return
  const should = cfg.enabled !== false
  if (should && state.toolDisposer === null) {
    try {
      state.toolDisposer = tools.register(tool)
      ctx.logger?.info?.('generation-image: generate_image tool registered')
    } catch (err) {
      ctx.logger?.warn?.('generation-image: generate_image tool registration failed: %s', err instanceof Error ? err.message : String(err))
    }
  } else if (!should && state.toolDisposer !== null) {
    try {
      state.toolDisposer()
    } catch {
      /* ignore disposer failure */
    }
    state.toolDisposer = null
    ctx.logger?.info?.('generation-image: generate_image tool unregistered')
  }
}

export async function apply(ctx, config = {}) {
  // Surface a "generation-image" section in the built-in DSH Settings page.
  try {
    ctx.settings.register(SETTINGS_NAMESPACE, Config, { base: config })
  } catch (err) {
    const msg = err instanceof Error ? (err.stack || err.message) : String(err)
    ctx.logger?.warn?.('generation-image: settings namespace register failed: %s', msg)
  }

  const bootCfg = resolveConfig(ctx, config)
  const resolveCfg = () => resolveConfig(ctx, config)
  const state = { toolDisposer: null }
  ctx.logger?.info?.(
    'generation-image: registered (model=%s endpoint=%s key=%s; generate_image tool)',
    bootCfg.model || DEFAULT_MODEL,
    resolveBaseUrl(bootCfg.baseUrl) || '(unset)',
    resolveApiKey(bootCfg) ? 'yes' : 'no',
  )

  // ── generate_image tool (dynamic: registered only while enabled) ───────────
  const generationTool = createGenerateImageTool(ctx, {
    resolveConfig: resolveCfg,
    logger: ctx.logger,
    fetch: config && typeof config.fetch === 'function' ? config.fetch : undefined,
  })
  const syncRegistration = (cfg) => syncToolRegistration(ctx, generationTool, cfg, state)
  syncRegistration(bootCfg)

  // Tool-surface routers may narrow the first request. Keep this tool visible
  // after every downstream filter because sessions depend on it.
  installAssemblyHook(ctx, generationTool.name, state, syncRegistration, resolveCfg)

  // ── shipped skill: discoverable/loadable guidance for the generate_image tool ──
  if (SHIPPED_SKILL) {
    // NOTE: read the skill service through ctx.get('skills') — 'skills' is NOT
    // in this plugin's inject list, and DSH's cordis throws on any undeclared
    // property access. `ctx.skills` crashed the fiber at startup here (which
    // unregistered the Settings route, so the client fetch got the SPA HTML
    // and failed with "Unexpected token '<' ... not valid JSON").
    const skills = ctx.get && ctx.get('skills')
    if (skills && typeof skills.register === 'function') {
      try {
        ctx.effect(() => skills.register(SHIPPED_SKILL), 'dsh-generation-image: generate-image skill')
        ctx.logger?.info?.('generation-image: skill "%s" registered', SHIPPED_SKILL.name)
      } catch (err) {
        ctx.logger?.warn?.('generation-image: skill registration failed: %s', err instanceof Error ? err.message : String(err))
      }
    }
  }

  // ── auto-trigger guidance: always visible so the model calls generate_image
  //    without the user naming the tool (empty while disabled) ────────────────
  try {
    ctx.systemPrompt.section({
      name: 'generate-image-trigger',
      order: TRIGGER_SECTION_ORDER,
      text: () => (resolveCfg().enabled === false ? '' : TRIGGER_SECTION_TEXT),
    })
    ctx.logger?.info?.('generation-image: trigger guidance section registered')
  } catch (err) {
    ctx.logger?.warn?.('generation-image: trigger guidance section registration failed: %s', err instanceof Error ? err.message : String(err))
  }

  // ── marker rewrite: keep image blocks out of text-model requests only ───────
  // The routed model decides: a multimodal route keeps its real image blocks so
  // the model reads them natively, and only a route without native image input
  // gets the text markers. The capability lookup is asynchronous but
  // `deriveMessages` is not awaited by the agent loop, so `agent/request`
  // (which IS awaited) resolves it once per step into `agentRoutePlan`.
  const wrappedSessions = new WeakSet()
  /** Per-agent `{ nativeImage }` plan for the current step. */
  const agentRoutePlan = new WeakMap()
  const installSessionWrap = (session, agent) => {
    if (!session || typeof session.deriveMessages !== 'function' || wrappedSessions.has(session)) return
    const original = session.deriveMessages
    let active = true
    const patched = function () {
      const messages = original.call(this)
      if (!active) return messages
      const cfg = resolveCfg()
      if (cfg.enabled === false) return messages
      if (!messages.some((message) => contentHasImage(message && message.content))) return messages
      const plan = agent !== undefined && agent !== null ? agentRoutePlan.get(agent) : undefined
      if (!shouldRewriteImages(cfg, plan !== undefined && plan.nativeImage === true)) return messages
      try {
        return messages.map((message) => rewriteImageBlocksToMarkers(message))
      } catch (err) {
        ctx.logger?.warn?.(
          'generation-image: marker rewrite failed, sending original messages: %s',
          err instanceof Error ? err.message : String(err),
        )
        return messages
      }
    }
    ctx.effect(() => {
      session.deriveMessages = patched
      wrappedSessions.add(session)
      return () => {
        active = false
        if (session.deriveMessages === patched) session.deriveMessages = original
        wrappedSessions.delete(session)
      }
    }, 'dsh-generation-image: session marker rewrite')
  }

  // Track the exact route of each step. `agent/request` resolves last (a
  // per-session model switch is applied by an inner listener), so the listener
  // is prepended and records the resolved route after `await next()`.
  ctx.on(
    'agent/request',
    async ({ agent }, next) => {
      const resolved = await next()
      try {
        const route = normalizeRoute(resolved && resolved.provider, resolved && resolved.model)
        if (route !== undefined && agent !== undefined && agent !== null) {
          agentRoutePlan.set(agent, {
            nativeImage: await routeHasNativeImage(ctx, route),
          })
        }
      } catch {
        /* capability probing must never disturb a request */
      }
      return resolved
    },
    { prepend: true },
  )

  ctx.on(
    'agent/pre-step',
    async ({ agent }, next) => {
      const session = agent && agent.session
      if (session) installSessionWrap(session, agent)
      return next()
    },
  )

  // Web Settings form backend route (optional webServer service).
  installSettingsRoute(ctx, resolveCfg, syncRegistration)

  // Unblock the host admission gate so image prompts reach the agent.
  installAdmissionBypass(ctx, config)

  ctx.effect(
    () => () => {
      if (state.toolDisposer !== null) {
        try {
          state.toolDisposer()
        } catch {
          /* ignore disposer failure */
        }
        state.toolDisposer = null
      }
    },
    'dsh-generation-image: generate_image tool',
  )
}
