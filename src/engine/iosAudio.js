// iOS/Safari audio helpers for pages that play through createLiveEngine (or
// any other Web Audio code). Two separate reasons playback is silent on an
// iPhone:
//
// 1. The ring/silent switch: iOS puts Web Audio in the "ambient" audio
//    session, which the silent switch mutes, while <audio>/<video> play in
//    the "playback" session, which ignores it. Safari 17+ lets a page opt in
//    via navigator.audioSession.type = 'playback'; older iOS gets the same
//    effect from a silent looping <audio> element, which moves the whole
//    page to the "playback" session. Both have to start inside a tap.
//
// 2. Autoplay: createLiveEngine builds its AudioContext after an `await`,
//    i.e. outside the tap that asked for sound, so iOS may leave it
//    suspended until a later gesture. A call or Siri also interrupts a
//    running context.
//
// playThroughSilentSwitch() fixes (1) for one playback; call it
// synchronously in the tap handler, before any await. installIOSAudioUnlock()
// is the app-wide variant for editors that make sound on every touch: it
// fixes (1) on every gesture and (2) by resuming every AudioContext the page
// creates.

const GESTURE_EVENTS = ['pointerdown', 'touchend', 'mousedown', 'keydown', 'click'];

// iPadOS reports itself as a Mac; touch support gives it away.
export function isIOS() {
  const nav = globalThis.navigator;
  if (!nav) return false;
  return /iPad|iPhone|iPod/.test(nav.userAgent) || (/Mac/.test(nav.userAgent) && nav.maxTouchPoints > 1);
}

// 0.5 s of 8 kHz 8-bit mono silence as a WAV data URI.
function silentWavDataUri() {
  const samples = 4000;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeAscii(36, 'data');
  view.setUint32(40, samples, true);
  bytes.fill(0x80, 44);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

let keepAlive = null;

// playThroughSilentSwitch(true) declares the page's sound as media playback
// so iOS plays it with the silent switch on; playThroughSilentSwitch(false)
// hands the page back to the default session. Best effort and a no-op
// outside Safari/iOS: without it iOS simply follows the silent switch.
export function playThroughSilentSwitch(on) {
  try {
    const audioSession = globalThis.navigator?.audioSession;
    if (audioSession) {
      audioSession.type = on ? 'playback' : 'auto';
      return;
    }
    if (!isIOS() || typeof Audio === 'undefined') return;
    if (on) {
      if (!keepAlive) {
        keepAlive = new Audio(silentWavDataUri());
        keepAlive.loop = true;
        keepAlive.setAttribute('playsinline', '');
        keepAlive.setAttribute('x-webkit-airplay', 'deny');
      }
      keepAlive.play().catch(() => {});
    } else if (keepAlive) {
      keepAlive.pause();
    }
  } catch {
    // Unsupported in this browser.
  }
}

// installIOSAudioUnlock() keeps the page in the playback session and resumes
// any suspended or interrupted AudioContext on every tap or key press and
// when the page becomes visible again. Call it once at startup, before
// anything creates an AudioContext: it wraps the AudioContext constructor to
// track the contexts the app and this library create.
export function installIOSAudioUnlock() {
  if (typeof window === 'undefined' || window.__rasterklangAudioUnlockInstalled) return;
  window.__rasterklangAudioUnlockInstalled = true;

  const contexts = new Set();

  function resumeAll() {
    for (const ref of contexts) {
      const ctx = ref.deref();
      if (!ctx || ctx.state === 'closed') {
        contexts.delete(ref);
        continue;
      }
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
    }
  }

  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const Native = window[name];
    if (typeof Native !== 'function') continue;
    const Tracked = class extends Native {
      constructor(...args) {
        super(...args);
        contexts.add(new WeakRef(this));
        // Usually still inside the gesture's activation window on modern
        // Safari; if not, the next gesture's resumeAll() picks it up.
        if (this.state !== 'running') this.resume().catch(() => {});
      }
    };
    Object.defineProperty(Tracked, 'name', { value: name });
    window[name] = Tracked;
  }

  function onGesture() {
    if (!document.hidden) playThroughSilentSwitch(true);
    resumeAll();
  }

  for (const type of GESTURE_EVENTS) {
    window.addEventListener(type, onGesture, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resumeAll();
  });
}
