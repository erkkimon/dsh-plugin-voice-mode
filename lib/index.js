//#region host half
/**
 * Voice mode plugin, node half. Same-origin routes for the browser half:
 *
 *   POST /voice/stt   raw WebM body      -> whisper-stt (Parakeet) -> { text }
 *   POST /voice/tts   { text }           -> deterministic cleanup -> disk cache
 *                                           -> OmniVoice (donna)   -> audio/wav
 *   POST /voice/wand  { text }           -> current chat model (llm service),
 *                                           restructured draft     -> { text }
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

    const spoken = cleanForSpeech(text.slice(0, MAX_SPEAK_CHARS))
    const key = cacheKey(spoken)
    const cached = cachePath(key)
    try {
      const wav = fs.readFileSync(cached)
      res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-cache', 'x-voice-cache': 'hit' })
      res.end(wav)
      return
    } catch {
      // cache miss — synthesize below
    }

    const upstream = await fetch(TTS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: spoken, voice: TTS_VOICE, response_format: 'wav' }),
      signal: abortOnClose(res),
    })
    if (!upstream.ok) return sendJson(res, 502, { error: `tts upstream http ${upstream.status}` })
    const wav = Buffer.from(await upstream.arrayBuffer())
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true })
      fs.writeFileSync(cached, wav)
      pruneCache()
    } catch {
      // a cache write failure must not cost the user their audio
    }
    res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-cache', 'x-voice-cache': 'miss' })
    res.end(wav)
  } catch (error) {
    sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
  }
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
