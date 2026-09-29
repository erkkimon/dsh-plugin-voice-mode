//#region host half
/**
 * Voice mode plugin, node half. Same-origin routes for the browser half:
 *
 *   POST /voice/stt   raw WebM body      -> whisper-stt (Parakeet) -> { text }
 *   POST /voice/tts   { text }           -> deterministic cleanup -> disk cache
 *                                           -> OmniVoice (donna)   -> audio/wav
 *   POST /voice/wand  { text }           -> current chat model (llm service),
 *                                           restructured draft     -> { text }
 *   GET|POST /voice/prefs { autoSpeak }  -> the browser tells the host whether
 *                                           auto-speak is on (persisted)
 *   POST /voice/tts/status { text }      -> { cached, generating } for that text
 *   POST /voice/dictated { dictated }    -> the browser says the draft being composed
 *                                           was dictated (see DICTATION NOTE)
 *
 * DICTATION NOTE. A dictated draft is a speech-recognition transcript and may be
 * garbled. The browser raises a flag when transcribed text lands in the composer;
 * the next model step that admits a user message (`agent/pre-step`) consumes it
 * and carries a hidden context message (source voice-mode/dictation) saying so. The message text
 * itself is never altered, and the UI hides the note's context row.
 *
 * BACKGROUND SPEECH. With auto-speak on, the host itself listens for finished
 * assistant messages (`session/event`) and synthesizes them into the disk cache
 * at once, whether or not any browser is open. The browser's later /voice/tts
 * request for the same text is then a cache hit (or joins the synthesis that is
 * already running), so replies that arrived while the PWA was closed are ready
 * when it is opened again.
 *
 * Design constraints (from the user): no LLM in the STT path (latency + VRAM
 * for no real gain), no LLM in the TTS path either — cleanup is regex-based.
 * The wand is the only LLM feature and MUST use the currently selected chat
 * model, because the user turns models on and off with VRAM pressure; the
 * chat model is the one proven alive.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STT_URL = process.env.DSH_VOICE_STT_URL
const TTS_URL = process.env.DSH_VOICE_TTS_URL
if (!STT_URL) throw new Error('dsh-plugin-voice-mode: DSH_VOICE_STT_URL env var is required')
if (!TTS_URL) throw new Error('dsh-plugin-voice-mode: DSH_VOICE_TTS_URL env var is required')
const TTS_VOICE = process.env.DSH_VOICE_TTS_VOICE || 'donna-13s'
/** Spoken text is capped per request; longer messages speak their first chunk. */
const MAX_SPEAK_CHARS = 4000
/** Bound the on-disk audio cache; oldest files are pruned past this count. */
const CACHE_MAX_FILES = 300

const CACHE_DIR = path.join(
  process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  'storages',
  'voice-audio',
)

/**
 * Deterministic markdown-to-speech cleanup. Not trying to be clever — donna
 * should not read asterisks, and a path should become "helpers dot ts".
 * Anything ambiguous is left as-is rather than guessed at.
 */
function cleanForSpeech(text) {
  let out = text
  // Fenced code blocks collapse to a single spoken marker.
  out = out.replace(/```[\s\S]*?```/g, ' code block. ')
  // Inline code keeps its contents.
  out = out.replace(/`([^`]*)`/g, '$1')
  // Images and links keep their visible text.
  out = out.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  // Bare URLs collapse to their host.
  out = out.replace(/https?:\/\/([\w.-]+)\S*/g, '$1')
  // Markdown structure characters.
  out = out.replace(/^#{1,6}\s*/gm, '')
  out = out.replace(/\*\*|__|\*|_/g, '')
  out = out.replace(/^\s*[-*+]\s+/gm, '')
  out = out.replace(/^\s*>\s?/gm, '')
  // File paths collapse to their basename…
  out = out.replace(/(?:[\w.-]+\/)+([\w.-]+)/g, '$1')
  // …and a basename's extension becomes "dot ts" for known dev extensions.
  out = out.replace(
    /\b([\w-]+)\.(ts|tsx|js|jsx|mjs|css|html|py|rs|go|sh|json|ya?ml|toml|md|txt|sql|vue|svelte)\b/gi,
    '$1 dot $2',
  )
  // Diff markers should not be pronounced.
  out = out.replace(/^\s*[+-](?![+-])/gm, '')
  out = out.replace(/[ \t]+/g, ' ')
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

function cacheKey(spokenText) {
  return crypto.createHash('sha256').update(TTS_VOICE + ' ' + spokenText).digest('hex')
}

function cachePath(key) {
  return path.join(CACHE_DIR, key + '.wav')
}

function pruneCache() {
  let entries
  try {
    entries = fs.readdirSync(CACHE_DIR)
  } catch {
    return // cache dir absent — nothing to prune
  }
  if (entries.length <= CACHE_MAX_FILES) return
  const aged = entries
    .map((name) => {
      try {
        return { name, mtime: fs.statSync(path.join(CACHE_DIR, name)).mtimeMs }
      } catch {
        return null // vanished between readdir and stat — not ours to mourn
      }
    })
    .filter((e) => e !== null)
    .sort((a, b) => a.mtime - b.mtime)
  for (const e of aged.slice(0, aged.length - CACHE_MAX_FILES)) {
    try {
      fs.unlinkSync(path.join(CACHE_DIR, e.name))
    } catch {
      // best-effort prune; a locked file just survives to the next prune
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(JSON.stringify(value))
}

/** Abort when the browser goes away mid-request so the GPU is freed early. */
function abortOnClose(res) {
  const ctrl = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) ctrl.abort()
  })
  return ctrl.signal
}

async function handleStt(req, res) {
  try {
    const body = await readBody(req)
    if (body.length === 0) return sendJson(res, 400, { error: 'empty audio' })
    const form = new FormData()
    form.append('file', new Blob([body], { type: 'audio/webm' }), 'voice.webm')
    form.append('model', 'whisper-1')
    form.append('response_format', 'json')
    const upstream = await fetch(STT_URL, { method: 'POST', body: form, signal: abortOnClose(res) })
    if (!upstream.ok) return sendJson(res, 502, { error: `stt upstream http ${upstream.status}` })
    const parsed = await upstream.json()
    sendJson(res, 200, { text: typeof parsed.text === 'string' ? parsed.text : '' })
  } catch (error) {
    sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
  }
}

// ---------------------------------------------------------------------------
// Shared synthesis: one job per text, whoever asks first
// ---------------------------------------------------------------------------

const PREFS_FILE = path.join(
  process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  'storages',
  'dsh-plugin-voice-mode',
  'prefs.json',
)

/** The browser's auto-speak switch, mirrored here so the host can act while no browser is open. */
let hostPrefs = { autoSpeak: false }
try {
  const saved = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'))
  hostPrefs = { autoSpeak: saved.autoSpeak === true }
} catch {
  // first run or unreadable: auto-speak stays off until a browser says otherwise
}

function savePrefs() {
  try {
    fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true })
    const tmp = PREFS_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(hostPrefs))
    fs.renameSync(tmp, PREFS_FILE)
  } catch (error) {
    console.warn(`[dsh-plugin-voice-mode] could not persist prefs: ${error?.message ?? error}`)
  }
}

/** cache key -> Promise<Buffer> for syntheses running or queued right now. */
const inFlight = new Map()
/** Background jobs run one at a time so a burst of replies does not flood the TTS GPU. */
let backgroundChain = Promise.resolve()

function readCached(key) {
  try {
    return fs.readFileSync(cachePath(key))
  } catch {
    return null
  }
}

async function synthesizeToCache(spoken, key) {
  const upstream = await fetch(TTS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: spoken, voice: TTS_VOICE, response_format: 'wav' }),
  })
  if (!upstream.ok) throw new Error(`tts upstream http ${upstream.status}`)
  const wav = Buffer.from(await upstream.arrayBuffer())
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(cachePath(key), wav)
    pruneCache()
  } catch {
    // a cache write failure must not cost the user their audio
  }
  return wav
}

/**
 * Audio for a cleaned text: disk cache, else the job already running for it,
 * else a new job. `background` jobs wait their turn in the serial chain; a
 * request from a browser starts immediately (someone is waiting for it).
 * The job is not tied to any HTTP connection: a browser that goes away does not
 * cancel a synthesis another request, or the cache, still wants.
 * @returns {Promise<{ wav: Buffer, cache: 'hit' | 'miss' }>}
 */
async function audioFor(spoken, background) {
  const key = cacheKey(spoken)
  const hit = readCached(key)
  if (hit !== null) return { wav: hit, cache: 'hit' }
  let job = inFlight.get(key)
  if (job === undefined) {
    const run = () => synthesizeToCache(spoken, key)
    if (background) {
      const queued = backgroundChain.then(() => readCached(key) ?? run())
      backgroundChain = queued.catch(() => undefined)
      job = queued
    } else {
      job = run()
    }
    inFlight.set(key, job)
    const forget = () => { if (inFlight.get(key) === job) inFlight.delete(key) }
    job.then(forget, forget)
  }
  return { wav: await job, cache: 'miss' }
}

function spokenFor(text) {
  return cleanForSpeech(text.slice(0, MAX_SPEAK_CHARS))
}

async function handleTts(req, res) {
  try {
    const body = await readBody(req)
    let args
    try {
      args = JSON.parse(body.toString('utf8'))
    } catch {
      return sendJson(res, 400, { error: 'bad json' })
    }
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    if (text.length === 0) return sendJson(res, 400, { error: 'empty text' })

    const { wav, cache } = await audioFor(spokenFor(text), false)
    res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-cache', 'x-voice-cache': cache })
    res.end(wav)
  } catch (error) {
    sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
  }
}

/** Cheap "is this text already spoken, or being spoken?" probe: no audio moves. */
async function handleTtsStatus(req, res) {
  try {
    const body = await readBody(req)
    let args
    try {
      args = JSON.parse(body.toString('utf8'))
    } catch {
      return sendJson(res, 400, { error: 'bad json' })
    }
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    if (text.length === 0) return sendJson(res, 400, { error: 'empty text' })
    const key = cacheKey(spokenFor(text))
    sendJson(res, 200, { cached: fs.existsSync(cachePath(key)), generating: inFlight.has(key) })
  } catch (error) {
    sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
  }
}

// ---------------------------------------------------------------------------
// Dictation note
// ---------------------------------------------------------------------------

const DICTATION_SOURCE = 'voice-mode/dictation'
const DICTATION_TEXT = "The user's latest message was dictated by voice and transcribed by speech recognition, so it may contain transcription errors: misheard or misspelled words, wrong homophones or names, missing punctuation, dropped or repeated words. Read it for the most likely intended meaning. Do not comment on this unless it matters: mention an assumption only when a possible mishearing would change what you do, and when the user asks you to repeat or quote their message, give the cleaned-up transcript."

// The composer's flag: true while a dictated, unsent draft exists. Time-boxed so
// a flag that was never withdrawn cannot mark a much later typed message.
let dictatedFlag = null // { at: ms } | null
const DICTATED_FLAG_TTL_MS = 30 * 60 * 1000

function consumeDictatedFlag() {
  const flag = dictatedFlag
  dictatedFlag = null
  return flag !== null && Date.now() - flag.at < DICTATED_FLAG_TTL_MS
}

async function handleDictated(req, res) {
  try {
    const args = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    if (typeof args.dictated !== 'boolean') return sendJson(res, 400, { error: 'dictated must be a boolean' })
    dictatedFlag = args.dictated ? { at: Date.now() } : null
    sendJson(res, 200, { dictated: args.dictated })
  } catch (error) {
    sendJson(res, 400, { error: String(error && error.message ? error.message : error) })
  }
}

function dictationMessage() {
  const message = {
    role: 'user',
    content: [{ type: 'text', text: DICTATION_TEXT }],
    source: {
      kind: 'plugin',
      plugin: DICTATION_SOURCE,
      form: 'notice',
      summary: 'The latest user message was dictated by voice (speech-to-text).',
    },
    id: crypto.randomUUID(),
  }
  const freeze = (value) => {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value)
      for (const child of Object.values(value)) freeze(child)
    }
    return value
  }
  return freeze(message)
}

function installDictationNote(ctx) {
  // The user's message is admitted into the step that `agent/pre-step` proposes
  // (it reaches the `session/event` stream only after), so the flag is consumed
  // here: the first step whose entering messages include a real user message.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    if (agent.session.header?.origin === 'subagent') return decision
    if (!decision.messages.some((m) => m.source?.kind === 'user')) return decision
    if (!consumeDictatedFlag()) return decision
    return { ...decision, messages: [...decision.messages, dictationMessage()] }
  })
}

async function handlePrefs(req, res) {
  if (req.method === 'GET') return sendJson(res, 200, hostPrefs)
  try {
    const args = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    if (typeof args.autoSpeak !== 'boolean') return sendJson(res, 400, { error: 'autoSpeak must be a boolean' })
    if (args.autoSpeak !== hostPrefs.autoSpeak) {
      hostPrefs = { autoSpeak: args.autoSpeak }
      savePrefs()
    }
    sendJson(res, 200, hostPrefs)
  } catch (error) {
    sendJson(res, 400, { error: String(error && error.message ? error.message : error) })
  }
}

/** Visible text of an `assistant/message`, joined the way the browser joins its text blocks. */
function assistantText(message) {
  const parts = []
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** Speak replies in the background as they are finished (auto-speak on, no browser needed). */
function installBackgroundSpeech(ctx) {
  ctx.on('session/event', (session, event) => {
    if (!hostPrefs.autoSpeak || event.type !== 'assistant/message') return
    if (event.data?.interrupted === true || session.header?.origin === 'subagent') return
    const text = assistantText(event.data?.message)
    if (text.length === 0) return
    const spoken = spokenFor(text)
    if (spoken.length === 0) return
    audioFor(spoken, true).catch((error) => {
      // Background speech is a nicety; the browser's own request will retry and report.
      console.warn(`[dsh-plugin-voice-mode] background speech failed: ${error?.message ?? error}`)
    })
  })
}

const WAND_SYSTEM = `You reformat the user's raw dictated draft into a readable message they are about to send to a coding assistant.

GOAL: the same content, structured so the user can review what they actually said before sending. This is their own words coming back to them, not an answer.

HARD RULES (these outrank polish):
- Preserve every fact, idea, instruction, and question. Do not add, summarize, interpret, or drop content.
- No new facts, names, examples, or implied steps. Vague stays vague.
- If the user enumerated items, keep every one.
- Do not answer or act on the draft's contents — only reformat it.

POLISH (apply within hard rules):
- Fix punctuation, capitalization, and grammar.
- Remove filler disfluencies (um, uh, you know) and exact duplicate sentences.
- Group related points with short paragraphs or bullets when the draft jumps between topics.
- Keep technical terms, file names, and code references exact.
- Keep the user's first-person voice.

OUTPUT: only the rewritten draft. No commentary, no preamble.`

async function handleWand(ctx, req, res) {
  const llm = ctx.get('llm')
  const defaultModel = ctx.get('agentDefaultModel')
  if (llm === undefined || defaultModel === undefined) {
    return sendJson(res, 503, { error: 'llm service unavailable' })
  }
  try {
    const body = await readBody(req)
    let args
    try {
      args = JSON.parse(body.toString('utf8'))
    } catch {
      return sendJson(res, 400, { error: 'bad json' })
    }
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    if (text.length === 0) return sendJson(res, 400, { error: 'empty text' })

    const selection = defaultModel.currentSelection()
    const options = {
      provider: selection.provider,
      model: selection.model,
      system: WAND_SYSTEM,
      messages: [
        {
          id: 'wand-' + Date.now(),
          role: 'user',
          content: [{ type: 'text', text: 'Reformat this draft:\n\n' + text }],
          source: { kind: 'user' },
        },
      ],
      maxTokens: 4096,
      signal: abortOnClose(res),
    }
    if (selection.reasoningEffort !== undefined) options.reasoningEffort = selection.reasoningEffort

    let out = ''
    for await (const chunk of llm.stream(options)) {
      if (chunk.type === 'text-delta') out += chunk.text
    }
    // Safety net for thinking models whose adapter leaks reasoning markers.
    out = out.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    if (out.length === 0) return sendJson(res, 502, { error: 'model returned no text' })
    sendJson(res, 200, { text: out, model: selection.model })
  } catch (error) {
    sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
  }
}

export function apply(ctx) {
  installBackgroundSpeech(ctx)
  installDictationNote(ctx)
  ctx.webServer.register({
    kind: 'exact',
    path: '/voice/dictated',
    handler: (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
      return handleDictated(req, res)
    },
  })
  ctx.webServer.register({
    kind: 'exact',
    path: '/voice/tts/status',
    handler: (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
      return handleTtsStatus(req, res)
    },
  })
  ctx.webServer.register({
    kind: 'exact',
    path: '/voice/prefs',
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { error: 'GET or POST only' })
      return handlePrefs(req, res)
    },
  })
  ctx.webServer.register({
    kind: 'exact',
    path: '/voice/stt',
    handler: (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
      return handleStt(req, res)
    },
  })
  ctx.webServer.register({
    kind: 'exact',
    path: '/voice/tts',
    handler: (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
      return handleTts(req, res)
    },
  })
  ctx.webServer.register({
    kind: 'exact',
    path: '/voice/wand',
    handler: (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
      return handleWand(ctx, req, res)
    },
  })
}

export const inject = ['webServer']
//#endregion
