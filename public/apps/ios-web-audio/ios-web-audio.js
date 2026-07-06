// ios-web-audio.js — make Web Audio reliably audible on iOS Safari.
// Zero dependencies. ES module. ~1 KB.
//
// iOS silences and locks Web Audio in three ways that don't exist on desktop,
// and all three have to be handled or you get the classic "the code runs, the
// AudioContext says it started, but nothing plays" bug. Every browser on iOS is
// WebKit under the hood, so this applies to Safari, Chrome, Brave, Firefox — all
// of them. The three moves:
//
//   1. THE GESTURE  Start audio on a gesture that *completes* (pointerup /
//                   touchend / click), never pointerdown. A pointerdown might
//                   still turn into a scroll, so iOS withholds audio activation
//                   until the gesture finishes — resume() from a pointerdown
//                   handler silently no-ops and the context stays 'suspended'.
//
//   2. THE RETRY    A single resume() often leaves iOS 'suspended'. Retry a few
//                   times until state === 'running', and re-resume whenever iOS
//                   'interrupted's the session (calls, Siri, route changes).
//
//   3. THE SESSION  Set navigator.audioSession.type = 'playback' (iOS 16.4+) so
//                   output rides the media channel and the hardware ringer/mute
//                   switch no longer silences it (WebKit bug 237322).
//
// Usage:
//   import { makeUnlockableAudioContext } from './ios-web-audio.js';
//   const audio = makeUnlockableAudioContext();
//   button.addEventListener('pointerup', async () => {
//     const running = await audio.unlock();   // call from the gesture
//     // ...build your graph on audio.ctx and start playing...
//   });

/**
 * Create an AudioContext wired for reliable startup on iOS.
 * @param {object} [options]
 * @param {string} [options.sessionType='playback'] navigator.audioSession type.
 * @param {number} [options.maxResumeTries=6] resume() attempts before giving up.
 * @param {number} [options.retryDelayMs=60]  wait between resume() attempts.
 * @returns {{ ctx: AudioContext, unlock: () => Promise<boolean>, resume: () => Promise<boolean> }}
 */
export function makeUnlockableAudioContext(options = {}) {
  const {
    sessionType = 'playback',
    maxResumeTries = 6,
    retryDelayMs = 60,
  } = options;

  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();

  // THE SESSION — iOS 16.4+ only; a harmless no-op everywhere else.
  function setSession() {
    try {
      if (navigator.audioSession) navigator.audioSession.type = sessionType;
    } catch {
      /* older/unsupported — nothing to do */
    }
  }

  // THE RETRY — loop resume() until the context actually reports 'running'.
  async function resume() {
    for (let i = 0; i < maxResumeTries && ctx.state !== 'running'; i++) {
      try { await ctx.resume(); } catch { /* keep trying */ }
      if (ctx.state !== 'running') {
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
    return ctx.state === 'running';
  }

  // iOS drops the context to 'interrupted' / 'suspended' on calls, Siri, and
  // audio-route changes; pull it back on its own without waiting for a re-tap.
  ctx.addEventListener('statechange', () => {
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      ctx.resume().catch(() => {});
    }
  });

  // Call this from inside a completed-gesture handler (see THE GESTURE).
  async function unlock() {
    setSession();
    return resume();
  }

  return { ctx, unlock, resume };
}

/**
 * Convenience: unlock on the first completed gesture, then stop listening.
 * Attaches to pointerup / touchend / click (all gesture-completion events).
 * @param {{ unlock: () => Promise<boolean> }} handle from makeUnlockableAudioContext
 * @param {EventTarget} [target=window]
 * @returns {() => void} a function that removes the listeners early if needed
 */
export function unlockOnFirstGesture(handle, target = window) {
  const events = ['pointerup', 'touchend', 'click'];
  const teardown = () => events.forEach((e) => target.removeEventListener(e, once));
  async function once() {
    if (await handle.unlock()) teardown(); // idempotent; safe if it double-fires
  }
  events.forEach((e) => target.addEventListener(e, once));
  return teardown;
}

/**
 * Best-effort platform label for diagnostics. Detects iPadOS (which reports as
 * desktop Safari) via the MacIntel + touch-points quirk.
 * @returns {{ isIOS: boolean, label: string }}
 */
export function detectPlatform() {
  const ua = navigator.userAgent;
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const isIOS = /iP(hone|od|ad)/.test(ua) || iPadOS;
  if (isIOS) {
    const m = ua.match(/OS (\d+)[_.](\d+)/);
    return { isIOS: true, label: m ? `iOS ${m[1]}.${m[2]}` : 'iOS' };
  }
  if (/Android/.test(ua)) return { isIOS: false, label: 'Android' };
  return { isIOS: false, label: 'Desktop' };
}
