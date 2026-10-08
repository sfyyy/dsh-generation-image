import assert from 'node:assert/strict'
import test from 'node:test'
import { Buffer } from 'node:buffer'
import { assertSupportedJsonSchema, JsonSchemaError } from '@deepseek-ai/dsh-tools'
import { createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'

import {
  apply,
  inject,
  SETTINGS_ROUTE,
  contentHasImage,
  sniffMediaType,
  parseSseImages,
  parseSseImageItems,
  extractB64FromJson,
  extractImageItemsFromJson,
  decodeImages,
  resolveImageItems,
  resolveBaseUrl,
  normalizeRequestedSize,
  resolveApiKey,
  resolveConfig,
  imageMarker,
  resolveMarkerMode,
  normalizeRoute,
  routeHasNativeImage,
  shouldRewriteImages,
  rewriteImageBlocksToMarkers,
  formatGenerationEnvelope,
  generateImagesFromApi,
  sessionEvents,
  sessionImageRefs,
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
  return {
    type: 'image',
    attachment: { attachmentId: id, mediaType: 'image/png', bytes: PNG.length, width: 1, height: 1, name },
  }
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
  const calls = { saveImage: [], readImage: [], requests: [] }
  const promptSections = []

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
      imageLimits: overrides.imageLimits ?? { maxImagesPerMessage: 4, maxMessageImageBytes: 50 * 1024 * 1024 },
      async readImage(ref, signal) {
        calls.readImage.push({ ref, signal })
        if (overrides.readImage) return overrides.readImage(ref, signal)
        return { ref, data: new Uint8Array(PNG) }
      },
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
    systemPrompt: {
      section(definition) {
        promptSections.push(definition)
      },
    },
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
    _promptSections: promptSections,
    async _dispose() {
      while (effects.length > 0) await effects.pop()()
      active = false
    },
  }
  return ctx
}

/**
 * Mimic @deepseek-ai/cordis service resolution: reading a ctx property that is
 * neither an own property nor in the plugin's `inject` list throws
 * `cannot get property "<name>" without inject`. This is exactly the trap that
 * crashed this plugin at startup when the shipped-skill block read `ctx.skills`
 * ('skills' is not injected); services must be reached through `ctx.get(name)`.
 */
function createStrictCtx(config, extra = {}) {
  const base = createFakeCtx(config)
  const injected = new Set(['settings', 'credentials', 'attachments', 'llm', 'tools', 'systemPrompt'])
  const injectedStubs = { systemPrompt: { section() {} }, ...(extra.injected || {}) }
  const viaGet = { skills: extra.skills }
  const originalGet = base.get
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in target) {
        const value = Reflect.get(target, prop, receiver)
        if (prop === 'get') {
          return (name) => (name === 'skills' ? viaGet.skills : originalGet(name))
        }
        return value
      }
      if (injected.has(prop)) return injectedStubs[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

function fakeSession(messages, events = [], id = 's1') {
  return {
    id,
    // The current harness exposes the log through `snapshotEvents()`; there is
    // no `Session.events` array to read.
    snapshotEvents: () => events,
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

function modelSource(blockTypes) {
  return {
    provider: 'test-provider',
    model: 'test-model',
    replayState: {
      response: {
        kind: 'pi-ai',
        version: 2,
        api: 'openai-responses',
        provider: 'test-provider',
        model: 'test-model',
        stopReason: 'toolUse',
      },
      blocks: blockTypes.map((type) => ({ type })),
    },
  }
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
  assert.equal(tool.parameters.properties.referenceImageIds.type, 'array')
  assert.equal(tool.parameters.properties.referenceImageIds.items.type, 'string')

  const disabled = createFakeCtx({ ...CONFIG, enabled: false })
  await apply(disabled, { fetch: noNetworkFetch() })
  assert.equal(
    disabled._tools.registered.some((d) => d.name === 'generate_image'),
    false,
    'disabled plugin must not register the tool',
  )
})

test('AC1.1: generate_image output schema is accepted by the real dsh-tools validator (regression)', async () => {
  // tools.register() runs assertSupportedJsonSchema on output.schema; a schema
  // that fails it throws and the tool silently never reaches the agent's tool
  // list (seen in the field: per-property `required: true` was rejected).
  const ctx = createFakeCtx(CONFIG)
  await apply(ctx, { fetch: noNetworkFetch() })

  const tool = ctx._tools.registered.find((d) => d.name === 'generate_image')
  assert.ok(tool, 'generate_image must be registered while enabled')
  assert.doesNotThrow(
    () => assertSupportedJsonSchema(tool.output.schema),
    (error) => `output.schema must pass assertSupportedJsonSchema; got ${error instanceof JsonSchemaError ? error.violations.join('; ') : String(error)}`,
  )
  // Semantics must be preserved: every documented field is still required.
  assert.deepEqual(tool.output.schema.required, ['prompt', 'size', 'quality', 'count', 'images'])
  assert.deepEqual(tool.output.schema.properties.images.items.required, [
    'attachmentId',
    'mediaType',
    'bytes',
    'width',
    'height',
  ])
})

test('AC1.1b: count > 1 is split into multiple n=1 API requests', async () => {
  const b64 = base64Of(PNG)
  const seen = []
  const images = await generateImagesFromApi(
    { ...CONFIG, prompt: 'four versions', count: 2 },
    {
      fetch: async (url, init) => {
        seen.push({ url, init })
        return new Response(
          JSON.stringify({ data: [{ b64_json: b64 }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      },
    },
  )

  assert.equal(seen.length, 2, 'count > 1 must issue one n=1 request per image')
  for (const { init } of seen) {
    const body = JSON.parse(init.body)
    assert.equal(body.n, 1, 'every split request must use n=1')
  }
  assert.equal(images.length, 2)
})

test('AC1.2: apply must not crash on undeclared ctx access (regression: ctx.skills)', async () => {
  // DSH's cordis throws `cannot get property "<name>" without inject` for any
  // ctx property outside the plugin's inject list. The shipped-skill block
  // used to read `ctx.skills` (not injected) and crashed the fiber at startup;
  // the Settings route then vanished and the client fetch got the SPA HTML,
  // failing with "Unexpected token '<', \"<!doctype \"... is not valid JSON".
  // Skills must be read through ctx.get('skills') instead.
  const registeredSkills = []
  const ctx = createStrictCtx(CONFIG, {
    skills: {
      register(skill) {
        registeredSkills.push(skill)
        return () => {}
      },
    },
  })

  await assert.doesNotReject(
    apply(ctx, { fetch: noNetworkFetch() }),
    'apply must not throw on undeclared ctx.skills access',
  )

  // The shipped generate-image skill is registered through the safe path.
  assert.equal(registeredSkills.length, 1, 'shipped skill must be registered via ctx.get("skills")')
  assert.equal(registeredSkills[0].name, 'generate-image')
  // dsh-skill's loader requires a loaded definition to carry a string `source`
  // (skills.register defaults `provider` and `invocation`, but not `source`).
  assert.equal(typeof registeredSkills[0].source, 'string', 'shipped skill must carry a string source')
  assert.equal(typeof registeredSkills[0].content, 'string', 'shipped skill content must be a string')
  assert.ok(registeredSkills[0].content.length > 0, 'shipped skill body must be non-empty')
  assert.match(registeredSkills[0].content, /referenceImageIds/)
  assert.match(registeredSkills[0].content, /upload/i)

  const trigger = ctx._promptSections.find((section) => section.name === 'generate-image-trigger')
  assert.ok(trigger, 'image generation trigger guidance must be registered')
  assert.match(trigger.text(), /referenceImageIds/)
  assert.match(trigger.text(), /ask the user to upload one/)

  // The tool and Settings route are still wired up after the fix.
  const tool = ctx._tools.registered.find((d) => d.name === 'generate_image')
  assert.ok(tool, 'generate_image must still be registered')
  assert.equal(ctx._routes.length, 1, 'settings route must still be registered')
  assert.equal(ctx._routes[0].path, SETTINGS_ROUTE)
})

test('AC2: execute calls /images/generations (SSE), saves an attachment, renders image block', async () => {
  const b64 = base64Of(PNG)
  const ctx = createFakeCtx(CONFIG)
  const session = fakeSession([])
  const deferred = []
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
    {
      agent: { session },
      signal: new AbortController().signal,
      deferContext(context) {
        deferred.push(context)
      },
    },
  )

  assert.equal(value.images.length, 1)
  assert.equal(value.images[0].mediaType, 'image/png')
  assert.equal(value.images[0].bytes, PNG.length)
  assert.equal(value.count, 1)

  assert.equal(deferred.length, 0, 'image generation must never create a right-side user context')

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

test('AC2b: generated image displays on the left without duplicating model-visible tool calls', async () => {
  const b64 = base64Of(PNG)
  const ctx = createFakeCtx(CONFIG)
  const deferred = []
  const session = Session.create('s-left-image')
  const callId = 'call-left-image'
  const source = modelSource(['text', 'tool-call'])
  const original = session.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ source, content: [
        { type: 'text', text: 'original assistant text' },
        { type: 'tool-call', id: callId, name: 'generate_image', arguments: '{"prompt":"a puppy"}' },
      ] }),
      // A real harness settlement always embeds its compact stream.
      stream: [],
    },
    { surfaceOp: 'append' },
  )
  await apply(ctx, {
    fetch: async () => new Response(
      JSON.stringify({ data: [{ b64_json: b64 }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  })

  const tool = ctx._tools.registered.find((d) => d.name === 'generate_image')
  const value = await tool.execute(
    { prompt: 'a puppy' },
    {
      agent: { session, phase: { turn: 1, step: 1 } },
      deferContext(context) { deferred.push(context) },
    },
  )

  assert.equal(deferred.length, 0, 'left-side display must not create a right-side user context')
  const assistantEvents = sessionEvents(session).filter((event) => event.type === 'assistant/message')
  assert.equal(assistantEvents.length, 2, 'the original model message plus the UI display append')
  const display = assistantEvents[1]
  assert.equal(display.surfaceOp, 'append', 'the UI consumes the append event')
  const displayImages = display.data.message.content.filter((block) => block.type === 'image')
  assert.equal(displayImages.length, 1)
  assert.equal(displayImages[0].attachment.attachmentId, value.images[0].attachmentId)

  // The display append is a durable Assistant settlement, so it must carry the
  // settlement's `stream`. A streamless assistant/message crashes every consumer
  // that reads `event.data.stream` (TokenMeter's usageOf is the one that kills
  // the turn right after a generation) and makes the log unloadable.
  assert.deepEqual(display.data.stream, [], 'the display settlement carries an empty durable stream')

  // Regression: the whole log must survive the restore-time seed validation,
  // which requires an array `stream` on every assistant/message. Snapshot
  // construction appends one `session/end-seed` marker of its own.
  const live = sessionEvents(session)
  const restored = Session.create(
    's-left-image-restore',
    structuredClone(live),
    { ...session.header, id: 's-left-image-restore' },
  )
  const restoredEvents = restored.snapshotEvents()
  assert.equal(restoredEvents.length, live.length + 1, 'the log round-trips through seed validation')
  assert.deepEqual(restoredEvents[display.seq].data.stream, [], 'the display settlement keeps its stream after restore')

  // The shadow must be an empty system/message: the current harness rejects both a
  // replacement and sourceEventSeqs on assistant/message, which is exactly what used
  // to make this append fail so the generated image never reached the conversation.
  const shadows = sessionEvents(session).filter((event) => event.surfaceOp !== undefined && event.surfaceOp !== 'append')
  assert.equal(shadows.length, 1)
  const shadow = shadows[0]
  assert.equal(shadow.type, 'system/message')
  assert.deepEqual(shadow.surfaceOp, { op: 'replace', startSeq: display.seq, endSeq: display.seq })
  assert.deepEqual(shadow.sourceEventSeqs, [display.seq])
  assert.deepEqual(shadow.data.message.content, [], 'the shadow renders no UI row and carries no text')
  assert.deepEqual(shadow.data.message.source, { kind: 'plugin', plugin: 'generation-image' })
  assert.equal(session.surface.nodes.includes(display.seq), false, 'the display append leaves the model surface')
  assert.equal(session.surface.nodes.includes(original.seq), true, 'the model message stays on the surface')

  const derived = session.deriveMessages()
  assert.equal(derived.length, 1, 'the display append and its shadow stay off the model surface')
  const content = derived[0].content
  assert.equal(content.filter((block) => block.type === 'image').length, 0, 'UI-only image blocks must not alter model replay content')
  assert.equal(content.filter((block) => block.type === 'tool-call').length, 1, 'the tool call appears exactly once')
  assert.equal(content[0].type, 'text', 'the step original text content is preserved')
  assert.equal(content[0].text, 'original assistant text')
})

test('AC2c: four out-of-order concurrent generations keep one call set and four left-side images', async () => {
  const b64 = base64Of(PNG)
  const ctx = createFakeCtx(CONFIG)
  const delays = new Map([['one', 30], ['two', 5], ['three', 20], ['four', 10]])
  await apply(ctx, {
    fetch: async (_url, init) => {
      const prompt = JSON.parse(init.body).prompt
      await new Promise((resolve) => setTimeout(resolve, delays.get(prompt)))
      return new Response(
        JSON.stringify({ data: [{ b64_json: b64 }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    },
  })

  const tool = ctx._tools.registered.find((d) => d.name === 'generate_image')
  const prompts = ['one', 'two', 'three', 'four']
  const callIds = prompts.map((prompt) => `call-${prompt}`)
  const session = Session.create('s-concurrent-left-images')
  const source = modelSource(callIds.map(() => 'tool-call'))
  session.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ source, content: callIds.map((id, index) => ({
        type: 'tool-call',
        id,
        name: 'generate_image',
        arguments: JSON.stringify({ prompt: prompts[index] }),
      })) }),
    },
    { surfaceOp: 'append' },
  )

  const deferred = []
  const values = await Promise.all(prompts.map(async (prompt, index) => {
    const value = await tool.execute(
      { prompt },
      {
        agent: { session, phase: { turn: 1, step: 1 } },
        deferContext(context) { deferred.push(context) },
      },
    )
    // Append each tool result as soon as its generation finishes, so later
    // concurrent calls see an interleaved tool/result surface (the real-world
    // parallel-call ordering that previously dropped later display images).
    session.append(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: callIds[index],
          content: tool.output.render({}, value),
          isError: false,
        }),
      },
      { surfaceOp: 'append' },
    )
    return value
  }))

  assert.equal(deferred.length, 0, 'left-side display must not create right-side user contexts')
  const assistantEvents = sessionEvents(session).filter((event) => event.type === 'assistant/message')
  assert.equal(assistantEvents.length, 5, 'the model message plus one display append per generation')
  const displays = assistantEvents.slice(1)
  assert.deepEqual(displays.map((event) => event.surfaceOp), ['append', 'append', 'append', 'append'])
  const finalImages = displays.at(-1).data.message.content.filter((block) => block.type === 'image')
  assert.equal(finalImages.length, 4, 'the last display append stacks every generated image')
  assert.equal(new Set(finalImages.map((block) => block.attachment.attachmentId)).size, 4)

  // Every display append is shadowed by an empty system/message, so concurrent
  // generations never leave a duplicate tool call on the model surface.
  const shadows = sessionEvents(session).filter((event) => event.surfaceOp !== undefined && event.surfaceOp !== 'append')
  assert.equal(shadows.length, 4)
  for (const [index, shadow] of shadows.entries()) {
    assert.equal(shadow.type, 'system/message')
    assert.deepEqual(shadow.data.message.content, [])
    assert.deepEqual(shadow.sourceEventSeqs, [displays[index].seq])
  }
  assert.equal(session.surface.nodes.includes(assistantEvents[0].seq), true, 'the model message stays on the surface')

  const derived = session.deriveMessages()
  const assistants = derived.filter((message) => message.role === 'assistant')
  assert.equal(assistants.length, 1, 'all display appends must fold away from the model surface')
  assert.deepEqual(
    assistants[0].content.filter((block) => block.type === 'tool-call').map((block) => block.id),
    callIds,
  )
  assert.equal(assistants[0].content.filter((block) => block.type === 'image').length, 0)

  const results = derived.flatMap((message) => message.content.filter((block) => block.type === 'tool-result'))
  assert.deepEqual(
    results.map((result) => result.toolCallId).sort(),
    [...callIds].sort(),
    'all tool results must remain on the model surface regardless of completion order',
  )
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

test('AC3a: referenceImageIds sends ordered verified images to /images/edits and parses JSON or SSE', async () => {
  const b64 = base64Of(PNG)
  const firstId = AID('r1')
  const secondId = AID('r2')
  const session = fakeSession([], [{
    type: 'user/message',
    data: { message: { content: [makeImageBlock(firstId, 'first.png'), makeImageBlock(secondId, 'second.png')] } },
  }])
  const seen = []
  const ctx = createFakeCtx(CONFIG, {
    readImage(ref) {
      const marker = ref.attachmentId === firstId ? 1 : 2
      return { ref, data: new Uint8Array([...PNG, marker]) }
    },
  })
  await apply(ctx, {
    fetch: async (url, init) => {
      seen.push({ url, init })
      if (seen.length === 2) {
        return new Response(
          sseEvent('image_edit.completed', { b64_json: b64 }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        )
      }
      return new Response(
        JSON.stringify({ data: [{ b64_json: b64 }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    },
  })

  const tool = ctx._tools.registered.find((d) => d.name === 'generate_image')
  const value = await tool.execute(
    {
      prompt: 'combine both references on a white background',
      referenceImageIds: [secondId, firstId],
      size: '1024x1024',
      quality: 'high',
      count: 1,
    },
    { agent: { session }, signal: new AbortController().signal },
  )
  const streamed = await tool.execute(
    { prompt: 'restyle the first reference', referenceImageIds: [firstId] },
    { agent: { session } },
  )

  assert.equal(value.images.length, 1)
  assert.equal(streamed.images.length, 1)
  assert.equal(seen.length, 2)
  assert.match(seen[0].url, /\/images\/edits$/)
  assert.equal(seen[0].init.headers.Authorization, 'Bearer test-key')
  assert.equal(seen[0].init.headers['Content-Type'], undefined, 'fetch must add the multipart boundary')
  const form = seen[0].init.body
  assert.ok(form instanceof FormData)
  assert.equal(form.get('model'), 'gpt-image-2')
  assert.equal(form.get('prompt'), 'combine both references on a white background')
  assert.equal(form.get('n'), '1')
  assert.equal(form.get('size'), '1024x1024')
  assert.equal(form.get('quality'), 'high')
  assert.equal(form.get('stream'), 'true')
  assert.equal(form.get('partial_images'), '1')
  const files = form.getAll('image[]')
  assert.deepEqual(files.map((file) => file.name), ['second.png', 'first.png'])
  assert.deepEqual(
    await Promise.all(files.map(async (file) => [...new Uint8Array(await file.arrayBuffer())].slice(-1)[0])),
    [2, 1],
  )
  assert.deepEqual(ctx._calls.readImage.map((call) => call.ref.attachmentId), [secondId, firstId, firstId])
})

test('AC3b: invalid reference image lists fail before attachment reads or network I/O', async () => {
  const firstId = AID('r1')
  const secondId = AID('r2')
  const missingId = AID('missing')
  const session = fakeSession([], [{
    type: 'user/message',
    data: { message: { content: [makeImageBlock(firstId), makeImageBlock(secondId)] } },
  }])
  let fetches = 0
  const ctx = createFakeCtx(CONFIG, { imageLimits: { maxImagesPerMessage: 1 } })
  await apply(ctx, { fetch: async () => { fetches++; throw new Error('must not fetch') } })
  const tool = ctx._tools.registered.find((d) => d.name === 'generate_image')
  const exec = { agent: { session } }

  await assert.rejects(tool.execute({ prompt: 'edit', referenceImageIds: [] }, exec), /at least one/)
  await assert.rejects(tool.execute({ prompt: 'edit', referenceImageIds: [firstId, firstId] }, exec), /duplicates/)
  await assert.rejects(tool.execute({ prompt: 'edit', referenceImageIds: [firstId, secondId] }, exec), /1-image session limit/)
  await assert.rejects(tool.execute({ prompt: 'edit', referenceImageIds: [missingId] }, exec), /not available in this session/)
  assert.equal(ctx._calls.readImage.length, 0)
  assert.equal(fetches, 0)
})

test('AC3d: sessionEvents reads the current Session API', () => {
  const session = Session.create('s-session-events')
  session.append('user/message', {
    content: [makeImageBlock(AID('u1'), 'upload.png')],
    source: { kind: 'user', rpcId: 'rpc-1' },
    role: 'user',
    id: 'msg-1',
  }, { surfaceOp: 'append' })

  assert.equal(session.events, undefined, 'the harness exposes no Session.events array')
  assert.deepEqual(sessionEvents(session), session.snapshotEvents(), 'the log comes from snapshotEvents()')
  assert.equal(sessionEvents(session).length, 1)
  assert.equal(sessionEvents(undefined).length, 0)
  assert.equal(sessionEvents({}).length, 0)
})

test('AC3e: referenceImageIds resolves user uploads, inbox splices, bare hashes, and names what is missing', async () => {
  const b64 = base64Of(PNG)
  const uploadedId = AID('upload')
  const splicedId = AID('spliced')
  const session = Session.create('s-reference-shapes')
  // Exactly the two shapes the harness writes for a user turn: the message event
  // carries content directly, and the inbox splice nests it under `inserted`.
  session.append('user/message', {
    content: [makeImageBlock(uploadedId, 'user-upload.png')],
    source: { kind: 'user', rpcId: 'rpc-1' },
    role: 'user',
    id: 'msg-1',
  }, { surfaceOp: 'append' })
  session.append('agent/inbox/spliced', {
    target: 'next-turn',
    start: 0,
    inserted: [{ content: [makeImageBlock(splicedId, 'spliced.png')] }],
  })

  const refs = sessionImageRefs(session)
  assert.equal(refs.get(uploadedId).attachmentId, uploadedId)
  assert.equal(refs.get(splicedId).attachmentId, splicedId)
  assert.equal(
    refs.get(uploadedId.slice('sha256:'.length)).attachmentId,
    uploadedId,
    'a bare hash must address the same attachment as its sha256: form',
  )

  const seen = []
  const ctx = createFakeCtx(CONFIG)
  await apply(ctx, {
    fetch: async (url, init) => {
      seen.push({ url, init })
      return new Response(
        JSON.stringify({ data: [{ b64_json: b64 }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    },
  })
  const tool = ctx._tools.registered.find((d) => d.name === 'generate_image')
  const exec = { agent: { session } }

  // The model is told the prefixed id; a model that strips the prefix must still work,
  // and the spliced copy must be addressable too.
  const value = await tool.execute(
    { prompt: 'isolate the character on magenta', referenceImageIds: [uploadedId.slice('sha256:'.length), splicedId] },
    exec,
  )
  assert.equal(value.images.length, 1)
  assert.match(seen[0].url, /\/images\/edits$/)
  assert.deepEqual(ctx._calls.readImage.map((call) => call.ref.attachmentId), [uploadedId, splicedId])

  await assert.rejects(
    tool.execute({ prompt: 'edit', referenceImageIds: [AID('nope')] }, exec),
    (err) => {
      assert.match(err.message, /not available in this session/)
      assert.match(err.message, new RegExp(uploadedId.slice('sha256:'.length, 'sha256:'.length + 12)))
      return true
    },
    'a miss must name the ids that do exist',
  )
})

test('AC3c: size/quality are unrestricted — auto/empty is omitted, custom values pass through', async () => {
  const b64 = base64Of(PNG)
  const seen = []
  const ctx = createFakeCtx({ ...CONFIG, size: '', quality: 'auto' })
  await apply(ctx, {
    fetch: async (url, init) => {
      seen.push({ url, init })
      return new Response(
        JSON.stringify({ data: [{ b64_json: b64 }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    },
  })

  const tool = ctx._tools.registered.find((d) => d.name === 'generate_image')

  // default: no size in config, model passes nothing → 'auto' → fields omitted
  const autoValue = await tool.execute(
    { prompt: 'test' },
    { agent: { session: fakeSession([]) } },
  )
  let request = JSON.parse(seen[0].init.body)
  assert.equal(request.size, undefined)
  assert.equal(request.quality, undefined)
  assert.equal(autoValue.size, 'auto')
  assert.equal(autoValue.quality, 'auto')

  // explicit 'auto' arguments → omitted too
  await tool.execute(
    { prompt: 'test', size: 'auto', quality: 'auto' },
    { agent: { session: fakeSession([]) } },
  )
  request = JSON.parse(seen[1].init.body)
  assert.equal(request.size, undefined)
  assert.equal(request.quality, undefined)

  // custom/unrestricted values (any string) pass through verbatim
  await tool.execute(
    { prompt: 'test', size: '2048x2048', quality: 'hd' },
    { agent: { session: fakeSession([]) } },
  )
  request = JSON.parse(seen[2].init.body)
  assert.equal(request.size, '2048x2048')
  assert.equal(request.quality, 'hd')
})

test('AC4: nested (run_code) dispatch does not create a right-side image context', async () => {
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
  assert.equal(deferred.length, 0, 'nested dispatch must not create a right-side user bubble')
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

test('parseSseImageItems: collects b64 and url events, completed wins', () => {
  const b64 = base64Of(PNG)
  // partial url + completed url → completed wins
  const items = parseSseImageItems(
    sseEvent('image_generation.partial_image', { url: 'https://e/p.png' })
    + sseEvent('image_generation.completed', { url: 'https://e/final.png' }),
  )
  assert.deepEqual(items, [{ kind: 'url', url: 'https://e/final.png' }])

  // mixed b64 + url completed events keep order
  const mixed = parseSseImageItems(
    sseEvent('image_generation.completed', { b64_json: b64 })
    + sseEvent('image_generation.completed', { url: 'https://e/second.png' }),
  )
  assert.deepEqual(mixed, [
    { kind: 'b64', data: b64 },
    { kind: 'url', url: 'https://e/second.png' },
  ])

  // url-only partial still falls back
  const onlyPartial = parseSseImageItems(sseEvent('image_generation.partial_image', { url: 'https://e/p.png' }))
  assert.deepEqual(onlyPartial, [{ kind: 'url', url: 'https://e/p.png' }])
})

test('extractImageItemsFromJson: reads b64_json and url, tolerates bare url strings', () => {
  assert.deepEqual(
    extractImageItemsFromJson({ data: [{ b64_json: 'x' }, { url: 'https://e/x.png' }, 'https://e/y.png'] }),
    [
      { kind: 'b64', data: 'x' },
      { kind: 'url', url: 'https://e/x.png' },
      { kind: 'url', url: 'https://e/y.png' },
    ],
  )
  assert.deepEqual(extractImageItemsFromJson({}), [])
  assert.deepEqual(extractImageItemsFromJson({ data: [] }), [])
})

test('resolveImageItems: decodes b64 and downloads url (deduped)', async () => {
  const b64 = base64Of(PNG)
  let downloads = 0
  const resolved = await resolveImageItems(
    [
      { kind: 'b64', data: b64 },
      { kind: 'url', url: 'https://e/out.png' },
      { kind: 'url', url: 'https://e/out.png' }, // dedup: downloaded once
    ],
    {
      fetch: async (url) => {
        downloads++
        assert.equal(url, 'https://e/out.png')
        return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } })
      },
    },
  )
  assert.equal(resolved.length, 2)
  assert.equal(resolved[0].mediaType, 'image/png')
  assert.deepEqual(resolved[0].data, new Uint8Array(PNG))
  assert.equal(resolved[1].mediaType, 'image/png')
  assert.equal(downloads, 1)
})

test('AC2d: execute downloads SSE url payloads and saves an attachment', async () => {
  const ctx = createFakeCtx(CONFIG)
  const seen = []
  await apply(ctx, {
    fetch: async (url, init) => {
      seen.push({ url, init })
      if (seen.length === 1) {
        return new Response(
          sseEvent('image_generation.completed', { url: 'https://img.example.com/out.png' })
          + 'data: [DONE]\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        )
      }
      assert.equal(url, 'https://img.example.com/out.png', 'second fetch must download the image URL')
      return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } })
    },
  })

  const tool = ctx._tools.registered.find((d) => d.name === 'generate_image')
  const value = await tool.execute(
    { prompt: 'a red ball' },
    { agent: { session: fakeSession([]) } },
  )
  assert.equal(value.images.length, 1)
  assert.equal(value.images[0].mediaType, 'image/png')
  assert.equal(value.images[0].bytes, PNG.length)
  assert.equal(seen.length, 2, 'one generation POST + one URL download')
  assert.equal(ctx._calls.saveImage.length, 1, 'downloaded image must be saved as an attachment')
})

test('AC3d: execute downloads plain JSON url payloads', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0, 0, 0, 0, 0, 0, 0, 0])
  const ctx = createFakeCtx(CONFIG)
  const seen = []
  await apply(ctx, {
    fetch: async (url, init) => {
      seen.push({ url, init })
      if (seen.length === 1) {
        return new Response(
          JSON.stringify({ data: [{ url: 'https://img.example.com/out.jpg' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      assert.equal(url, 'https://img.example.com/out.jpg')
      return new Response(jpeg, { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
    },
  })

  const tool = ctx._tools.registered.find((d) => d.name === 'generate_image')
  const value = await tool.execute(
    { prompt: 'a blue sky' },
    { agent: { session: fakeSession([]) } },
  )
  assert.equal(value.images.length, 1)
  assert.equal(value.images[0].mediaType, 'image/jpeg')
  assert.equal(seen.length, 2)
})

test('AC2e: a failing URL download surfaces a readable error', async () => {
  const ctx = createFakeCtx(CONFIG)
  let fetchCalls = 0
  await apply(ctx, {
    fetch: async (url) => {
      fetchCalls++
      if (fetchCalls === 1) {
        return new Response(
          sseEvent('image_generation.completed', { url: 'https://img.example.com/broken.png' })
          + 'data: [DONE]\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        )
      }
      return new Response('bad gateway', { status: 502 })
    },
  })

  const tool = ctx._tools.registered.find((d) => d.name === 'generate_image')
  await assert.rejects(
    tool.execute({ prompt: 'a broken link' }, { agent: { session: fakeSession([]) } }),
    /failed to download the generated image from https:\/\/img\.example\.com\/broken\.png/,
  )
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

test('normalizeRequestedSize maps 4K aliases to 3840x2160 and keeps real sizes', () => {
  assert.equal(normalizeRequestedSize('3840x2160'), '3840x2160')
  assert.equal(normalizeRequestedSize('3840×2160'), '3840x2160')
  assert.equal(normalizeRequestedSize('4K'), '3840x2160')
  assert.equal(normalizeRequestedSize('3840x3840'), '3840x3840')
  assert.equal(normalizeRequestedSize('1024x1024'), '1024x1024')
  assert.equal(normalizeRequestedSize(''), '')
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

test('imageMarker points the model at generate_image and nothing else', () => {
  const block = { type: 'image', attachment: { attachmentId: AID('v1'), name: 'shot.png' } }
  const text = imageMarker(block).text
  assert.ok(!text.includes('vision_describe'), 'no other plugin tool may be advertised')
  assert.ok(text.includes(`generate_image 并传入 referenceImageIds: ["${AID('v1')}"]`), 'the generate_image hint stays')
  assert.ok(!text.includes('undefined'), 'no placeholder leaks into the marker')
})

test('rewriteImageBlocksToMarkers rewrites images nested in tool-result content', () => {
  const message = {
    role: 'user',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        content: [{ type: 'image', attachment: { attachmentId: AID('v3') } }],
      },
    ],
  }
  const rewritten = rewriteImageBlocksToMarkers(message)
  const flat = JSON.stringify(rewritten)
  assert.ok(!flat.includes('"type":"image"'), 'the nested image block is replaced')
  assert.ok(flat.includes(AID('v3')), 'the marker still names the attachment')
  assert.equal(rewritten.content[0].type, 'tool-result', 'the tool-result envelope survives')
})

test('resolveMarkerMode defaults to native and only "always" keeps the legacy rewrite', () => {
  assert.equal(resolveMarkerMode({}), 'native')
  assert.equal(resolveMarkerMode({ mode: 'native' }), 'native')
  assert.equal(resolveMarkerMode({ mode: 'garbage' }), 'native')
  assert.equal(resolveMarkerMode({ mode: 'always' }), 'always')
  assert.equal(resolveMarkerMode({ mode: ' ALWAYS ' }), 'always')
})

test('shouldRewriteImages leaves an image-capable route alone outside legacy mode', () => {
  assert.equal(shouldRewriteImages({ mode: 'native' }, true), false, 'vision model keeps its images')
  assert.equal(shouldRewriteImages({ mode: 'native' }, false), true, 'text-only model gets markers')
  assert.equal(shouldRewriteImages({ mode: 'always' }, true), true, 'legacy mode always rewrites')
  assert.equal(shouldRewriteImages({}, true), false, 'default is native')
})

test('routeHasNativeImage reads the catalog and answers true when unknown', async () => {
  assert.equal(normalizeRoute('a6api', 'deepseek-v4.1-flash').model, 'deepseek-v4.1-flash')
  assert.equal(normalizeRoute('', 'm'), undefined)
  assert.equal(normalizeRoute('p', undefined), undefined)
  const imageCtx = { llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) } }
  const textCtx = { llm: { resolveModelInfo: async () => ({ inputModalities: ['text'] }) } }
  const boomCtx = { llm: { resolveModelInfo: async () => { throw new Error('nope') } } }
  assert.equal(await routeHasNativeImage(imageCtx, { provider: 'p', model: 'm' }), true)
  assert.equal(await routeHasNativeImage(textCtx, { provider: 'p', model: 'm' }), false)
  assert.equal(await routeHasNativeImage(boomCtx, { provider: 'p', model: 'm' }), true, 'a failed lookup must not destroy the image')
  assert.equal(await routeHasNativeImage(imageCtx, undefined), true, 'no route known → non-lossy default')
  assert.equal(await routeHasNativeImage({}, { provider: 'p', model: 'm' }), true, 'no llm service → non-lossy default')
})

test('a multimodal route keeps its real image blocks through the apply() pipeline', async () => {
  const ctx = createFakeCtx(CONFIG, {
    resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
  })
  const session = fakeSession([{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: AID('n1') } }] }])
  const agent = { session }
  await apply(ctx, { fetch: noNetworkFetch() })

  const onRequest = ctx._handlers.get('agent/request')
  assert.ok(onRequest, 'agent/request handler must be registered for route tracking')
  await onRequest({ agent }, async () => ({ provider: 'a6api', model: 'deepseek-v4.1-flash' }))
  const preStep = ctx._handlers.get('agent/pre-step')
  await preStep({ agent }, async () => ({ kind: 'enter', messages: [] }))

  const derived = session.deriveMessages()
  assert.ok(!(derived instanceof Promise), 'deriveMessages must stay synchronous — the agent loop never awaits it')
  assert.equal(contentHasImage(derived[0].content), true, 'a vision route must receive the actual image block')
  assert.ok(!JSON.stringify(derived).includes('附件 id'), 'no marker may replace a readable image')
})

test('a text-only verdict still replaces the image (decision + replacement unit proof)', async () => {
  // The apply() pipeline cannot be driven to a text-only verdict from this
  // harness: the injected `llm` service resolves model metadata through the
  // real catalog, so a stubbed `resolveModelInfo` result is not authoritative.
  // The gate itself is therefore pinned here at the unit level — a text-only
  // verdict must reach the marker replacement, and a vision verdict must not.
  const cfg = { mode: 'native' }
  const session = fakeSession([{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: AID('t1') } }] }])
  const messages = session.deriveMessages()

  const textOnlyVerdict = await routeHasNativeImage(
    { llm: { resolveModelInfo: async () => ({ inputModalities: ['text'] }) } },
    { provider: 'p', model: 'm' },
  )
  assert.equal(textOnlyVerdict, false)
  assert.equal(shouldRewriteImages(cfg, textOnlyVerdict), true, 'a text-only verdict must rewrite')
  const rewritten = messages.map((m) => rewriteImageBlocksToMarkers(m))
  assert.equal(contentHasImage(rewritten[0].content), false, 'the text-only path still produces markers')
  assert.ok(rewritten[0].content.some((b) => b.type === 'text' && b.text.includes(AID('t1'))))
  assert.equal(contentHasImage(messages[0].content), true, 'the original message object stays untouched')
})

test('mode: always keeps rewriting even for a multimodal route', async () => {
  const ctx = createFakeCtx({ ...CONFIG, mode: 'always' }, {
    resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
  })
  const session = fakeSession([{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: AID('a1') } }] }])
  const agent = { session }
  await apply(ctx, { fetch: noNetworkFetch() })

  await ctx._handlers.get('agent/request')({ agent }, async () => ({ provider: 'a6api', model: 'deepseek-v4.1-flash' }))
  await ctx._handlers.get('agent/pre-step')({ agent }, async () => ({ kind: 'enter', messages: [] }))

  const derived = session.deriveMessages()
  assert.equal(contentHasImage(derived[0].content), false, 'legacy mode rewrites regardless of capability')
})

// restore the config-path env so later tests (if any) are isolated
test.after(() => {
  if (PREV_CONFIG === undefined) delete process.env.DSH_GENERATION_IMAGE_CONFIG
  else process.env.DSH_GENERATION_IMAGE_CONFIG = PREV_CONFIG
})
