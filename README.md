# dsh-plugin-voice-mode

Voice mode for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI — dictate messages, hear replies, and drive the composer without touching the keyboard.

The UI mirrors the voice UX of a mobile chat app: a big red record button straddling the composer's top edge, flanked inside the padded zone by a magic-wand button (south-west) and a quick-settings gear (south-east), with a drag handle below to resize the input.

## Features

- **Push-to-talk everywhere** — hold the big red button, or hold **Right Alt / Right Option**; release to transcribe. A quick click *latches* recording on; click again to stop.
- **Swipe gestures on the button** — while holding, swipe up-right to send immediately, up-left to discard.
- **Hands-free mode** — the mic listens continuously with an energy-based VAD; ~150 ms of speech starts a capture, an adjustable silence delay (default 5 s) ends it. A rolling 0.5 s pre-roll buffer means the first syllable is never clipped. Detection suspends automatically while TTS plays, so replies never loop back into the mic. An orbiting dot around the record button shows state (green = listening, red = capturing).
- **Dictations are marked as such** — a dictated draft ends with the line `[Voice-dictated — may contain transcription errors]`, so the model treats the text as a possibly garbled speech transcript (and can echo it back cleaned up) rather than as carefully typed words, and the sent message shows the indicator. It is ordinary text: delete the line before sending if you do not want it. Typed-only drafts never get it; the magic wand keeps it in place.
- **Voice-send triggers** — end a dictation with *thanks* / *thank you* / *kiitos* (kept in the text) or the magic phrase *"bada bim bada boom"* (stripped) to send without clicking. The magic-phrase matcher works on a consonant skeleton, so heavy STT mangling ("bada pim bada poum", Cyrillic transliterations, fused words) still triggers.
- **Speak any reply** — a 🔊 control under each assistant message synthesizes speech and shows a seekable waveform. Auto-speak plays replies as they arrive; a page refresh never burst-speaks old messages.
- **Auto-play never talks over you** — if a reply lands while you are recording (push-to-talk, latched, or a hands-free utterance), playback waits and starts when the recording ends. Only the newest waiting reply plays.
- **Speech is generated in the background** — with auto-speak on, the DSH host synthesizes every finished assistant reply into the disk cache itself, whether or not a browser is open (one at a time, subagents and interrupted replies skipped). Open the PWA later and replies that arrived while you were away already show a ready-to-play waveform (up to 6 per open, never auto-played); nothing waits on the TTS server. The browser tells the host the auto-speak switch (`POST /voice/prefs`, persisted in `storages/dsh-plugin-voice-mode/prefs.json`); if you turn auto-speak on after a host restart, open the page once so the host learns it.
- **TTS pauses while you record** and resumes when you stop, so you can comment mid-playback.
- **Magic wand** — one click restructures a rambling dictated draft (structure, de-duplication, keeps every fact) using the chat model you currently have selected. No separate model slot.
- **Chimes** — record start/stop and send cues, timed so they never bleed into the mic.
- **Deterministic TTS cleanup** — markdown stripped, code blocks become "code block", `src/lib/helpers.ts` becomes "helpers dot ts". No LLM in the speech path.
- **Calibration built in** — settings popup with a live mic level meter and sliders for VAD sensitivity and silence delay, all persisted.
- **Disk cache** — synthesized audio is cached server-side (`~/.dsh/storages/voice-audio`, 300-file cap), so replaying a message is instant and free. A synthesis already running for the same text is joined, never duplicated.

## Requirements

- An OpenAI-compatible STT endpoint (built against [NVIDIA Parakeet TDT](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), auto-detects 25 languages).
- An OpenAI-compatible TTS endpoint (built against OmniVoice with a cloned voice).

## Install

```sh
dsh plugin --profile web add https://github.com/erkkimon/dsh-plugin-voice-mode.git
```

Then add a row to your profile's `cordis.patch.yml`:

```yaml
insert:
  plugin-voice-mode:
    name: dsh-plugin-voice-mode
```

and restart the service, e.g. `systemctl --user restart dsh-web.service`, then hard-refresh the page.

## Configuration

Environment variables on the DSH host process:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DSH_VOICE_STT_URL` | **yes** | OpenAI-compatible STT endpoint (e.g. `http://localhost:4110/v1/audio/transcriptions`) |
| `DSH_VOICE_TTS_URL` | **yes** | OpenAI-compatible TTS endpoint (e.g. `http://localhost:4111/v1/audio/speech`) |
| `DSH_VOICE_TTS_VOICE` | no (default: `donna-13s`) | Voice id sent to the TTS endpoint |

## Privacy

Audio stays on your machine until you speak: hands-free mode keeps a rolling 0.5 s in-memory ring that is continuously discarded; only a completed utterance is sent to the STT endpoint. TTS audio is cached on the local disk only.

## License

MIT
