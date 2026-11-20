'use strict';

/**
 * The phone both plan pages draw beside the plan (the create build plan and the /edit-app progress
 * page): its shell, and the app area inside it where a screen mockup or the running app is laid out.
 *
 * It is an iPhone 18 Pro, the 6.3-inch model Apple has shipped since September 2026. The standard
 * iPhone 18 is expected later on the same 402-point width. Sizes are in points, the units an app
 * lays out in: Apple lists the panel as 2622 x 1206 pixels at 3x.
 * https://support.apple.com/en-us/148590
 * The safe areas (62 top, 34 bottom) and the 62-point display corner radius are the 402-point
 * iPhones' published values; the Dynamic Island is the 17 Pro's 126 x 37 pill made about 35%
 * narrower, as the 18 Pro's is.
 *
 * The screen mockup templates (shared/references/tamagui-html-mapping.md Section 4 and the design
 * system's preview template) draw the same phone in their own standalone HTML. Keep them in step.
 */
const PHONE = Object.freeze({
  model: 'iPhone 18 Pro',
  width: 402,
  height: 874,
  // Status bar and Dynamic Island. An app's content starts below it.
  statusBar: 62,
  // The home indicator's strip. An app's content ends above it.
  homeIndicator: 34,
  cornerRadius: 62,
  island: Object.freeze({ width: 82, height: 37, top: 11 }),
});

// The app area: what a screen mockup is drawn for, and the viewport the running app gets.
const APP_AREA = Object.freeze({ width: PHONE.width, height: PHONE.height - PHONE.statusBar - PHONE.homeIndicator });

const percent = (part, whole) => `${((part / whole) * 100).toFixed(4)}%`;

// Black glass around the screen, then a thin metal band. Real bezels are about 1.2 mm of glass and
// 1 mm of frame; at the size the plan draws the phone that is about 7 and 4 pixels.
const BEZEL_PX = 7;

// The status bar as Apple draws it in marketing images, in the 402-point coordinate space, so it
// scales with the phone: 9:41 in the left ear, the Dynamic Island, then signal, Wi-Fi and battery
// in the right ear, all vertically centred on the island. Glyphs use currentColor, which the page
// sets through --device-ink to match what is behind them; the island is black in either case.
const ISLAND_X = (PHONE.width - PHONE.island.width) / 2;
const STATUS_BAR_SVG = `<svg class="device-status" viewBox="0 0 ${PHONE.width} ${PHONE.statusBar}" aria-hidden="true" focusable="false">`
  + '<text x="81" y="35.5" text-anchor="middle">9:41</text>'
  + `<rect class="device-island" x="${ISLAND_X}" y="${PHONE.island.top}" width="${PHONE.island.width}" height="${PHONE.island.height}" rx="${PHONE.island.height / 2}"/>`
  + '<rect x="286" y="30.5" width="3" height="4.5" rx="0.9"/><rect x="290.8" y="28.4" width="3" height="6.6" rx="0.9"/>'
  + '<rect x="295.6" y="26.2" width="3" height="8.8" rx="0.9"/><rect x="300.4" y="24" width="3" height="11" rx="0.9"/>'
  + '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M309.8 28.4a9.8 9.8 0 0 1 13.8 0M312.6 31.2a5.8 5.8 0 0 1 8.2 0"/>'
  + '<circle cx="316.7" cy="34" r="1.5"/>'
  + '<rect x="330.5" y="24" width="24" height="11.5" rx="3.6" fill="none" stroke="currentColor" stroke-opacity="0.4"/>'
  + '<rect x="332.5" y="26" width="20" height="7.5" rx="2"/>'
  + '<path d="M356 28.2v3.4a1.9 1.9 0 0 0 0-3.4z" fill-opacity="0.45"/>'
  + '</svg>';

const HOME_INDICATOR_SVG = `<svg class="device-home" viewBox="0 0 ${PHONE.width} ${PHONE.homeIndicator}" aria-hidden="true" focusable="false">`
  + `<rect x="${(PHONE.width - 134) / 2}" y="21" width="134" height="5" rx="2.5"/>`
  + '</svg>';

/**
 * The shell's stylesheet. The page sizes `.device` by its screen: the shell uses content-box
 * sizing, so the bezel sits outside whatever height the page gives it, and the screen keeps the
 * phone's exact proportions at every size.
 */
function phoneShellCss() {
  const top = percent(PHONE.statusBar, PHONE.height);
  const bottom = percent(PHONE.homeIndicator, PHONE.height);
  const radiusX = percent(PHONE.cornerRadius, PHONE.width);
  const radiusY = percent(PHONE.cornerRadius, PHONE.height);
  // Left: Action button, volume up, volume down. Right: side button, Camera Control. Each pair of
  // stops is one button, as a fraction of the screen's height.
  const buttons = (spans) => `linear-gradient(to bottom,${spans.map(([from, to]) => (
    `transparent ${from}%,var(--device-button) ${from}%,var(--device-button) ${to}%,transparent ${to}%`
  )).join(',')})`;
  return [
    `.device{--device-ink:#000;--device-button:#6a6d73;position:relative;box-sizing:content-box;aspect-ratio:${PHONE.width}/${PHONE.height};`
      + `flex:0 1 606px;min-height:346px;max-height:606px;width:auto;max-width:calc(100vw - 72px);`
      + `border:${BEZEL_PX}px solid #050506;border-radius:calc(${radiusX} + ${BEZEL_PX}px)/calc(${radiusY} + ${BEZEL_PX}px);background:#050506;`
      + 'box-shadow:0 0 0 1px #1c1d20,0 0 0 3.5px #7d8087,0 0 0 4.5px #3c3e43,0 2px 4px rgba(0,0,0,.14),0 18px 46px rgba(0,0,0,.22);}',
    '.device[data-tone="dark"]{--device-ink:#fff;}',
    // The live app follows the browser's colour scheme, and so does its frame: a cross-origin
    // frame in this page reads the same prefers-color-scheme as the page.
    '@media (prefers-color-scheme:dark){.device[data-tone="system"]{--device-ink:#fff;}}',
    '.device::before,.device::after{content:"";position:absolute;top:0;bottom:0;width:3px;border-radius:2px;pointer-events:none;}',
    `.device::before{left:-${BEZEL_PX + 6}px;background:${buttons([[17, 21.5], [27, 34.5], [37.5, 45]])};}`,
    `.device::after{right:-${BEZEL_PX + 6}px;background:${buttons([[28, 40], [60, 68]])};}`,
    // The status and home-indicator heights as container units, for content that fills the whole
    // screen and must keep clear of both, such as the QR code.
    `.device-screen{position:absolute;inset:0;background:#faf9f8;overflow:hidden;container-type:size;border-radius:${radiusX}/${radiusY};`
      + `--device-status-bar:${(PHONE.statusBar / PHONE.height * 100).toFixed(4)}cqh;--device-home-bar:${(PHONE.homeIndicator / PHONE.height * 100).toFixed(4)}cqh;}`,
    '.device-status,.device-home{position:absolute;left:0;width:100%;height:auto;color:var(--device-ink);fill:currentColor;pointer-events:none;z-index:5;}',
    '.device-status{top:0;font:600 17px -apple-system,"SF Pro Text","Segoe UI",system-ui,sans-serif;}',
    '.device-status .device-island{fill:#000;}',
    '.device-home{bottom:0;}',
    // A screen mockup or the running app goes here, between the status bar and the home indicator,
    // as an app's content does on the phone. `contain: paint` keeps a mockup's fixed-position
    // elements inside the phone. https://developer.mozilla.org/en-US/docs/Web/CSS/contain
    `.device-app{position:absolute;left:0;right:0;top:${top};bottom:${bottom};overflow:hidden;contain:layout paint;}`,
    `.device-app iframe{position:absolute;width:${APP_AREA.width}px;height:${APP_AREA.height}px;border:0;transform-origin:top left;}`,
  ].join('\n');
}

/**
 * The shell's markup. `content` is trusted, code-owned markup for the screen, already escaped by
 * the caller. `tone` is the starting ink for the status bar and home indicator: `light` draws dark
 * glyphs for a light screen, `dark` the reverse, and `system` follows the browser's colour scheme.
 */
function phoneShellMarkup({ screenId = '', content = '', tone = 'light' } = {}) {
  if (!/^(?:light|dark|system)$/.test(tone)) throw new Error(`Unknown phone tone '${tone}'`);
  if (screenId && !/^[A-Za-z][\w-]*$/.test(screenId)) throw new Error(`Invalid screen id '${screenId}'`);
  return `<div class="device" id="device" data-tone="${tone}">`
    + `<div class="device-screen"${screenId ? ` id="${screenId}"` : ''}>${content}</div>`
    + STATUS_BAR_SVG + HOME_INDICATOR_SVG
    + '</div>';
}

module.exports = { APP_AREA, PHONE, phoneShellCss, phoneShellMarkup };
