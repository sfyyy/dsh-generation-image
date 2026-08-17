/**
 * @dsh-extension/dsh-generation-image
 *
 * On-demand image generation for DeepSeek Harness (DSH) sessions.
 *
 * The agent gets a single `generate_image` tool. Calling it with a prompt
 * POSTs to the user-configured OpenAI-compatible image endpoint
 * (`{baseUrl}/images/generations`), receives the generated image bytes
 * (`b64_json`, SSE or plain JSON), durably commits them through the DSH
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
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

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

/** Settings namespace surfaced in the built-in DSH Settings page. */
export const SETTINGS_NAMESPACE = 'generation-image'

/** schemastery schema driving the Settings form (defaults apply). */
const Config = z.object({
  enabled: z.boolean().default(true),
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

/** Normalize baseUrl for the OpenAI-compatible images endpoint. */
export function resolveBaseUrl(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!b) return ''
  const base = b.replace(/\/chat\/completions$/i, '')
  return /\/v\d+$/i.test(base) ? base : `${base}/v1`
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
 * Parse an SSE image-generation stream into the final image b64 payloads.
 * Accepts `image_generation.completed` / `image_edit.completed` events (and
 * falls back to the last `partial_image` when no completed event arrives).
 * Provider error events throw with their message.
 */
export function parseSseImages(text) {
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
    if (typeof parsed.b64_json !== 'string' || !parsed.b64_json) continue
    if (type.endsWith('.completed')) completed.push(parsed.b64_json)
    else if (type.endsWith('.partial_image') || type.endsWith('.partial')) partial = parsed.b64_json
    else completed.push(parsed.b64_json) // untyped record: treat as a real image
  }
  if (completed.length > 0) return completed
  return partial ? [partial] : []
}

/** Collect `b64_json` payloads from a plain (non-streaming) JSON response body. */
export function extractB64FromJson(data) {
  if (!isRecord(data) || !Array.isArray(data.data)) return []
  const out = []
  for (const item of data.data) {
    if (isRecord(item) && typeof item.b64_json === 'string' && item.b64_json) out.push(item.b64_json)
  }
  return out
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
 * Call the OpenAI-compatible `/images/generations` endpoint.
 *
 * `cfg` carries the resolved request fields; `opts.fetch` is injectable for
 * tests (defaults to globalThis.fetch). Returns an array of
 * `{ data: Uint8Array, mediaType: string }`.
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
  const url = `${base}/images/generations`

  // Size and quality are passed through from the model/config with no
  // restriction; 'auto' (or an empty value) means "let the API decide" and the
  // field is omitted from the request.
  const rawSize = String(cfg.size || '').trim()
  const rawQuality = String(cfg.quality || '').trim()
  const size = rawSize !== '' && rawSize.toLowerCase() !== 'auto' ? rawSize : undefined
  const quality = rawQuality !== '' && rawQuality.toLowerCase() !== 'auto' ? rawQuality : undefined

  const body = {
    model,
    prompt,
    response_format: 'b64_json',
    n: Number.isInteger(cfg.count) && cfg.count >= 1 ? cfg.count : 1,
    ...(size ? { size } : {}),
    ...(quality ? { quality } : {}),
    stream: true,
    partial_images: 1,
  }

  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  } catch (err) {
    throw mapFetchError(err)
  }

  if (!response.ok) throw await mapHttpError(response)

  const contentType = String(response.headers?.get?.('content-type') || '')
  if (contentType.includes('text/event-stream')) {
    const text = await response.text()
    const b64List = parseSseImages(text)
    if (b64List.length === 0) {
      throw new Error('generation-image: the image API stream ended without a completed image.')
    }
    return decodeImages(b64List)
  }

  let data
  try {
    data = await response.json()
  } catch (err) {
    throw new Error(`generation-image: the image API returned an unreadable response: ${err instanceof Error ? err.message : String(err)}`)
  }
  const b64List = extractB64FromJson(data)
  if (b64List.length === 0) {
    throw new Error('generation-image: the image API returned no b64_json data (the provider may only return URLs, or the content was filtered).')
  }
  return decodeImages(b64List)
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

/**
 * Text marker replacing an image block in the model input. Keeps the
 * vision_describe hint so this plugin composes gracefully with a vision
 * bridge installed alongside.
 */
export function imageMarker(block) {
  const attachment = block && block.attachment ? block.attachment : {}
  const id = attachment.attachmentId || attachment.id || 'unknown'
  const name = attachment.name || '图片'
  return {
    type: 'text',
    text:
      `[图片「${name}」已在会话中（附件 id「${id}」）。当前模型为纯文本模型，无法直接查看图片；` +
      `如需查看图片内容，可调用 vision_describe 工具（若已安装视觉桥接插件）并传入 attachmentIds: ["${id}"]。]`,
  }
}

/**
 * Replace every image block in one message (top-level or nested in tool-result)
 * with a marker. Returns the original message unchanged when it has no image;
 * changed messages are rebuilt as deep-frozen structured clones to match the
 * frozen-message contract of `Session.deriveMessages`.
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
      'Generate one or more images with the configured image-generation API. ' +
      'Provide a `prompt` describing the image you want. Optionally set `size` ' +
      '(e.g. 1024x1024, 1024x1792, 1792x1024), `quality` (auto|low|medium|high), ' +
      'and `count` (1-4 images). The generated image is saved into the session ' +
      'and returned as an image block. The current text model cannot see the ' +
      'pixels itself, but the image is delivered to the user in the session UI.',
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
            '(e.g. 1024x1024, 1024x1792, 1792x1024), or "auto"/omit to let the API choose',
        },
        quality: {
          type: 'string',
          description: 'Image quality, unrestricted — common values are auto (default), low, medium, high',
        },
        count: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_IMAGES_PER_CALL,
          description: `Number of images to generate (1-${MAX_IMAGES_PER_CALL}, default 1)`,
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', required: true },
          size: { type: 'string', required: true },
          quality: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          images: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                attachmentId: { type: 'string', required: true },
                mediaType: {
                  type: 'string',
                  enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
                  required: true,
                },
                bytes: { type: 'integer', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
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
      const size = String(args.size ?? '').trim() || String(cfg.size || '').trim() || 'auto'
      const quality = String(args.quality ?? '').trim() || String(cfg.quality || '').trim() || DEFAULT_QUALITY

      const requestCfg = {
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        apiKeyEnv: cfg.apiKeyEnv,
        model: cfg.model || DEFAULT_MODEL,
        size,
        quality,
        count,
        prompt,
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
      const content = render({}, value)

      // Surface the generated image as a user-role context message so the
      // conversation UI renders a thumbnail (user bubbles render image blocks;
      // bare tool-result image blocks do not). The marker rewrite keeps the
      // text model safe — it sees a text marker, the UI sees the image.
      if (exec && typeof exec.deferContext === 'function') {
        exec.deferContext(createUserMessage({
          content,
          source: { kind: 'plugin', plugin: 'generation-image' },
        }))
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

  // ── marker rewrite: keep image blocks out of every text-model request ───────
  const wrappedSessions = new WeakSet()
  const installSessionWrap = (session) => {
    if (!session || typeof session.deriveMessages !== 'function' || wrappedSessions.has(session)) return
    const original = session.deriveMessages
    let active = true
    const patched = function () {
      const messages = original.call(this)
      if (!active) return messages
      const cfg = resolveCfg()
      if (cfg.enabled === false) return messages
      if (!messages.some((message) => contentHasImage(message && message.content))) return messages
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

  ctx.on(
    'agent/pre-step',
    async ({ agent }, next) => {
      const session = agent && agent.session
      if (session) installSessionWrap(session)
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
