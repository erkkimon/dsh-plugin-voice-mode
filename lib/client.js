window.__ModuleLoader__.load({
	id: "dsh-plugin-voice-mode",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");

		//#region prefs
		var PREFS_KEY = "dsh-voice:prefs:v1";
		var HEIGHT_KEY = "dsh-voice:composer-h";
		var prefs = loadPrefs();
		function loadPrefs() {
			try {
				var p = JSON.parse(localStorage.getItem(PREFS_KEY));
				return {
					autoSpeak: !!(p && p.autoSpeak),
					voiceSend: !!(p && p.voiceSend),
					handsFree: !!(p && p.handsFree),
					vadThreshold: p && typeof p.vadThreshold === "number" ? p.vadThreshold : 0.02,
					vadSilenceMs: p && typeof p.vadSilenceMs === "number" ? p.vadSilenceMs : 5000
				};
			} catch (e) {
				return { autoSpeak: false, voiceSend: false, handsFree: false, vadThreshold: 0.02, vadSilenceMs: 5000 };
			}
		}
		function savePrefs() {
			try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {}
		}
		// Auto-speak must fire only for messages ARRIVING while this page is
		// open. Everything already in the log at load (time < bootTime) stays
		// silent — refreshing the tab must never burst-speak old replies.
		var bootTime = Date.now();
		//#endregion

		//#region sounds (ported from opencode-voice-app sounds.ts)
		// Chime timing is deliberate: the start chime plays BEFORE the recorder
		// opens the mic and the stop chime AFTER it closes, so neither bleeds
		// into the recording. WebAudio output is not paused by the PTT
		// pause/resume logic, which only touches the TTS audio element.
		var audioCtx = null;
		function getCtx() {
			if (typeof window === "undefined") return null;
			if (!audioCtx) {
				var Ctor = window.AudioContext || window.webkitAudioContext;
				if (!Ctor) return null;
				audioCtx = new Ctor();
			}
			if (audioCtx.state === "suspended") audioCtx.resume().catch(function () {});
			return audioCtx;
		}
		function tone(ctx, freqHz, startAt, durationMs, peakGain) {
			var osc = ctx.createOscillator();
			var gain = ctx.createGain();
			osc.type = "sine";
			osc.frequency.setValueAtTime(freqHz, startAt);
			gain.gain.setValueAtTime(0, startAt);
			gain.gain.linearRampToValueAtTime(peakGain || 0.12, startAt + 0.005);
			gain.gain.linearRampToValueAtTime(0, startAt + durationMs / 1000);
			osc.connect(gain);
			gain.connect(ctx.destination);
			osc.start(startAt);
			osc.stop(startAt + durationMs / 1000 + 0.02);
		}
		function playRecordStart() {
			var ctx = getCtx();
			if (!ctx) return;
			tone(ctx, 880, ctx.currentTime, 80);
			tone(ctx, 1318.51, ctx.currentTime + 0.06, 100);
		}
		function playRecordStop() {
			var ctx = getCtx();
			if (!ctx) return;
			tone(ctx, 1318.51, ctx.currentTime, 80);
			tone(ctx, 880, ctx.currentTime + 0.06, 100);
		}
		function playMessageSent() {
			var ctx = getCtx();
			if (!ctx) return;
			tone(ctx, 880, ctx.currentTime, 70);
			tone(ctx, 1108.73, ctx.currentTime + 0.07, 70);
			tone(ctx, 1318.51, ctx.currentTime + 0.14, 110);
		}
		//#endregion

		//#region voice-send magic phrase
		// "bada bim bada boom" at the end of a transcript sends the draft.
		// Parakeet mangles the phrase creatively ("bada pim bada poum",
		// "padabimpadabum", even Cyrillic), so matching is done on the
		// CONSONANT SKELETON of the transcript tail: vowels are ignored and
		// p/b and t/d are treated as equivalent stops. Target skeleton:
		//   b-a-d-a b-i-m b-a-d-a b-o-o-m  ->  b d b m b d b m
		var CYRILLIC_MAP = {
			"а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
			"ж": "zh", "з": "z", "и": "i", "й": "i", "к": "k", "л": "l", "м": "m",
			"н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
			"ф": "f", "х": "h", "ц": "c", "ч": "c", "ш": "s", "щ": "s",
			"ъ": "", "ы": "i", "ь": "", "э": "e", "ю": "u", "я": "a"
		};
		var MAGIC_SKELETON = "bdbmbdbm";
		// Returns the transcript with the magic phrase stripped, or null when
		// the tail does not match. Anchored to the very end: the phrase is a
		// send command, so it must be the last thing said.
		function stripMagicPhrase(text) {
			var lower = text.toLowerCase();
			var letters = [];
			for (var i = 0; i < lower.length; i++) {
				var ch = lower[i];
				var mapped = CYRILLIC_MAP[ch];
				if (mapped !== undefined) ch = mapped;
				if (ch.length === 1 && ch >= "a" && ch <= "z") letters.push({ ch: ch, idx: i });
			}
			var skeleton = "";
			for (var start = letters.length - 1; start >= 0; start--) {
				var c = letters[start].ch;
				if (c !== "a" && c !== "e" && c !== "i" && c !== "o" && c !== "u" && c !== "y") {
					if (c === "p") c = "b";
					if (c === "t") c = "d";
					skeleton = c + skeleton;
				}
				var len = letters.length - start;
				if (len >= 11 && len <= 24 && skeleton === MAGIC_SKELETON) {
					return text.slice(0, letters[start].idx).replace(/[\s.,!?-]+$/, "").trim();
				}
				if (len > 24) return null;
			}
			return null;
		}
		//#endregion

		//#region natural send trigger
		// A dictation ending in "thanks" almost always means "done, send it" —
		// and unlike the magic phrase, real words survive STT unmangled. The
		// word itself STAYS in the text (it's usually meant as content).
		var THANKS_RE = /(?:thank you|thanks|kiitos)[\s.,!?]*$/i;
		//#endregion

		//#region shared audio (single playback seat)
		var currentAudio = null;
		var pausedForPtt = null;
		// Every TTS element ever generated, removed on end. The hands-free
		// VAD guard consults this whole set, not just currentAudio, so a
		// forgotten-but-playing element can never leak Donna into the mic.
		var liveAudio = new Set();
		// Counts in-flight TTS generations (fetch + decode). The hands-free
		// VAD must treat this as "Donna busy" too — before the audio element
		// starts playing there is nothing paused=false to observe, and her
		// first syllables would otherwise leak into the mic.
		var ttsFetchCount = 0;
		function anyLiveAudioPlaying() {
			var playing = false;
			liveAudio.forEach(function (a) {
				if (!a.paused && !a.ended) playing = true;
			});
			return playing;
		}
		function pauseVoiceAudio() {
			if (currentAudio && !currentAudio.paused && !currentAudio.ended) {
				currentAudio.pause();
				pausedForPtt = currentAudio;
			}
		}
		function resumeVoiceAudio() {
			var a = pausedForPtt;
			pausedForPtt = null;
			if (a) a.play().catch(function () {});
		}
		function stopCurrentAudio() {
			// Clearing pausedForPtt is load-bearing: without it, a recording
			// that ENDS after a newer message started speaking would resurrect
			// the superseded element and two voices would play at once.
			pausedForPtt = null;
			if (currentAudio) {
				try { currentAudio.pause(); } catch (e) {}
				currentAudio = null;
			}
		}
		//#endregion

		//#region recorder controller
		// One state machine for the big PTT button and keyboard push-to-talk
		// (Right Alt / Right Option, event.code "AltRight" on both). Stopped
		// recordings enter a serial transcription queue so quick successive
		// dictations stack instead of being dropped.
		var recorderCtl = {
			status: "idle",
			lastError: null,
			listeners: new Set(),
			draftGet: null,
			draftSet: null,
			draftSubmit: null,
			rec: null,
			chunks: [],
			queue: [],
			pendingIntent: "draft",
			setStatus: function (s) {
				this.status = s;
				this.listeners.forEach(function (f) {
					try { f(s); } catch (e) {}
				});
			},
			bindDraft: function (get, set, submit) {
				this.draftGet = get;
				this.draftSet = set;
				this.draftSubmit = submit;
			},
			unbindDraft: function (get) {
				if (this.draftGet === get) {
					this.draftGet = null;
					this.draftSet = null;
					this.draftSubmit = null;
				}
			},
			appendDraft: function (text) {
				if (this.draftGet === null || this.draftSet === null) {
					console.error("voice: no composer to receive the transcript");
					return "";
				}
				var draft = this.draftGet();
				var next = draft.length > 0 ? draft + " " + text : text;
				this.draftSet(next);
				return next;
			},
			start: function () {
				var self = this;
				if (this.status === "recording") return;
				if (handsFreeCtl.recording) return; // hands-free owns the mic right now
				this.lastError = null;
				if (typeof navigator === "undefined" || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
					this.lastError = "no mic support in this browser";
					this.setStatus("error");
					return;
				}
				playRecordStart();
				pauseVoiceAudio();
				navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
					var rec;
					try {
						rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
					} catch (e1) {
						try { rec = new MediaRecorder(stream); } catch (e2) {
							stream.getTracks().forEach(function (t) { t.stop(); });
							resumeVoiceAudio();
							self.setStatus("error");
							return;
						}
					}
					self.chunks = [];
					rec.ondataavailable = function (ev) {
						if (ev.data && ev.data.size > 0) self.chunks.push(ev.data);
					};
					rec.onstop = function () {
						stream.getTracks().forEach(function (t) { t.stop(); });
						self.rec = null;
						resumeVoiceAudio();
						var intent = self.pendingIntent;
						self.pendingIntent = "draft";
						var blob = new Blob(self.chunks, { type: rec.mimeType || "audio/webm" });
						self.chunks = [];
						// Sub-quarter-second recordings are almost always a
						// mis-tap; drop them quietly rather than erroring.
						if (blob.size < 1024) {
							if (self.queue.length === 0) self.setStatus("idle");
							return;
						}
						self.queue.push({ blob: blob, intent: intent });
						self.processQueue();
					};
					self.rec = rec;
					rec.start(200);
					self.setStatus("recording");
				}).catch(function (err) {
					console.error("voice mic access:", err);
					resumeVoiceAudio();
					self.lastError = "mic access denied";
					self.setStatus("error");
				});
			},
			stop: function (intent) {
				if (this.status !== "recording" || this.rec === null) return;
				this.pendingIntent = intent === "send" ? "send" : "draft";
				if (intent !== "send") playRecordStop();
				try { this.rec.stop(); } catch (e) {}
			},
			cancel: function () {
				if (this.rec === null) return;
				this.pendingIntent = "draft";
				this.chunks = [];
				this.rec.onstop = null;
				try { this.rec.stop(); } catch (e) {}
				this.rec = null;
				resumeVoiceAudio();
				if (this.queue.length === 0) this.setStatus("idle");
			},
			enqueue: function (blob, intent) {
				this.queue.push({ blob: blob, intent: intent || "draft" });
				this.processQueue();
			},
			processQueue: function () {
				var self = this;
				if (this.status === "busy") return;
				var item = this.queue.shift();
				if (!item) return;
				this.setStatus("busy");
				fetch("/voice/stt", { method: "POST", body: item.blob }).then(function (res) {
					return res.json().catch(function () { return { error: "stt http " + res.status }; });
				}).then(function (parsed) {
					if (parsed && parsed.error) {
						console.error("voice-stt:", parsed.error);
						self.lastError = parsed.error;
						self.setStatus("error");
						return;
					}
					var text = parsed && typeof parsed.text === "string" ? parsed.text.trim() : "";
					if (text.length > 0) self.handleTranscript(text, item.intent);
					self.setStatus("idle");
				}).catch(function (err) {
					console.error("voice-stt:", err);
					self.lastError = String(err && err.message ? err.message : err);
					self.setStatus("error");
				}).finally(function () {
					if (self.queue.length > 0) self.processQueue();
				});
			},
			handleTranscript: function (text, intent) {
				var cleaned = text;
				var wantsSend = intent === "send";
				if (!wantsSend && prefs.voiceSend) {
					var stripped = stripMagicPhrase(cleaned);
					if (stripped !== null) {
						cleaned = stripped;
						wantsSend = true;
					} else if (THANKS_RE.test(cleaned)) {
						// "thanks" is kept in the text — only the send fires.
						wantsSend = true;
					}
				}
				// The draft prop ref refreshes only on the next render, so
				// judge emptiness from the value appendDraft computed rather
				// than re-reading it here.
				var combined = cleaned.length > 0
					? this.appendDraft(cleaned)
					: this.draftGet !== null ? this.draftGet() : "";
				if (wantsSend && this.draftSubmit !== null && combined.trim().length > 0) {
					playMessageSent();
					var submit = this.draftSubmit;
					// Defer one tick so the input store has flushed setDraft
					// before submit reads it.
					setTimeout(function () { submit(); }, 0);
				}
			}
		};
		//#endregion

		//#region hands-free listening
		// Always-on listening with energy-based voice activity detection. The
		// MediaRecorder runs CONTINUOUSLY in 100 ms slices; while idle, only a
		// short rolling ring (~0.5 s) is kept. When three consecutive loud
		// frames signal speech, the ring becomes the head of the capture — so
		// the first word is never clipped — and two full seconds of silence
		// close the utterance into the normal transcription queue, where the
		// magic phrase / "thanks" triggers apply.
		//
		// Two feedback guards are ESSENTIAL here:
		//  - polling suspends while Donna speaks, otherwise TTS playback would
		//    trigger capture and her words would come back as user messages;
		//  - if TTS starts MID-capture (auto-speak of an arriving reply), the
		//    capture is cut immediately.
		// Manual push-to-talk also suspends detection while it owns the mic.
		var HANDS_FREE_THRESHOLD = 0.02;
		var HANDS_FREE_MAX_MS = 60000;
		var HANDS_FREE_TIMESLICE = 100;
		var HANDS_FREE_PREROLL_CHUNKS = 5; // 5 x 100 ms kept from before the trigger
		var HANDS_FREE_SILENCE_MS = 5000; // default; prefs.vadSilenceMs overrides (poll frames = ms / 50)
		var handsFreeCtl = {
			active: false,
			recording: false, // true while an utterance is being captured
			stream: null,
			analyser: null,
			buf: null,
			timer: null,
			rec: null,
			header: null,        // first chunk of the current recorder session (webm init)
			needHeader: true,
			ring: [],            // recent chunks while idle (excluding the header)
			captureChunks: null, // non-null while capturing: header + preroll + speech
			speechFrames: 0,
			silenceFrames: 0,
			startedAt: 0,
			listeners: new Set(),
			notify: function () {
				this.listeners.forEach(function (f) {
					try { f(); } catch (e) {}
				});
			},
			setActive: function (on) {
				if (on === this.active) return;
				this.active = on;
				if (on) this.open(); else this.close();
				this.notify();
			},
			open: function () {
				var self = this;
				if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
				navigator.mediaDevices.getUserMedia({
					audio: { echoCancellation: true, noiseSuppression: true }
				}).then(function (stream) {
					if (!self.active) {
						stream.getTracks().forEach(function (t) { t.stop(); });
						return;
					}
					var ctx = getCtx();
					if (!ctx) {
						stream.getTracks().forEach(function (t) { t.stop(); });
						return;
					}
					var src = ctx.createMediaStreamSource(stream);
					var analyser = ctx.createAnalyser();
					analyser.fftSize = 2048;
					src.connect(analyser); // analysis only — never routed to output
					self.stream = stream;
					self.analyser = analyser;
					self.buf = new Uint8Array(analyser.fftSize);
					self.timer = setInterval(function () { self.poll(); }, 50);
					self.startRecorder();
					self.notify();
				}).catch(function (err) {
					console.error("voice hands-free mic:", err);
					self.active = false;
					recorderCtl.lastError = "hands-free mic access denied";
					recorderCtl.setStatus("error");
					self.notify();
				});
			},
			close: function () {
				if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
				if (this.rec !== null) {
					this.rec.ondataavailable = null;
					this.rec.onstop = null;
					try { this.rec.stop(); } catch (e) {}
					this.rec = null;
				}
				if (this.stream !== null) {
					this.stream.getTracks().forEach(function (t) { t.stop(); });
					this.stream = null;
				}
				this.analyser = null;
				this.header = null;
				this.ring = [];
				this.captureChunks = null;
				this.recording = false;
			},
			startRecorder: function () {
				var self = this;
				if (this.stream === null) return;
				var rec;
				try {
					rec = new MediaRecorder(this.stream, { mimeType: "audio/webm;codecs=opus" });
				} catch (e1) {
					try { rec = new MediaRecorder(this.stream); } catch (e2) { return; }
				}
				this.needHeader = true;
				this.ring = [];
				rec.ondataavailable = function (ev) {
					if (!ev.data || ev.data.size === 0) return;
					if (self.needHeader) {
						self.header = ev.data;
						self.needHeader = false;
						return;
					}
					if (self.captureChunks !== null) {
						self.captureChunks.push(ev.data);
					} else {
						self.ring.push(ev.data);
						if (self.ring.length > 8) self.ring.shift();
					}
				};
				rec.onstop = function () {
					var chunks = self.captureChunks;
					self.captureChunks = null;
					resumeVoiceAudio();
					// chunks starts with the webm header followed by preroll +
					// speech from ONE recorder session, so the blob is valid.
					if (chunks !== null && chunks.length > 2) {
						var blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
						if (blob.size >= 1024) recorderCtl.enqueue(blob, "draft");
					}
					// Roll on: a fresh recorder session for the next utterance.
					if (self.active && self.stream !== null) self.startRecorder();
				};
				this.rec = rec;
				rec.start(HANDS_FREE_TIMESLICE);
			},
			rms: function () {
				this.analyser.getByteTimeDomainData(this.buf);
				var sum = 0;
				for (var i = 0; i < this.buf.length; i++) {
					var v = (this.buf[i] - 128) / 128;
					sum += v * v;
				}
				return Math.sqrt(sum / this.buf.length);
			},
			poll: function () {
				if (this.analyser === null) return;
				var ttsBusy = ttsFetchCount > 0
					|| pausedForPtt !== null
					|| anyLiveAudioPlaying();
				var manualBusy = recorderCtl.status === "recording" || recorderCtl.status === "busy";
				if (ttsBusy || manualBusy) {
					this.speechFrames = 0;
					// Donna's voice must not linger in the preroll ring either.
					this.ring = [];
					if (this.recording) this.endRecording();
					return;
				}
				var level = this.rms();
				var threshold = prefs.vadThreshold || HANDS_FREE_THRESHOLD;
				if (!this.recording) {
					if (level > threshold) {
						this.speechFrames++;
						if (this.speechFrames >= 3) this.beginRecording();
					} else {
						this.speechFrames = 0;
					}
				} else {
					if (Date.now() - this.startedAt > HANDS_FREE_MAX_MS) {
						this.endRecording();
						return;
					}
					if (level < threshold) {
						this.silenceFrames++;
						if (this.silenceFrames >= Math.max(4, Math.round((prefs.vadSilenceMs || HANDS_FREE_SILENCE_MS) / 50))) this.endRecording();
					} else {
						this.silenceFrames = 0;
					}
				}
			},
			beginRecording: function () {
				if (this.stream === null || this.recording || this.rec === null) return;
				playRecordStart();
				pauseVoiceAudio();
				var pre = this.ring.slice(-HANDS_FREE_PREROLL_CHUNKS);
				this.captureChunks = this.header !== null ? [this.header].concat(pre) : pre.slice();
				this.ring = [];
				this.recording = true;
				this.startedAt = Date.now();
				this.silenceFrames = 0;
				this.notify();
			},
			endRecording: function () {
				if (!this.recording || this.rec === null) return;
				this.recording = false;
				playRecordStop();
				// stop() flushes the final chunk, then onstop builds the blob
				// and restarts the rolling recorder.
				try { this.rec.stop(); } catch (e) {}
				this.notify();
			}
		};
		//#endregion

		//#region push-to-talk keyboard
		// Hold Right Alt (Right Option on macOS) to record; release transcribes.
		// preventDefault keeps the key away from browser menus; window blur
		// stops cleanly instead of leaving a stuck recording.
		function attachPushToTalk(ctx) {
			ctx.effect(function () {
				var onKeyDown = function (ev) {
					if (ev.code !== "AltRight" || ev.repeat) return;
					ev.preventDefault();
					recorderCtl.start();
				};
				var onKeyUp = function (ev) {
					if (ev.code !== "AltRight") return;
					ev.preventDefault();
					recorderCtl.stop("draft");
				};
				var onBlur = function () { recorderCtl.stop("draft"); };
				window.addEventListener("keydown", onKeyDown);
				window.addEventListener("keyup", onKeyUp);
				window.addEventListener("blur", onBlur);
				return function () {
					window.removeEventListener("keydown", onKeyDown);
					window.removeEventListener("keyup", onKeyUp);
					window.removeEventListener("blur", onBlur);
					recorderCtl.cancel();
				};
			});
		}
		//#endregion

		//#region waveform (ported from opencode-voice-app waveform.ts)
		var peakCache = new Map();
		function computePeaks(blob, buckets) {
			var cacheKey = "blob:" + blob.size + ":" + blob.type;
			var cached = peakCache.get(cacheKey);
			if (cached && cached.length === buckets) return Promise.resolve(cached);
			return blob.arrayBuffer().then(function (buf) {
				var ctx = getCtx();
				if (!ctx) throw new Error("no AudioContext");
				return ctx.decodeAudioData(buf.slice(0));
			}).then(function (audio) {
				var channel = audio.getChannelData(0);
				var samplesPerBucket = Math.max(1, Math.floor(channel.length / buckets));
				var peaks = new Float32Array(buckets);
				var max = 0;
				for (var i = 0; i < buckets; i++) {
					var peak = 0;
					var start = i * samplesPerBucket;
					var end = Math.min(start + samplesPerBucket, channel.length);
					for (var j = start; j < end; j++) {
						var v = Math.abs(channel[j] || 0);
						if (v > peak) peak = v;
					}
					peaks[i] = peak;
					if (peak > max) max = peak;
				}
				if (max > 0) for (var k = 0; k < buckets; k++) peaks[k] = peaks[k] / max;
				peakCache.set(cacheKey, peaks);
				return peaks;
			});
		}
		function drawWaveform(canvas, peaks, progress) {
			var dpr = window.devicePixelRatio || 1;
			var cssW = canvas.clientWidth;
			var cssH = canvas.clientHeight;
			var w = Math.max(1, Math.floor(cssW * dpr));
			var h = Math.max(1, Math.floor(cssH * dpr));
			if (canvas.width !== w) canvas.width = w;
			if (canvas.height !== h) canvas.height = h;
			var ctx = canvas.getContext("2d");
			if (!ctx) return;
			var n = peaks.length;
			var barW = Math.max(1, Math.floor(w / n) - Math.max(1, Math.floor(dpr)));
			var gap = Math.max(1, Math.floor(dpr));
			var playedX = Math.floor(Math.max(0, Math.min(1, progress)) * w);
			ctx.clearRect(0, 0, w, h);
			for (var i = 0; i < n; i++) {
				var x = i * (barW + gap);
				var peak = Math.max(0.04, peaks[i] || 0);
				var barH = Math.max(2, Math.floor(peak * h));
				var y = Math.floor((h - barH) / 2);
				ctx.fillStyle = x + barW < playedX ? "#3b82f6" : "#52525b";
				ctx.fillRect(x, y, barW, barH);
			}
		}
		//#endregion

		//#region shared styles
		var btnStyle = {
			background: "none",
			border: "none",
			cursor: "pointer",
			fontSize: "14px",
			lineHeight: 1,
			padding: "2px 4px",
			color: "inherit"
		};
		//#endregion

		//#region flat icons (lucide paths, inlined — no icon dependency)
		var ICONS = {
			wand: [["path", { d: "m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.21 1.21 0 0 0 1.72 0L21.64 5.36a1.21 1.21 0 0 0 0-1.72Z" }], ["path", { d: "m14 7 3 3" }], ["path", { d: "M5 6v4" }], ["path", { d: "M19 14v4" }], ["path", { d: "M10 2v2" }], ["path", { d: "M7 8H3" }], ["path", { d: "M21 16h-4" }], ["path", { d: "M11 3H9" }]],
			settings: [["path", { d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" }], ["circle", { cx: "12", cy: "12", r: "3" }]],
			x: [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]],
			arrowUp: [["path", { d: "m5 12 7-7 7 7" }], ["path", { d: "M12 19V5" }]],
			play: [["polygon", { points: "6 3 20 12 6 21 6 3", fill: "currentColor", stroke: "none" }]],
			pause: [["rect", { x: "6", y: "4", width: "4", height: "16", rx: "1", fill: "currentColor", stroke: "none" }], ["rect", { x: "14", y: "4", width: "4", height: "16", rx: "1", fill: "currentColor", stroke: "none" }]],
			volume: [["path", { d: "M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" }], ["path", { d: "M16 9a5 5 0 0 1 0 6" }], ["path", { d: "M19.364 18.364a9 9 0 0 0 0-12.728" }]],
			loader: [["path", { d: "M21 12a9 9 0 1 1-6.219-8.56" }]],
			alert: [["path", { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" }], ["path", { d: "M12 9v4" }], ["path", { d: "M12 17h.01" }]],
			refresh: [["path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }], ["path", { d: "M21 3v5h-5" }], ["path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }], ["path", { d: "M8 16H3v5" }]]
		};
		function icon(name, size, extraStyle) {
			return react.createElement("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				style: extraStyle || undefined
			}, ICONS[name].map(function (el, i) {
				return react.createElement(el[0], Object.assign({ key: i }, el[1]));
			}));
		}
		//#endregion

		//#region components
		function blocksToText(blocks) {
			var parts = [];
			for (var i = 0; i < blocks.length; i++) {
				var b = blocks[i];
				if (b.kind === "text" && typeof b.text === "string") parts.push(b.text);
			}
			return parts.join("\n").trim();
		}

		function Toggle(props) {
			return react.createElement("button", {
				onClick: props.onToggle,
				style: {
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: "12px",
					width: "100%",
					background: "none",
					border: "none",
					color: "inherit",
					cursor: "pointer",
					padding: "6px 0",
					fontSize: "13px",
					textAlign: "left"
				}
			},
				react.createElement("span", null, props.label),
				react.createElement("span", {
					style: {
						width: "30px",
						height: "16px",
						borderRadius: "8px",
						background: props.on ? "#3b82f6" : "#3f3f46",
						position: "relative",
						flexShrink: 0,
						transition: "background 0.15s"
					}
				},
					react.createElement("span", {
						style: {
							position: "absolute",
							top: "2px",
							left: props.on ? "16px" : "2px",
							width: "12px",
							height: "12px",
							borderRadius: "50%",
							background: "#fff",
							transition: "left 0.15s"
						}
					})
				)
			);
		}

		// Live mic level bar for calibrating the VAD slider. Polls the
		// hands-free analyser while visible; the threshold marker shows where
		// the trigger point sits relative to the room's actual levels.
		function LevelMeter(props) {
			var levelPair = react.useState(0);
			var level = levelPair[0];
			var setLevel = levelPair[1];
			react.useEffect(function () {
				var timer = setInterval(function () {
					setLevel(handsFreeCtl.analyser !== null ? handsFreeCtl.rms() : 0);
				}, 100);
				return function () { clearInterval(timer); };
			}, []);
			var SCALE = 0.1; // bar saturates at RMS 0.1 — loud speech
			var fillPct = Math.min(100, Math.round((level / SCALE) * 100));
			var markPct = Math.min(100, Math.round((props.threshold / SCALE) * 100));
			return react.createElement("div", {
				style: {
					position: "relative",
					height: "8px",
					borderRadius: "4px",
					background: "#27272a",
					overflow: "hidden",
					margin: "4px 0 2px"
				}
			},
				react.createElement("div", {
					style: {
						position: "absolute",
						left: 0,
						top: 0,
						bottom: 0,
						width: fillPct + "%",
						background: level > props.threshold ? "#22c55e" : "#3b82f6",
						transition: "width 0.08s linear"
					}
				}),
				react.createElement("div", {
					style: {
						position: "absolute",
						left: markPct + "%",
						top: 0,
						bottom: 0,
						width: "2px",
						background: "#f59e0b"
					}
				})
			);
		}

		function PttDock(props) {
			var statusPair = react.useState(recorderCtl.status);
			var status = statusPair[0];
			var setStatus = statusPair[1];
			var intentPair = react.useState("normal");
			var intent = intentPair[0];
			var setIntent = intentPair[1];
			var openPair = react.useState(false);
			var settingsOpen = openPair[0];
			var setSettingsOpen = openPair[1];
			var prefsPair = react.useState({
				autoSpeak: prefs.autoSpeak,
				voiceSend: prefs.voiceSend,
				handsFree: prefs.handsFree,
				vadThreshold: prefs.vadThreshold,
				vadSilenceMs: prefs.vadSilenceMs
			});
			var prefsState = prefsPair[0];
			var setPrefsState = prefsPair[1];
			var hfPair = react.useState({ active: handsFreeCtl.active, recording: handsFreeCtl.recording });
			var hfState = hfPair[0];
			var setHfState = hfPair[1];
			// Narrow viewports (phones): the quick-settings popup switches to a
			// full-width sheet with a tap-outside backdrop — the desktop
			// popover anchors right of the gear and overflows off-screen there.
			var narrowPair = react.useState(function () {
				return typeof window !== "undefined" && window.matchMedia("(max-width: 700px)").matches;
			});
			var narrow = narrowPair[0];
			var setNarrow = narrowPair[1];

			react.useEffect(function () {
				var mq = window.matchMedia("(max-width: 700px)");
				var onChange = function (ev) { setNarrow(ev.matches); };
				if (mq.addEventListener) mq.addEventListener("change", onChange);
				else mq.addListener(onChange);
				return function () {
					if (mq.removeEventListener) mq.removeEventListener("change", onChange);
					else mq.removeListener(onChange);
				};
			}, []);

			var draftRef = react.useRef("");
			draftRef.current = props.input.draft;
			var actionsRef = react.useRef(props.inputActions);
			actionsRef.current = props.inputActions;
			var pressRef = react.useRef(null);
			var latchedRef = react.useRef(false);
			var rootRef = react.useRef(null);

			react.useEffect(function () {
				var get = function () { return draftRef.current; };
				recorderCtl.bindDraft(
					get,
					function (t) { actionsRef.current.setDraft(t); },
					function () { actionsRef.current.submit(); }
				);
				var listener = function (s) { setStatus(s); };
				recorderCtl.listeners.add(listener);
				var hfListener = function () {
					setHfState({ active: handsFreeCtl.active, recording: handsFreeCtl.recording });
				};
				handsFreeCtl.listeners.add(hfListener);
				if (prefs.handsFree) handsFreeCtl.setActive(true);
				// The padded zone at the top of the composer input hosts the
				// wand, the gear, and the drag handle; the record button is
				// the only element allowed to straddle the card's top edge.
				// Padding goes on the SCROLLPORT (the element that actually
				// lays out), never on the overlay textarea.
				var parts = rootRef.current ? findComposerParts(rootRef.current) : null;
				var scroll = parts ? parts.scroll : null;
				if (scroll) {
					scroll.style.paddingTop = "64px";
					var savedH = 0;
					try { savedH = parseInt(localStorage.getItem(HEIGHT_KEY) || "0", 10) || 0; } catch (e) {}
					if (savedH > 0) scroll.style.minHeight = savedH + "px";
					// The whole padded zone above the text acts as a drag
					// surface: pointer events landing on the scrollport
					// itself can only come from its padding (every child
					// sits below it), so a target check is enough — text
					// selection and composer clicks stay untouched.
					var onZoneDown = function (ev) { if (ev.target === scroll) startDrag(ev, scroll); };
					var onZoneMove = function (ev) { onHandleMove(ev); };
					var onZoneUp = function () { onHandleUp(); };
					var onZoneDbl = function (ev) { if (ev.target === scroll) onHandleDoubleClick(); };
					scroll.addEventListener("pointerdown", onZoneDown);
					scroll.addEventListener("pointermove", onZoneMove);
					scroll.addEventListener("pointerup", onZoneUp);
					scroll.addEventListener("pointercancel", onZoneUp);
					scroll.addEventListener("dblclick", onZoneDbl);
				}
				return function () {
					recorderCtl.unbindDraft(get);
					recorderCtl.listeners.delete(listener);
					handsFreeCtl.listeners.delete(hfListener);
					if (scroll) {
						scroll.style.paddingTop = "";
						scroll.style.minHeight = "";
						scroll.removeEventListener("pointerdown", onZoneDown);
						scroll.removeEventListener("pointermove", onZoneMove);
						scroll.removeEventListener("pointerup", onZoneUp);
						scroll.removeEventListener("pointercancel", onZoneUp);
						scroll.removeEventListener("dblclick", onZoneDbl);
					}
				};
			}, []);

			function syncPrefsState() {
				setPrefsState({
					autoSpeak: prefs.autoSpeak,
					voiceSend: prefs.voiceSend,
					handsFree: prefs.handsFree,
					vadThreshold: prefs.vadThreshold,
					vadSilenceMs: prefs.vadSilenceMs
				});
			}
			function togglePref(key) {
				prefs[key] = !prefs[key];
				savePrefs();
				if (key === "handsFree") handsFreeCtl.setActive(prefs.handsFree);
				syncPrefsState();
			}
			function setVad(value) {
				prefs.vadThreshold = value;
				savePrefs();
				syncPrefsState();
			}
			function setSilence(value) {
				prefs.vadSilenceMs = value;
				savePrefs();
				syncPrefsState();
			}

			function findComposerParts(rootEl) {
				// The composer textarea is position:absolute;inset:0 over a
				// hidden mirror div that drives the height — styling the
				// textarea itself is futile (that is why the first padding
				// and drag attempts did nothing). The element whose box
				// actually lays out is the scrollport, found via the same
				// data attribute DSH's own Safari repair uses.
				var node = rootEl;
				while (node) {
					if (node.querySelector) {
						var ed = node.querySelector("textarea, [contenteditable='true']");
						if (ed) {
							var scroll = ed.closest("[data-input-scroll]");
							return { ed: ed, scroll: scroll };
						}
					}
					node = node.parentElement;
				}
				return null;
			}

			// ---- big button pointer handling ----
			// Hold to record; swipe up-right to send on release, up-left to
			// cancel. A sub-350ms press LATCHES instead (click-to-toggle), so
			// mouse users don't have to hold the button down.
			function onButtonDown(ev) {
				ev.preventDefault();
				if (status === "busy") return;
				if (status === "recording" && latchedRef.current) {
					latchedRef.current = false;
					recorderCtl.stop("draft");
					return;
				}
				if (status !== "idle" && status !== "error") return;
				latchedRef.current = false;
				pressRef.current = { x: ev.clientX, y: ev.clientY, at: Date.now(), pointerId: ev.pointerId };
				try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (e) {}
				recorderCtl.start();
			}
			function onButtonMove(ev) {
				var press = pressRef.current;
				if (!press || latchedRef.current) return;
				var dx = ev.clientX - press.x;
				var dy = press.y - ev.clientY;
				if (dy >= 30 && dx >= 30) setIntent("send");
				else if (dy >= 30 && dx <= -30) setIntent("cancel");
				else setIntent("normal");
			}
			function onButtonUp(ev) {
				var press = pressRef.current;
				pressRef.current = null;
				var finalIntent = intent;
				setIntent("normal");
				if (!press || latchedRef.current) return;
				if (recorderCtl.rec === null) return;
				if (finalIntent === "cancel") {
					recorderCtl.cancel();
					return;
				}
				if (finalIntent === "normal" && Date.now() - press.at < 350) {
					latchedRef.current = true;
					return;
				}
				recorderCtl.stop(finalIntent === "send" ? "send" : "draft");
			}

			// ---- composer height drag ----
			// The WHOLE padded zone above the text is a drag surface (the
			// visible handle bar is just its affordance). The size is a
			// MIN-HEIGHT on the scrollport, because the textarea is an
			// absolutely-positioned overlay whose own height is pinned.
			//
			// The measured height is the RENDERED box (padding included),
			// while min-height applies to the box determined by the
			// element's box-sizing — mixing the two is what made the field
			// jump by exactly the padding amount on the first drag move.
			var dragRef = react.useRef(null);
			function startDrag(ev, scroll) {
				var cs = getComputedStyle(scroll);
				var pad = parseFloat(cs.paddingTop) || 0;
				var rendered = scroll.getBoundingClientRect().height;
				var base = cs.boxSizing === "border-box" ? rendered : rendered - pad;
				ev.preventDefault();
				dragRef.current = { y: ev.clientY, h: base, scroll: scroll };
				try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (e) {}
			}
			function onHandleDown(ev) {
				var root = rootRef.current;
				if (!root) return;
				var parts = findComposerParts(root);
				if (!parts || !parts.scroll) return;
				startDrag(ev, parts.scroll);
			}
			function onHandleMove(ev) {
				var drag = dragRef.current;
				if (!drag) return;
				var next = Math.max(40, Math.min(600, Math.round(drag.h + (drag.y - ev.clientY))));
				drag.scroll.style.minHeight = next + "px";
				try { localStorage.setItem(HEIGHT_KEY, String(next)); } catch (e) {}
			}
			function onHandleUp() {
				dragRef.current = null;
			}
			function onHandleDoubleClick() {
				var root = rootRef.current;
				if (!root) return;
				var parts = findComposerParts(root);
				if (parts && parts.scroll) parts.scroll.style.minHeight = "";
				try { localStorage.removeItem(HEIGHT_KEY); } catch (e) {}
			}

			var recording = status === "recording";
			var buttonColor = recording
				? intent === "send" || intent === "cancel" ? "#3f3f46" : "#dc2626"
				: status === "busy" ? "#3f3f46" : "#dc2626";

			var children = [];

			// Composer height drag handle: a small grab bar centered just
			// below the record button, inside the padded zone. Double-click
			// resets to the product default height.
			children.push(react.createElement("div", {
				key: "handle",
				title: "Drag up/down to resize the input — double-click to reset",
				onPointerDown: onHandleDown,
				onPointerMove: onHandleMove,
				onPointerUp: onHandleUp,
				onPointerCancel: onHandleUp,
				onDoubleClick: onHandleDoubleClick,
				style: {
					position: "absolute",
					left: "50%",
					transform: "translateX(-50%)",
					bottom: "-64px",
					width: "44px",
					height: "12px",
					cursor: "ns-resize",
					zIndex: 40,
					touchAction: "none",
					display: "grid",
					placeItems: "center"
				}
			},
				react.createElement("span", {
					style: {
						display: "block",
						width: "40px",
						height: "5px",
						borderRadius: "3px",
						background: "#52525b",
						pointerEvents: "none"
					}
				})
			));

			// Swipe target chips, shown only mid-recording.
			if (recording) {
				var chipBase = {
					position: "absolute",
					top: "-84px",
					width: "40px",
					height: "40px",
					borderRadius: "50%",
					display: "grid",
					placeItems: "center",
					pointerEvents: "none",
					transition: "transform 0.1s, background 0.1s"
				};
				children.push(react.createElement("div", {
					key: "cancel-chip",
					style: Object.assign({}, chipBase, {
						left: "calc(50% - 100px)",
						background: intent === "cancel" ? "#dc2626" : "#27272a",
						color: intent === "cancel" ? "#fff" : "#a1a1aa",
						transform: intent === "cancel" ? "scale(1.15)" : "none"
					})
				}, icon("x", 18)));
				children.push(react.createElement("div", {
					key: "send-chip",
					style: Object.assign({}, chipBase, {
						left: "calc(50% + 60px)",
						background: intent === "send" ? "#2563eb" : "#27272a",
						color: intent === "send" ? "#fff" : "#a1a1aa",
						transform: intent === "send" ? "scale(1.15)" : "none"
					})
				}, icon("arrowUp", 18)));
			}

			// The big red record button: bottom half overlaps the composer's top edge.
			// Plain red circle while idle; recording shows a white square
			// (stop), busy a spinner, error an alert triangle.
			children.push(react.createElement("button", {
				key: "ptt",
				type: "button",
				title: recording
					? latchedRef.current
						? "Recording — click to stop"
						: "Release to stop — swipe up-right to send, up-left to cancel"
					: status === "error"
						? "Voice error: " + (recorderCtl.lastError || "unknown")
						: hfState.active
							? "Hands-free listening is on — just speak (click still records manually)"
							: "Hold to record (or Right Alt), click to latch — swipe up-right to send",
				onPointerDown: onButtonDown,
				onPointerMove: onButtonMove,
				onPointerUp: onButtonUp,
				onPointerCancel: onButtonUp,
				style: {
					position: "absolute",
					left: "50%",
					bottom: "-36px",
					transform: "translateX(-50%)",
					width: "72px",
					height: "72px",
					borderRadius: "50%",
					border: "none",
					outline: "none",
					background: buttonColor,
					color: "#fff",
					cursor: "pointer",
					display: "grid",
					placeItems: "center",
					boxShadow: recording ? "0 0 0 7px rgba(220,38,38,0.25)" : "0 0 0 5px rgba(220,38,38,0.15)",
					transition: "background 0.1s",
					zIndex: 40,
					touchAction: "none",
					userSelect: "none"
				}
			},
				recording
					? react.createElement("span", { style: { width: "22px", height: "22px", borderRadius: "5px", background: "#fff" } })
					: status === "busy"
						? icon("loader", 26, { animation: "dshVoiceOrbit 1s linear infinite" })
						: status === "error" ? icon("alert", 26) : null));

			// Hands-free activity dot ORBITS the record button like Earth
			// around the Sun: a zero-size pivot at the button's center spins,
			// carrying the dot around the ring. Fast red while capturing,
			// slow green while listening.
			if (hfState.active) {
				children.push(react.createElement("span", {
					key: "hf-orbit",
					title: hfState.recording ? "Hands-free: recording…" : "Hands-free: listening",
					style: {
						position: "absolute",
						left: "50%",
						bottom: "0",
						width: 0,
						height: 0,
						animation: hfState.recording
							? "dshVoiceOrbit 1.8s linear infinite"
							: "dshVoiceOrbit 5s linear infinite",
						zIndex: 41,
						pointerEvents: "none"
					}
				},
					react.createElement("span", {
						style: {
							position: "absolute",
							left: "-5px",
							top: "-48px", // 43 px orbit radius around the 72 px button
							width: "10px",
							height: "10px",
							borderRadius: "50%",
							background: hfState.recording ? "#dc2626" : "#22c55e",
							boxShadow: hfState.recording ? "0 0 6px rgba(220,38,38,0.9)" : "0 0 6px rgba(34,197,94,0.9)"
						}
					})
				));
			}

			// Wand state and handler live here now — the button sits south-west
			// of the record button, exactly like the original app.
			var wandPair = react.useState("idle");
			var wandStatus = wandPair[0];
			var setWandStatus = wandPair[1];
			function onWand() {
				var draft = draftRef.current.trim();
				if (!draft || wandStatus === "busy") return;
				setWandStatus("busy");
				fetch("/voice/wand", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text: draft })
				}).then(function (res) {
					return res.json().catch(function () { return { error: "wand http " + res.status }; });
				}).then(function (r) {
					if (r && r.text) actionsRef.current.setDraft(r.text);
					else {
						console.error("voice-wand:", r && r.error);
						setWandStatus("error");
						return;
					}
					setWandStatus("idle");
				}).catch(function (err) {
					console.error("voice-wand:", err);
					setWandStatus("error");
				});
			}
			var hasContent = props.input.draft.trim().length > 0;

			// Magic wand: round button south-west of the record button's lower
			// end, INSIDE the padded zone — it must never cover typed text.
			// The circle stays neutral zinc; only the ICON carries the purple
			// state color (a solid colored blob read as a weird blue smudge).
			children.push(react.createElement("button", {
				key: "wand",
				type: "button",
				title: wandStatus === "error"
					? "Wand failed — click to retry"
					: "Magic wand: restructure this draft with the current chat model",
				onClick: onWand,
				disabled: wandStatus === "busy" || !hasContent,
				style: {
					position: "absolute",
					left: "calc(50% - 100px)",
					bottom: "-58px",
					width: "44px",
					height: "44px",
					borderRadius: "50%",
					border: "none",
					outline: "none",
					display: "grid",
					placeItems: "center",
					cursor: hasContent && wandStatus !== "busy" ? "pointer" : "not-allowed",
					background: "#3f3f46",
					color: wandStatus === "error" ? "#f87171" : hasContent ? "#ffffff" : "#71717a",
					zIndex: 40
				}
			}, wandStatus === "busy"
				? icon("loader", 18, { animation: "dshVoiceOrbit 1s linear infinite" })
				: icon("wand", 18)));

			// Quick settings gear: round button south-east of the record
			// button's lower end, mirroring the wand inside the padded zone.
			children.push(react.createElement("button", {
				key: "gear",
				type: "button",
				title: "Voice quick settings",
				onClick: function () { setSettingsOpen(!settingsOpen); },
				style: {
					position: "absolute",
					left: "calc(50% + 56px)",
					bottom: "-58px",
					width: "44px",
					height: "44px",
					borderRadius: "50%",
					border: "none",
					outline: "none",
					display: "grid",
					placeItems: "center",
					cursor: "pointer",
					background: settingsOpen ? "#52525b" : "#3f3f46",
					color: "#e4e4e7",
					zIndex: 40
				}
			}, icon("settings", 18)));

			if (settingsOpen) {
				// Tap/click-outside dismiss: a backdrop under the popup (both
				// layouts) — dimmed on narrow (modal-like sheet), transparent
				// on desktop where it only intercepts the outside click.
				children.push(react.createElement("div", {
					key: "popup-backdrop",
					"aria-hidden": "true",
					onClick: function () { setSettingsOpen(false); },
					style: {
						position: "fixed",
						inset: 0,
						zIndex: 49,
						background: narrow ? "rgba(0,0,0,0.45)" : "transparent"
					}
				}));
				// On narrow screens the gear-relative popover (left: 50% + 56px,
				// minWidth 230px) overflows the right edge of the viewport and
				// the toggles render off-screen; span the composer width instead
				// (the PttDock root is a zero-height relative box as wide as the
				// composer, so left/right 0 hugs its full width).
				var popupStyle = narrow ? {
					position: "absolute",
					left: 0,
					right: 0,
					bottom: "-6px",
					background: "#18181b",
					border: "1px solid #3f3f46",
					borderRadius: "12px",
					padding: "12px 14px",
					zIndex: 50,
					boxShadow: "0 8px 24px rgba(0,0,0,0.5)"
				} : {
					position: "absolute",
					left: "calc(50% + 56px)",
					bottom: "-6px",
					minWidth: "230px",
					background: "#18181b",
					border: "1px solid #3f3f46",
					borderRadius: "8px",
					padding: "10px 12px",
					zIndex: 50,
					boxShadow: "0 8px 24px rgba(0,0,0,0.5)"
				};
				children.push(react.createElement("div", {
					key: "popup",
					style: popupStyle
				},
					react.createElement(Toggle, {
						label: "Auto-speak replies",
						on: prefsState.autoSpeak,
						onToggle: function () { togglePref("autoSpeak"); }
					}),
					react.createElement(Toggle, {
						label: "Voice-send phrase",
						on: prefsState.voiceSend,
						onToggle: function () { togglePref("voiceSend"); }
					}),
					react.createElement(Toggle, {
						label: "Hands-free listening",
						on: prefsState.handsFree,
						onToggle: function () { togglePref("handsFree"); }
					}),
					react.createElement("div", {
						style: { marginTop: "8px", fontSize: "12px", color: "#a1a1aa" }
					},
						react.createElement("div", {
							style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" }
						},
							react.createElement("span", null, "Mic sensitivity"),
							react.createElement("span", {
								style: { fontSize: "11px", color: "#71717a" }
							}, prefsState.vadThreshold.toFixed(3) + " — left is more sensitive")
						),
						react.createElement("input", {
							type: "range",
							min: "0.005",
							max: "0.08",
							step: "0.005",
							value: prefsState.vadThreshold,
							onChange: function (ev) { setVad(parseFloat(ev.target.value)); },
							style: { width: "100%", margin: "4px 0 0" }
						}),
						prefsState.handsFree
							? react.createElement(LevelMeter, { threshold: prefsState.vadThreshold })
							: null
					),
					react.createElement("div", {
						style: { marginTop: "8px", fontSize: "12px", color: "#a1a1aa" }
					},
						react.createElement("div", {
							style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" }
						},
							react.createElement("span", null, "Silence before closing"),
							react.createElement("span", {
								style: { fontSize: "11px", color: "#71717a" }
							}, (prefsState.vadSilenceMs / 1000).toFixed(1) + " s")
						),
						react.createElement("input", {
							type: "range",
							min: "1000",
							max: "8000",
							step: "500",
							value: prefsState.vadSilenceMs,
							onChange: function (ev) { setSilence(parseInt(ev.target.value, 10)); },
							style: { width: "100%", margin: "4px 0 0" }
						})
					),
					react.createElement("div", {
						style: { fontSize: "11px", color: "#71717a", marginTop: "6px", lineHeight: 1.4 }
					}, (prefsState.voiceSend
						? 'End a dictation with "thanks" or "bada bim bada boom" to send it.'
						: "Enable to send by ending a dictation with a trigger phrase.")
						+ (prefsState.handsFree
							? " Hands-free: the mic listens continuously; speaking records, silence sends to Whisper. Paused while Donna speaks."
							: ""))
				));
			}

			return react.createElement("div", {
				ref: rootRef,
				style: { position: "relative", height: 0, zIndex: 30 }
			}, children);
		}

		function SpeakControl(props) {
			var text = props.useSession(function (s) {
				var nodes = s.nodes;
				for (var i = nodes.length - 1; i >= 0; i--) {
					var n = nodes[i];
					if (n.kind === "assistant" && n.messageId === props.messageId) return blocksToText(n.blocks);
				}
				return "";
			});
			var time = props.useSession(function (s) {
				var nodes = s.nodes;
				for (var i = nodes.length - 1; i >= 0; i--) {
					var n = nodes[i];
					if (n.kind === "assistant" && n.messageId === props.messageId) return n.time;
				}
				return 0;
			});

			var stagePair = react.useState("idle");
			var stage = stagePair[0];
			var setStage = stagePair[1];
			var playPair = react.useState(false);
			var playing = playPair[0];
			var setPlaying = playPair[1];
			var progPair = react.useState(0);
			var progress = progPair[0];
			var setProgress = progPair[1];
			var canvasRef = react.useRef(null);
			var audioRef = react.useRef(null);
			var peaksRef = react.useRef(null);
			var spokenRef = react.useRef(false);

			react.useEffect(function () {
				if (stage === "ready" && canvasRef.current && peaksRef.current) {
					drawWaveform(canvasRef.current, peaksRef.current, progress);
				}
			});

			function generate(thenPlay) {
				if (!text || stage === "loading") return;
				setStage("loading");
				ttsFetchCount++;
				fetch("/voice/tts", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text: text })
				}).then(function (res) {
					if (!res.ok) throw new Error("tts http " + res.status);
					return res.arrayBuffer();
				}).then(function (buf) {
					var blob = new Blob([buf], { type: "audio/wav" });
					var url = URL.createObjectURL(blob);
					var audio = new Audio(url);
					liveAudio.add(audio);
					audio.ontimeupdate = function () {
						if (audio.duration && isFinite(audio.duration)) setProgress(audio.currentTime / audio.duration);
					};
					audio.onplay = function () { setPlaying(true); };
					audio.onpause = function () { setPlaying(false); };
					audio.onended = function () { liveAudio.delete(audio); setPlaying(false); setProgress(1); };
					audio.onerror = function () { liveAudio.delete(audio); };
					audioRef.current = audio;
					return computePeaks(blob, 80).catch(function () { return null; }).then(function (peaks) {
						peaksRef.current = peaks;
						setStage("ready");
						ttsFetchCount--;
						if (thenPlay) play();
					});
				}).catch(function (err) {
					console.error("voice-tts:", err);
					ttsFetchCount--;
					setStage("error");
				});
			}

			function play() {
				var audio = audioRef.current;
				if (!audio) return;
				stopCurrentAudio();
				currentAudio = audio;
				audio.currentTime = 0;
				audio.play().catch(function () {});
			}
			function pause() {
				if (audioRef.current) audioRef.current.pause();
			}
			function onSeek(ev) {
				var audio = audioRef.current;
				var canvas = canvasRef.current;
				if (!audio || !canvas || !audio.duration || !isFinite(audio.duration)) return;
				var rect = canvas.getBoundingClientRect();
				var fraction = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
				audio.currentTime = fraction * audio.duration;
				setProgress(fraction);
			}

			react.useEffect(function () {
				if (!prefs.autoSpeak) return;
				if (!text) return;
				if (spokenRef.current) return;
				// 5 s tolerance for clock skew between server and browser.
				if (time === 0 || time < bootTime - 5000) return;
				spokenRef.current = true;
				generate(true);
			}, []);

			if (!text) return null;

			if (stage === "idle") {
				return react.createElement("button", {
					onClick: function () { generate(true); },
					title: "Speak this message (donna)",
					style: Object.assign({}, btnStyle, { display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "#a1a1aa" })
				}, icon("volume", 14), "speak");
			}
			if (stage === "loading") {
				return react.createElement("span", {
					style: { display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "#71717a", padding: "2px 4px" }
				}, icon("loader", 13, { animation: "dshVoiceOrbit 1s linear infinite" }), "synthesizing…");
			}
			if (stage === "error") {
				return react.createElement("button", {
					onClick: function () { setStage("idle"); generate(true); },
					title: "Speech failed — click to retry",
					style: Object.assign({}, btnStyle, { display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "#f87171" })
				}, icon("refresh", 13), "retry");
			}
			return react.createElement("span", {
				style: { display: "flex", alignItems: "center", gap: "8px", flex: "1 1 auto", minWidth: "180px", width: "100%" }
			},
				react.createElement("button", {
					onClick: playing ? pause : play,
					title: playing ? "Pause" : "Play",
					style: {
						width: "22px",
						height: "22px",
						borderRadius: "50%",
						border: "none",
						outline: "none",
						background: "#2563eb",
						color: "#fff",
						cursor: "pointer",
						display: "grid",
						placeItems: "center",
						padding: 0,
						flexShrink: 0
					}
				}, icon(playing ? "pause" : "play", 10)),
				peaksRef.current
					? react.createElement("canvas", {
						ref: canvasRef,
						onClick: onSeek,
						style: { flex: "1 1 auto", width: "100%", height: "24px", cursor: "pointer", display: "block" }
					})
					: null
			);
		}
		//#endregion

		function NullCell() {
			// Occupies the shipped "feedback" cell (copy / thumbs up / thumbs
			// down) and renders nothing — the user wants that row gone so the
			// voice player has the strip to itself.
			return null;
		}

		function apply(ctx) {
			attachPushToTalk(ctx);
			ctx.effect(function () {
				return function () { handsFreeCtl.setActive(false); };
			});
			ctx.effect(function () {
				var style = document.createElement("style");
				style.textContent = "@keyframes dshVoiceOrbit{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}";
				document.head.appendChild(style);
				return function () { style.remove(); };
			});
			ctx.slots.inject("conversation.input.dock", function* () {
				yield ctx.slots.register({ name: "conversation.input.dock", id: "voice-ptt", priority: 0 }, PttDock);
			});
			ctx.slots.inject("conversation.chat.assistant-actions", function* () {
				yield ctx.slots.register({ name: "conversation.chat.assistant-actions", id: "voice-speak", priority: 20 }, SpeakControl);
				yield ctx.slots.register({ name: "conversation.chat.assistant-actions", id: "feedback", priority: -10 }, NullCell);
			});
		}
		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	}
});
