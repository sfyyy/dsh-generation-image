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

  assert.equal(deferred.length, 0, 'left-side display must not fall back to deferContext')
  const assistantEvents = session.events.filter((event) => event.type === 'assistant/message')
  assert.equal(assistantEvents.length, 3, 'original, UI append, and model-surface replacement')
  const display = assistantEvents[1]
  const replacement = assistantEvents[2]
  assert.equal(display.surfaceOp, 'append', 'the UI consumes the append event')
  assert.equal(display.data.message.content.filter((block) => block.type === 'image').length, 1)
  assert.equal(display.data.message.source.replayState, undefined, 'changed UI content must not claim replay fidelity')
  assert.deepEqual(replacement.surfaceOp, { op: 'replace', start: original.seq, end: display.seq })
  assert.deepEqual(replacement.sourceEventSeqs, [original.seq, display.seq])
  assert.deepEqual(replacement.data.message.source, original.data.message.source)
  assert.deepEqual(replacement.data.message.content, original.data.message.content)
  assert.doesNotThrow(
    () => Session.create('s-left-image-reload', session.events),
    'persisted replacement events must remain valid after session reload',
  )

  const derived = session.deriveMessages()
  assert.equal(derived.length, 1, 'the model surface keeps one assistant message')
  const content = derived[0].content
  const imageBlocks = content.filter((block) => block.type === 'image')
  assert.equal(imageBlocks.length, 0, 'UI-only image blocks must not alter model replay content')
  const displayImage = display.data.message.content.find((block) => block.type === 'image')
  assert.equal(displayImage.attachment.attachmentId, value.images[0].attachmentId)
  assert.equal(content[0].type, 'text', 'the step original text content is preserved (merged)')
  assert.equal(content[0].text, 'original assistant text')
  assert.equal(content.filter((block) => block.type === 'tool-call').length, 1)
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
  const values = await Promise.all(prompts.map((prompt) => tool.execute(
    { prompt },
    {
      agent: { session, phase: { turn: 1, step: 1 } },
      deferContext(context) { deferred.push(context) },
    },
  )))

  for (let i = 0; i < callIds.length; i++) {
    session.append(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: callIds[i],
          content: tool.output.render({}, values[i]),
          isError: false,
        }),
      },
      { surfaceOp: 'append' },
    )
  }

  assert.equal(deferred.length, 0)
  const derived = session.deriveMessages()
  const assistants = derived.filter((message) => message.role === 'assistant')
  assert.equal(assistants.length, 1, 'all UI appends must fold into one model assistant message')
  assert.deepEqual(
    assistants[0].content.filter((block) => block.type === 'tool-call').map((block) => block.id),
    callIds,
  )
  assert.equal(assistants[0].content.filter((block) => block.type === 'image').length, 0)

  const displayEvents = session.events.filter(
    (event) => event.type === 'assistant/message' && event.surfaceOp === 'append'
      && event.data.message.content.some((block) => block.type === 'image'),
  )
  const images = displayEvents.at(-1).data.message.content.filter((block) => block.type === 'image')
  assert.equal(displayEvents.length, 4)
  assert.equal(images.length, 4)
  assert.equal(new Set(images.map((block) => block.attachment.attachmentId)).size, 4)

  const results = derived.flatMap((message) => message.content.filter((block) => block.type === 'tool-result'))
  assert.deepEqual(results.map((result) => result.toolCallId), callIds)
  assert.equal(session.events.filter((event) => event.type === 'assistant/message' && event.surfaceOp === 'append').length, 5)
  assert.equal(session.events.filter((event) => event.type === 'assistant/message' && event.surfaceOp !== 'append').length, 4)
  const finalReplacement = session.events.filter(
    (event) => event.type === 'assistant/message' && event.surfaceOp !== 'append',
  ).at(-1)
  assert.deepEqual(finalReplacement.data.message.source, session.events[0].data.message.source)
  assert.deepEqual(finalReplacement.data.message.content, session.events[0].data.message.content)
  assert.doesNotThrow(
    () => Session.create('s-concurrent-left-images-reload', session.events),
    'concurrent replacement history must remain valid after session reload',
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
      count: 2,
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
  assert.equal(form.get('n'), '2')
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
