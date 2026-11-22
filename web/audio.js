import { createElement } from './utils.js';

/*
 * Audio for tiles, list rows and the lens: one shared player (only one sound at a time), a waveform drawn from the
 * decoded file, and a small control (play button, waveform you can click to seek, time).
 * Everything runs in the browser against files the ComfyUI server already serves; nothing is requested elsewhere.
 */

const TILE_MAX_BYTES = 6 * 1024 * 1024; // bigger files get a placeholder wave instead of a full decode
const LENS_MAX_BYTES = 40 * 1024 * 1024;
const CACHE_LIMIT = 400;
const DECODE_SLOTS = 2;

const waveCache = new Map(); // "url|bars" -> { bars: number[], duration: number } | null (could not be decoded)
const waveInflight = new Map();
const waveQueue = [];
let waveActive = 0;

const mulberry32 = (seed) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Stable fake bars (same file, same picture) for files that cannot be decoded or are too big. */
export const placeholderBars = (seedText, count) => {
  let seed = 2166136261;
  for (let i = 0; i < seedText.length; i += 1) seed = Math.imul(seed ^ seedText.charCodeAt(i), 16777619);
  const random = mulberry32(seed >>> 0);
  return Array.from({ length: count }, () => 0.15 + random() * 0.7);
};

const barsFromBuffer = (buffer, count) => {
  const data = buffer.getChannelData(0);
  const size = data.length;
  if (!size) return placeholderBars("empty", count);
  const means = [];
  for (let bar = 0; bar < count; bar += 1) {
    const start = Math.floor((bar * size) / count);
    const end = Math.max(start + 1, Math.floor(((bar + 1) * size) / count));
    let sum = 0;
    for (let index = start; index < end && index < size; index += 1) sum += Math.abs(data[index]);
    means.push(sum / (end - start));
  }
  const peak = Math.max(...means) || 1;
  return means.map((mean) => Math.max(0.08, Math.pow(mean / peak, 0.7)));
};

const decodeWave = async (url, count, maxBytes) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) return null;
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maxBytes) return null;
  const Context = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Context) return null;
  const buffer = await new Context(1, 1, 44100).decodeAudioData(bytes);
  return { bars: barsFromBuffer(buffer, count), duration: buffer.duration };
};

const pumpWaveQueue = () => {
  while (waveActive < DECODE_SLOTS && waveQueue.length) {
    const job = waveQueue.shift();
    waveActive += 1;
    decodeWave(job.url, job.count, job.maxBytes)
      .catch(() => null)
      .then((result) => job.resolve(result))
      .finally(() => {
        waveActive -= 1;
        pumpWaveQueue();
      });
  }
};

const WAVE_ABANDONED = Symbol("abandoned");

/**
 * Waveform bars and duration of a file, or null when it is too big or cannot be decoded. Cached.
 * `signal` (AbortSignal): when every caller waiting for a file has aborted before its download started, the
 * download is dropped (tiles scrolled past never cost a fetch) and the promise resolves with null, uncached.
 */
export const getWaveform = (url, count, { lens = false, signal = null } = {}) => {
  const key = `${url}|${count}`;
  if (waveCache.has(key)) return Promise.resolve(waveCache.get(key));
  let entry = waveInflight.get(key);
  if (!entry) {
    const job = { url, count, maxBytes: lens ? LENS_MAX_BYTES : TILE_MAX_BYTES, started: false, resolve: null };
    const promise = new Promise((resolve) => {
      job.resolve = resolve;
      waveQueue.push(job);
      pumpWaveQueue();
    }).then((result) => {
      waveInflight.delete(key);
      if (result === WAVE_ABANDONED) return null;
      waveCache.set(key, result);
      if (waveCache.size > CACHE_LIMIT) waveCache.delete(waveCache.keys().next().value);
      return result;
    });
    entry = { promise, job, refs: 0 };
    waveInflight.set(key, entry);
  }
  entry.refs += 1;
  if (signal) {
    const release = () => {
      entry.refs -= 1;
      const index = waveQueue.indexOf(entry.job);
      if (entry.refs <= 0 && index !== -1) {
        waveQueue.splice(index, 1);
        entry.job.resolve(WAVE_ABANDONED);
      }
    };
    if (signal.aborted) release();
    else signal.addEventListener("abort", release, { once: true });
  }
  return entry.promise;
};

export const formatTime = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/** The single audio element behind every play button. Views subscribe by key and redraw on each change. */
class AudioPlayback {
  constructor() {
    this.element = null;
    this.key = null;
    this.listeners = new Map(); // key -> Set<fn>
    this.frame = 0;
  }

  ensure() {
    if (this.element) return this.element;
    const element = new Audio();
    element.preload = "metadata";
    const notify = () => this.emit();
    ["play", "pause", "ended", "loadedmetadata", "durationchange", "volumechange", "seeked", "error"].forEach((name) =>
      element.addEventListener(name, notify)
    );
    element.addEventListener("play", () => this.startFrames());
    this.element = element;
    return element;
  }

  startFrames() {
    cancelAnimationFrame(this.frame);
    const tick = () => {
      this.emit();
      if (this.element && !this.element.paused && !this.element.ended) this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  snapshot(key) {
    const element = this.element;
    const own = Boolean(element) && this.key === key;
    return {
      active: own,
      playing: own && !element.paused && !element.ended,
      time: own ? element.currentTime : 0,
      duration: own && Number.isFinite(element.duration) ? element.duration : NaN,
      volume: element ? element.volume : 1,
      muted: element ? element.muted : false,
    };
  }

  emit() {
    if (this.key !== null) this.listeners.get(this.key)?.forEach((fn) => fn(this.snapshot(this.key)));
    this.listeners.get("*")?.forEach((fn) => fn(this.snapshot(this.key)));
  }

  subscribe(key, fn) {
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(fn);
    fn(this.snapshot(key));
    return () => {
      const set = this.listeners.get(key);
      set?.delete(fn);
      if (set && !set.size) this.listeners.delete(key);
    };
  }

  /** Make `key` the current sound. Returns true when the source changed. */
  select(key, url) {
    const element = this.ensure();
    if (this.key === key) return false;
    const previous = this.key;
    this.key = key;
    element.src = url;
    if (previous !== null) this.listeners.get(previous)?.forEach((fn) => fn(this.snapshot(previous)));
    return true;
  }

  toggle(key, url) {
    const element = this.ensure();
    if (this.select(key, url) || element.paused || element.ended) {
      if (element.ended) element.currentTime = 0;
      element.play().catch(() => {});
    } else {
      element.pause();
    }
  }

  seek(key, url, fraction) {
    const element = this.ensure();
    const changed = this.select(key, url);
    const apply = () => {
      if (Number.isFinite(element.duration)) element.currentTime = Math.min(Math.max(fraction, 0), 1) * element.duration;
      element.play().catch(() => {});
    };
    if (changed || !Number.isFinite(element.duration)) {
      element.addEventListener("loadedmetadata", apply, { once: true });
    } else {
      apply();
    }
  }

  stop() {
    if (!this.element) return;
    const previous = this.key;
    this.element.pause();
    this.element.removeAttribute("src");
    this.element.load();
    this.key = null;
    if (previous !== null) this.listeners.get(previous)?.forEach((fn) => fn(this.snapshot(previous)));
  }

  setVolume(value) {
    const element = this.ensure();
    element.volume = Math.min(Math.max(value, 0), 1);
    if (element.volume > 0) element.muted = false;
  }

  toggleMuted() {
    const element = this.ensure();
    element.muted = !element.muted;
  }
}

export const playback = new AudioPlayback();

const paintWave = (canvas, bars, progress) => {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  if (!canvas._colors) {
    const style = getComputedStyle(canvas);
    canvas._colors = {
      played: style.getPropertyValue("--assets-plus-wave-played").trim() || "#ffffff",
      idle: style.getPropertyValue("--assets-plus-wave-idle").trim() || "rgba(255,255,255,0.35)",
    };
  }
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const count = bars.length;
  const slot = width / count;
  const barWidth = Math.max(1, slot * 0.62);
  const playedUntil = progress * count;
  for (let index = 0; index < count; index += 1) {
    const barHeight = Math.max(2, bars[index] * height);
    context.fillStyle = index < playedUntil ? canvas._colors.played : canvas._colors.idle;
    context.fillRect(index * slot + (slot - barWidth) / 2, (height - barHeight) / 2, barWidth, barHeight);
  }
};

/**
 * Play button + waveform + time for one audio item.
 *   variant   "tile" | "row" | "lens"
 *   options   { key, url, label, bars, prev, next }  (prev/next: lens only, called by the transport buttons)
 * Returns { element, destroy }. Call destroy when the element is thrown away.
 */
export const createAudioControl = (variant, { key, url, label, bars: barCount = 40, prev, next, labels = {} }) => {
  const root = createElement("div", { className: `assets-plus-audio assets-plus-audio-${variant}` });
  const stop = (event) => event.stopPropagation();
  ["click", "dblclick", "mousedown", "pointerdown", "dragstart"].forEach((name) => root.addEventListener(name, stop));
  root.draggable = false;

  const iconButton = (icon, title, className = "") => {
    const button = createElement("button", {
      className: `assets-plus-audio-button ${className}`.trim(),
      attrs: { type: "button", title, "aria-label": title },
    });
    button.innerHTML = `<i class="pi ${icon}"></i>`;
    return button;
  };

  const playButton = iconButton("pi-play", labels.play || "Play", "assets-plus-audio-play");
  const canvas = createElement("canvas", { className: "assets-plus-audio-wave" });
  canvas.draggable = false;
  const timeLabel = createElement("span", { className: "assets-plus-audio-time", text: "0:00 / --:--" });

  let bars = placeholderBars(url, barCount);
  let duration = NaN;
  let snapshot = playback.snapshot(key);
  let destroyed = false;

  const redraw = () => {
    if (destroyed) return;
    const total = Number.isFinite(snapshot.duration) ? snapshot.duration : duration;
    const progress = snapshot.active && total ? Math.min(1, snapshot.time / total) : 0;
    paintWave(canvas, bars, progress);
    const icon = playButton.firstChild;
    const playing = snapshot.playing;
    icon.className = `pi ${playing ? "pi-pause" : "pi-play"}`;
    const title = playing ? labels.pause || "Pause" : labels.play || "Play";
    playButton.title = title;
    playButton.setAttribute("aria-label", title);
    const current = snapshot.active ? snapshot.time : 0;
    timeLabel.textContent =
      variant === "lens"
        ? `${formatTime(current)}`
        : `${formatTime(current)} / ${formatTime(total)}`;
    if (endLabel) endLabel.textContent = formatTime(total);
  };

  let endLabel = null;
  playButton.addEventListener("click", () => playback.toggle(key, url));
  canvas.addEventListener("pointerdown", (event) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    playback.seek(key, url, (event.clientX - rect.left) / rect.width);
  });

  if (variant === "lens") {
    const waveBox = createElement("div", { className: "assets-plus-audio-wavebox" });
    waveBox.appendChild(canvas);
    const times = createElement("div", { className: "assets-plus-audio-times" });
    endLabel = createElement("span", { className: "assets-plus-audio-time", text: "--:--" });
    times.appendChild(timeLabel);
    times.appendChild(endLabel);
    const transport = createElement("div", { className: "assets-plus-audio-transport" });
    const prevButton = iconButton("pi-step-backward", labels.prev || "Previous");
    const nextButton = iconButton("pi-step-forward", labels.next || "Next");
    prevButton.addEventListener("click", () => prev?.());
    nextButton.addEventListener("click", () => next?.());
    const volume = createElement("div", { className: "assets-plus-audio-volume" });
    const muteButton = iconButton("pi-volume-up", labels.mute || "Mute");
    const slider = createElement("input", {
      className: "assets-plus-audio-slider",
      attrs: { type: "range", min: "0", max: "1", step: "0.02", "aria-label": labels.volume || "Volume" },
    });
    slider.value = String(snapshot.muted ? 0 : snapshot.volume);
    slider.addEventListener("input", () => playback.setVolume(Number(slider.value)));
    muteButton.addEventListener("click", () => playback.toggleMuted());
    volume.appendChild(muteButton);
    volume.appendChild(slider);
    transport.appendChild(createElement("span"));
    const centre = createElement("div", { className: "assets-plus-audio-centre" });
    centre.appendChild(prevButton);
    centre.appendChild(playButton);
    centre.appendChild(nextButton);
    transport.appendChild(centre);
    transport.appendChild(volume);
    root.appendChild(waveBox);
    root.appendChild(times);
    root.appendChild(transport);
    root._syncVolume = (state) => {
      slider.value = String(state.muted ? 0 : state.volume);
      muteButton.firstChild.className = `pi ${state.muted || state.volume === 0 ? "pi-volume-off" : "pi-volume-up"}`;
    };
  } else {
    root.appendChild(playButton);
    root.appendChild(canvas);
    root.appendChild(timeLabel);
  }
  root.title = label || "";

  // A control whose tile was thrown away without destroy() is dropped at the next change instead of leaking.
  let wasConnected = false;
  const unsubscribe = playback.subscribe(key, (state) => {
    if (root.isConnected) wasConnected = true;
    else if (wasConnected) {
      destroyed = true;
      waveAbort.abort();
      unsubscribe();
      observer?.disconnect();
      return;
    }
    snapshot = state;
    root._syncVolume?.(state);
    redraw();
  });

  const waveAbort = new AbortController();
  getWaveform(url, barCount, { lens: variant === "lens", signal: waveAbort.signal }).then((result) => {
    if (destroyed) return;
    if (result) {
      bars = result.bars;
      duration = result.duration;
    }
    redraw();
  });

  // The canvas has no size until it is in the page; draw once it gets one and whenever it changes.
  let observer = null;
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => redraw());
    observer.observe(canvas);
  }
  requestAnimationFrame(redraw);

  return {
    element: root,
    destroy() {
      destroyed = true;
      waveAbort.abort(); // a tile that left the page must not keep a download queued
      unsubscribe();
      observer?.disconnect();
    },
  };
};
