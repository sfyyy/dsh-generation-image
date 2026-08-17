import assert from 'node:assert/strict'
import test from 'node:test'
import { Buffer } from 'node:buffer'

import {
  apply,
  inject,
  SETTINGS_ROUTE,
  contentHasImage,
  sniffMediaType,
  parseSseImages,
  extractB64FromJson,
  decodeImages,
  resolveBaseUrl,
  resolveApiKey,
  resolveConfig,
  rewriteImageBlocksToMarkers,
  formatGenerationEnvelope,
} from '../lib/index.js'

/** A minimal valid PNG header (>= 12 bytes so sniffMediaType can decide). */
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])

/**
 * Real durable attachment ids look like "sha256:<64 hex chars>".
 */
function AID(seed) {
  return 'sha256:' + String(seed).padStart(64, '0')
}

function base64Of(bytes) {
  return Buffer.from(bytes).toString('base64')
}

function makeImageBlock(id, name = 'generated-1.png') {
  return { type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', name } }
}

function sseEvent(type, payload) {
  return `data: ${JSON.stringify({ type, ...payload })}\n\n`
}

function createFakeCtx(config, overrides = {}) {
  const handlers = new Map()
  const handlerOptions = new Map()
  const routes = []
  const credentials = new Map()
  const effects = []
  let active = true
  const calls = { saveImage: [], requests: [] }

  const effect = (install) => {
    const dispose = install()
    if (typeof dispose === 'function') effects.push(dispose)
  }

  const tools = {
    registered: [],
    register(def) {
      this.registered.push(def)
      let disposed = false
      return () => {
        disposed = true
        this.registered = this.registered.filter((d) => d !== def)
      }
    },
  }

  const llm = overrides.llm ?? {
    async resolveModelInfo(...args) {
      if (overrides.resolveModelInfo) return overrides.resolveModelInfo(...args)
      return { inputModalities: ['text'] }
    },
  }

  const settings = {
    get: (namespace) => (namespace === 'generation-image' ? config : undefined),
    register: () => ({ get: () => config }),
    mutate: async () => {},
  }

  const ctx = {
    attachments: {
      async saveImage(input) {
        calls.saveImage.push(input)
        return {
          attachmentId: AID(`g${calls.saveImage.length}`),
          mediaType: input.mediaType,
          bytes: input.data.length,
          width: 1024,
          height: 1024,
          ...(input.name ? { name: input.name } : {}),
        }
      },
    },
    credentials: {
      async resolve(ref) {
        return credentials.has(ref) ? { value: credentials.get(ref) } : undefined
      },
      async set(ref, value) {
        credentials.set(ref, value)
      },
    },
    llm,
    get settings() {
      if (!active) throw new Error('cannot get required service "settings" in inactive context')
      return settings
    },
    get(name) {
      if (name === 'tools') return tools
      return undefined
    },
    logger: { info() {}, warn() {} },
    effect,
    inject(services, callback) {
      if (services.includes('webServer')) {
        callback({
          webServer: { register: (def) => { routes.push(def); return () => {} } },
          effect,
        })
        return
      }
      callback({ llm, effect })
    },
    on(name, handler, options) {
      handlers.set(name, handler)
      handlerOptions.set(name, options)
    },
    _handlers: handlers,
    _handlerOptions: handlerOptions,
    _routes: routes,
    _tools: tools,
    _calls: calls,
    async _dispose() {
      while (effects.length > 0) await effects.pop()()
      active = false
    },
  }
  return ctx
}

function fakeSession(messages, events = [], id = 's1') {
  return {
    id,
    events,
    deriveMessages() {
      return messages
    },
  }
}

function noNetworkFetch() {
  return async () => {
    throw new Error('no network in tests')
  }
}

const CONFIG = {
  enabled: true,
  baseUrl: 'https://image.example/v1',
  apiKey: 'test-key',
  model: 'gpt-image-2',
  size: '1024x1024',
  quality: 'auto',
}

// Isolate from any real ~/.dsh/generation-image.json on this machine.
const PREV_CONFIG = process.env.DSH_GENERATION_IMAGE_CONFIG
process.env.DSH_GENERATION_IMAGE_CONFIG = '/nonexistent/dsh-generation-image-test.json'

test('AC1: generate_image registers while enabled and is absent when disabled', async () => {
  const ctx = createFakeCtx(CONFIG)
  await apply(ctx, { fetch: noNetworkFetch() })

  const tool = ctx._tools.registered.find((d) => d.name === 'generate_image')
  assert.ok(tool, 'generate_image must be registered while enabled')
  assert.ok(tool.parameters.required.includes('prompt'))
  assert.equal(tool.parameters.properties.count.maximum, 4)

  const disabled = createFakeCtx({ ...CONFIG, enabled: false })
  await apply(disabled, { fetch: noNetworkFetch() })
  assert.equal(
    disabled._tools.registered.some((d) => d.name === 'generate_image'),
    false,
    'disabled plugin must not register the tool',
  )
})

test('AC2: execute calls /images/generations (SSE), saves an attachment, renders image block', async () => {
  const b64 = base64Of(PNG)
  const ctx = createFakeCtx(CONFIG)
  const session = fakeSession([])
  const seen = []
  await apply(ctx, {
    fetch: async (url, init) => {
      seen.push({ url, init })
      const body = sseEvent('image_generation.partial_image', { b64_json: b64 })
        + sseEvent('image_generation.completed', { b64_json: b64 })
        + 'data: [DONE]\n\n'
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  })

  const tool = ctx._tools.registered.find((d) => d.name === 'generate_image')
  const value = await tool.execute(
    { prompt: 'a cat in a hat', size: '1024x1024', quality: 'high' },
    { agent: { session }, signal: new AbortController().signal },
  )

  assert.equal(value.images.length, 1)
  assert.equal(value.images[0].mediaType, 'image/png')
  assert.equal(value.images[0].bytes, PNG.length)
  assert.equal(value.count, 1)

  assert.equal(seen.length, 1)
  assert.match(seen[0].url, /\/images\/generations$/)
  const request = JSON.parse(seen[0].init.body)
  assert.equal(request.model, 'gpt-image-2')
  assert.equal(request.prompt, 'a cat in a hat')
  assert.equal(request.response_format, 'b64_json')
  assert.equal(request.stream, true)
  assert.equal(request.partial_images, 1)
  assert.equal(request.quality, 'high')
  assert.equal(request.size, '1024x1024')
  assert.equal(seen[0].init.headers.Authorization, 'Bearer test-key')

  assert.equal(ctx._calls.saveImage.length, 1, 'generated image must be saved as an attachment')

  const content = tool.output.render({}, value)
  assert.equal(content[0].type, 'text')
  assert.ok(content[0].text.includes('a cat in a hat'))
  assert.equal(content[1].type, 'image')
  assert.equal(content[1].attachment.attachmentId, value.images[0].attachmentId)
})

test('AC3: execute parses a plain JSON (non-streaming) response', async () => {
  const b64 = base64Of(PNG)
  const ctx = createFakeCtx(CONFIG)
  await apply(ctx, {
    fetch: async () => new Response(
      JSON.stringify({ data: [{ b64_json: b64 }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  })

  const tool = ctx._tools.registered.find((d) => d.name === 'generate_image')
  const value = await tool.execute(
    { prompt: 'mountain at sunset' },
    { agent: { session: fakeSession([]) } },
  )
  assert.equal(value.images.length, 1)
  assert.equal(value.images[0].mediaType, 'image/png')
})

test('AC4: nested (run_code) dispatch defers the image back into context', async () => {
  const b64 = base64Of(PNG)
  const ctx = createFakeCtx(CONFIG)
  const deferred = []
  await apply(ctx, {
    fetch: async () => new Response(
      sseEvent('image_generation.completed', { b64_json: b64 }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ),
  })

  const tool = ctx._tools.registered.find((d) => d.name === 'generate_image')
  await tool.execute(
    { prompt: 'a tree' },
    {
      agent: { session: fakeSession([]) },
      parent: Symbol('parent'),
      deferContext(context) {
        deferred.push(context)
      },
    },
  )
  assert.equal(deferred.length, 1, 'nested dispatch must defer the image context')
  assert.equal(deferred[0].content[0].type, 'text')
  assert.equal(deferred[0].content[1].type, 'image')
  assert.equal(deferred[0].source.plugin, 'generation-image')
})

test('parseSseImages: completed wins, [DONE] ignored, errors throw', () => {
  const b64 = base64Of(PNG)
  const images = parseSseImages(
    sseEvent('image_generation.partial_image', { b64_json: b64 })
    + sseEvent('image_generation.completed', { b64_json: b64 })
    + 'data: [DONE]\n\n',
  )
  assert.deepEqual(images, [b64])

  const onlyPartial = parseSseImages(sseEvent('image_generation.partial_image', { b64_json: b64 }))
  assert.deepEqual(onlyPartial, [b64])

  assert.throws(
    () => parseSseImages(sseEvent('image_generation.error', { error: { message: 'boom' } })),
    /boom/,
  )
  assert.deepEqual(parseSseImages(''), [])
})

test('decodeImages: dedupes and sniffs the media type', () => {
  const decoded = decodeImages([base64Of(PNG), base64Of(PNG), ''])
  assert.equal(decoded.length, 1)
  assert.equal(decoded[0].mediaType, 'image/png')
  assert.deepEqual(decoded[0].data, new Uint8Array(PNG))
})

test('extractB64FromJson: reads data[].b64_json and skips url-only items', () => {
  assert.deepEqual(
    extractB64FromJson({ data: [{ b64_json: 'x' }, { url: 'https://e/x.png' }] }),
    ['x'],
  )
  assert.deepEqual(extractB64FromJson({}), [])
  assert.deepEqual(extractB64FromJson({ data: [] }), [])
})

test('sniffMediaType: PNG/JPEG/WebP/GIF magic bytes', () => {
  assert.equal(sniffMediaType(PNG), 'image/png')
  assert.equal(sniffMediaType(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])), 'image/jpeg')
  const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  assert.equal(sniffMediaType(gif), 'image/gif')
  assert.equal(sniffMediaType(Buffer.alloc(12)), undefined)
})

test('AC5: image blocks become markers in deriveMessages; session log untouched', async () => {
  const ctx = createFakeCtx(CONFIG)
  const image = makeImageBlock(AID('g1'))
  const nested = { type: 'tool-result', toolCallId: 't1', content: [image] }
  const original = [
    { role: 'user', content: [image] },
    { role: 'assistant', content: [nested] },
  ]
  const session = fakeSession(structuredClone(original))
  await apply(ctx, { fetch: noNetworkFetch() })

  const preStep = ctx._handlers.get('agent/pre-step')
  assert.ok(preStep, 'agent/pre-step handler must be registered')
  await preStep({ agent: { session } }, async () => ({ kind: 'enter', messages: [] }))

  const derived = session.deriveMessages()
  assert.equal(contentHasImage(derived[0].content), false, 'top-level image → marker')
  assert.ok(derived[0].content.some((b) => b.type === 'text' && /附件 id/.test(b.text) && new RegExp(AID('g1')).test(b.text)))
  const toolResult = derived[1].content[0]
  assert.equal(toolResult.type, 'tool-result')
  assert.equal(contentHasImage(toolResult.content), false, 'nested tool-result image → marker')
  assert.ok(toolResult.content.some((b) => b.type === 'text' && /附件 id/.test(b.text)))
  // session log keeps originals
  assert.equal(contentHasImage(original[0].content), true)
  assert.equal(contentHasImage(original[1].content[0].content), true)
})

test('AC6: admission bypass adds image input while enabled, off when disabled', async () => {
  const ctx = createFakeCtx(CONFIG)
  await apply(ctx, { fetch: noNetworkFetch() })
  const info = await ctx.llm.resolveModelInfo('deepseek', 'text-model')
  assert.ok(info.inputModalities.includes('image'), 'bypass must admit image messages while enabled')

  const disabled = createFakeCtx({ ...CONFIG, enabled: false })
  await apply(disabled, { fetch: noNetworkFetch() })
  const info2 = await disabled.llm.resolveModelInfo('deepseek', 'text-model')
  assert.deepEqual(info2.inputModalities, ['text'], 'bypass must be off when disabled')
})

test('AC7: generate_image survives downstream tool filters', async () => {
  const ctx = createFakeCtx(CONFIG)
  await apply(ctx, { fetch: noNetworkFetch() })

  const assemble = ctx._handlers.get('system-prompt/assemble')
  assert.ok(assemble, 'the plugin must own the final model-visible tool boundary')
  assert.equal(ctx._handlerOptions.get('system-prompt/assemble')?.prepend, true)

  const definition = ctx._tools.registered.find((d) => d.name === 'generate_image')
  const filtered = { sections: [], contexts: [], tools: [{ name: 'bash' }], variables: {} }
  const unfiltered = {
    ...filtered,
    tools: [...filtered.tools, {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    }],
  }
  const result = await assemble(unfiltered, {}, async () => filtered)
  assert.deepEqual(result.tools.map((tool) => tool.name), ['bash', 'generate_image'])

  const restricted = await assemble(filtered, {}, async () => filtered)
  assert.deepEqual(restricted.tools.map((tool) => tool.name), ['bash'])
})

test('AC8: disabled plugin rewrites nothing and registers no tool', async () => {
  const ctx = createFakeCtx({ ...CONFIG, enabled: false })
  const image = makeImageBlock(AID('g2'))
  const original = [{ role: 'user', content: [image] }]
  const session = fakeSession(structuredClone(original))
  await apply(ctx, { fetch: noNetworkFetch() })

  const preStep = ctx._handlers.get('agent/pre-step')
  await preStep({ agent: { session } }, async () => ({ kind: 'enter', messages: [] }))
  const derived = session.deriveMessages()
  assert.deepEqual(derived, original, 'deriveMessages must pass through when disabled')
})

test('AC9: settings route is registered and exposes effective config', async () => {
  const ctx = createFakeCtx(CONFIG)
  await apply(ctx, { fetch: noNetworkFetch() })
  assert.ok(ctx._routes.some((r) => r.path === SETTINGS_ROUTE), 'settings route must be registered')
})

test('lifecycle: request-facing registries are required startup dependencies', () => {
  for (const dep of ['settings', 'credentials', 'attachments', 'llm', 'tools', 'systemPrompt']) {
    assert.ok(inject.includes(dep), `inject must include ${dep}`)
  }
})

test('resolveBaseUrl normalizes image API roots', () => {
  assert.equal(resolveBaseUrl('https://api.xiaoyaoapi.cc'), 'https://api.xiaoyaoapi.cc/v1')
  assert.equal(resolveBaseUrl('https://api.xiaoyaoapi.cc/v1'), 'https://api.xiaoyaoapi.cc/v1')
  assert.equal(resolveBaseUrl('https://api.xiaoyaoapi.cc/v1/'), 'https://api.xiaoyaoapi.cc/v1')
  assert.equal(resolveBaseUrl(''), '')
  assert.equal(resolveBaseUrl('   '), '')
})

test('resolveApiKey prefers a direct key, then an env-var name', () => {
  assert.equal(resolveApiKey({ apiKey: 'direct' }), 'direct')
  process.env.DSH_GENERATION_IMAGE_TEST_KEY = 'from-env'
  assert.equal(resolveApiKey({ apiKeyEnv: 'DSH_GENERATION_IMAGE_TEST_KEY' }), 'from-env')
  assert.equal(resolveApiKey({ apiKey: 'direct', apiKeyEnv: 'DSH_GENERATION_IMAGE_TEST_KEY' }), 'direct')
  delete process.env.DSH_GENERATION_IMAGE_TEST_KEY
  assert.equal(resolveApiKey({}), '')
})

test('formatGenerationEnvelope summarizes a result', () => {
  const envelope = formatGenerationEnvelope({
    prompt: 'a cat',
    size: '1024x1024',
    quality: 'high',
    count: 1,
    images: [{ attachmentId: AID('g9'), mediaType: 'image/png', width: 1024, height: 1024, bytes: 16 }],
  })
  assert.ok(envelope.includes('a cat'))
  assert.ok(envelope.includes(AID('g9')))
})

test('resolveConfig applies env overrides', () => {
  const prev = process.env.DSH_GENERATION_IMAGE_MODEL
  process.env.DSH_GENERATION_IMAGE_MODEL = 'gpt-image-9'
  try {
    const cfg = resolveConfig({ settings: { get: () => ({ ...CONFIG }) } })
    assert.equal(cfg.model, 'gpt-image-9')
  } finally {
    if (prev === undefined) delete process.env.DSH_GENERATION_IMAGE_MODEL
    else process.env.DSH_GENERATION_IMAGE_MODEL = prev
  }
})

test('rewriteImageBlocksToMarkers returns original when no image present', () => {
  const plain = { role: 'user', content: [{ type: 'text', text: 'hi' }] }
  assert.equal(rewriteImageBlocksToMarkers(plain), plain)
})

// restore the config-path env so later tests (if any) are isolated
test.after(() => {
  if (PREV_CONFIG === undefined) delete process.env.DSH_GENERATION_IMAGE_CONFIG
  else process.env.DSH_GENERATION_IMAGE_CONFIG = PREV_CONFIG
})
