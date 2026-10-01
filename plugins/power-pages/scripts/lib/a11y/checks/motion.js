'use strict';

// WCAG 2.2.2 Pause, Stop, Hide (and the 2.3.3 intent behind prefers-reduced-motion).
//
// Emulates the "reduce motion" OS setting and then asks the browser which animations
// are still running. A carousel or hero animation that keeps moving forever while the
// user has asked for reduced motion is the common Power Pages defect here. Videos
// that autoplay without controls give users no way to pause them at all.
//
// document.getAnimations() covers CSS animations, CSS transitions and the Web
// Animations API. It does not see JavaScript-driven requestAnimationFrame loops or
// animated GIFs, hence heuristic.

const { makeFinding } = require('../report');

const LONG_ANIMATION_MS = 5000;
// How long to watch videos. Long enough for currentTime to advance several frames
// on a playing video, short enough to keep a crawl of many pages fast.
const PLAYBACK_SAMPLE_MS = 750;

async function findMotionInPage({ longMs, sampleMs }) {
  const h = window.__ppA11y;
  const running = [];
  for (const a of document.getAnimations()) {
    if (running.length >= 10) break;
    if (a.playState !== 'running') continue;
    const timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : {};
    const infinite = timing.iterations === Infinity;
    const total = Number(timing.endTime);
    if (!infinite && !(total > longMs)) continue;
    const target = a.effect && a.effect.target;
    if (!target || target.nodeType !== 1 || !h.isRendered(target)) continue;
    running.push({ target: h.cssPath(target), html: h.snippet(target), infinite, name: a.animationName || a.id || '' });
  }

  // Judge autoplay by what the video actually does, not by the autoplay attribute:
  // a site may honor reduced motion by pausing it, and a video without the attribute
  // may be started from script. A video is playing when it is not paused and its
  // playhead advances across the sample window.
  const candidates = Array.from(document.querySelectorAll('video')).filter((v) => !v.controls && h.isRendered(v));
  const before = candidates.map((v) => v.currentTime);
  if (candidates.length) await new Promise((resolve) => setTimeout(resolve, sampleMs));
  const videos = [];
  candidates.forEach((v, i) => {
    const playing = !v.paused && !v.ended && v.currentTime > before[i];
    if (!playing && !v.autoplay) return;
    // Muted short clips (under 5s, no loop) fall inside 2.2.2's 5-second allowance.
    if (v.muted && !v.loop && v.duration > 0 && v.duration <= 5) return;
    videos.push({ target: h.cssPath(v), html: h.snippet(v), muted: v.muted, playing });
  });
  return { running, videos };
}

function analyzeMotion({ running, videos }) {
  const findings = [];
  if (running.length) {
    findings.push(makeFinding({
      id: 'pp-motion-ignores-reduced-motion',
      impact: 'moderate',
      wcag: ['2.2.2'],
      heuristic: true,
      description: 'Animation keeps running when the user prefers reduced motion. Wrap it in @media (prefers-reduced-motion: no-preference) or provide a pause control.',
      helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html',
      nodes: running.map((r) => ({ target: r.target, html: r.html, summary: `${r.infinite ? 'Infinite' : 'Long'} animation${r.name ? ` "${r.name}"` : ''} is running with reduced motion enabled` })),
    }));
  }
  const playing = videos.filter((v) => v.playing);
  const notObserved = videos.filter((v) => !v.playing);
  if (playing.length) {
    // Unmuted autoplay is also a 1.4.2 Audio Control failure: sound that starts on its
    // own drowns out screen reader speech.
    const wcag = playing.some((v) => !v.muted) ? ['1.4.2', '2.2.2'] : ['2.2.2'];
    findings.push(makeFinding({
      id: 'pp-autoplay-video-no-controls',
      impact: 'serious',
      wcag,
      description: 'Video plays automatically and has no controls, so users cannot pause or stop it. Add the controls attribute or a visible pause button.',
      helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html',
      nodes: playing.map((v) => ({ target: v.target, html: v.html, summary: v.muted ? 'Muted video playing on its own without controls' : 'Video with sound playing on its own without controls' })),
    }));
  }
  if (notObserved.length) {
    // The autoplay attribute is set but nothing played during the audit. That can be
    // correct (the site pauses it for reduced motion) or an artifact of the browser's
    // autoplay policy, which can block unmuted autoplay without a user gesture, so a
    // person has to confirm it.
    // https://developer.chrome.com/blog/autoplay
    findings.push(makeFinding({
      id: 'pp-autoplay-video-no-controls',
      kind: 'needsReview',
      impact: 'moderate',
      wcag: notObserved.some((v) => !v.muted) ? ['1.4.2', '2.2.2'] : ['2.2.2'],
      heuristic: true,
      description: 'Video has the autoplay attribute and no controls, but it did not play during the audit. Confirm whether it plays for users; if it does, add controls or a pause button.',
      helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html',
      nodes: notObserved.map((v) => ({ target: v.target, html: v.html, summary: 'autoplay attribute set, no playback observed with reduced motion enabled' })),
    }));
  }
  return findings;
}

async function runMotionCheck(page) {
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // Give CSS media queries a frame to re-evaluate and cancel animations.
    await page.waitForTimeout(250);
    const result = await page.evaluate(findMotionInPage, { longMs: LONG_ANIMATION_MS, sampleMs: PLAYBACK_SAMPLE_MS });
    return { findings: analyzeMotion(result) };
  } finally {
    await page.emulateMedia({ reducedMotion: null });
  }
}

module.exports = { LONG_ANIMATION_MS, PLAYBACK_SAMPLE_MS, analyzeMotion, runMotionCheck };
