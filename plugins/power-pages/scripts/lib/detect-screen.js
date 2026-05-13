#!/usr/bin/env node

// Detects the primary monitor's resolution per platform with safe fallback.
// Used by the Playwright MCP launcher to size the browser window and viewport
// to fill the user's actual screen instead of Playwright's 1280x720 default.

const { execSync } = require('child_process');
const os = require('os');

// Conservative fallback for unknown environments — fits on a 13" laptop.
const FALLBACK = { width: 1440, height: 900 };

function tryExec(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

function parseFirstWxH(text) {
  if (!text) return null;
  // Match "1920 x 1080", "1920x1080", or "Resolution: 1920 x 1080 ..."
  const m = text.match(/(\d{3,5})\s*[x×]\s*(\d{3,5})/i);
  if (!m) return null;
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 640 || h < 480) return null;
  return { width: w, height: h };
}

// Parse a single display's text block and return its logical/CSS-pixel size —
// the unit Chrome's `--window-size` flag and Playwright's `viewport` both
// consume. Returns null when the block has no recognizable resolution.
//
// Example block text for a built-in Retina panel at the default scaling:
//   Display Type: Built-in Liquid Retina XDR Display
//   Resolution: 3456 x 2234 Retina
//   Main Display: Yes
//
// Example block text for an external 5K display scaled to 1440p logical:
//   Resolution: 5120 x 2880 (5K/UHD+ - Ultra High Definition Plus)
//   UI Looks like: 2560 x 1440 @ 120.00Hz
//
// Priority order matters: "UI Looks like" is the post-scaling logical size
// the OS reports to apps and always wins. A plain "Resolution: W x H Retina"
// without "UI Looks like" means the built-in panel is at the *default* Retina
// scaling, which maps 2 physical pixels to 1 point, so we halve it. See
// https://developer.apple.com/library/archive/documentation/GraphicsAnimation/Conceptual/HighResolutionOSX/Explained/Explained.html
function parseMacDisplayBlock(text) {
  if (!text) return null;
  const matchSize = (regex, scale = 1) => {
    const m = text.match(regex);
    if (!m) return null;
    return {
      width: Math.round(parseInt(m[1], 10) / scale),
      height: Math.round(parseInt(m[2], 10) / scale),
    };
  };
  return (
    matchSize(/UI Looks like:\s*(\d+)\s*[x×]\s*(\d+)/i)
    || matchSize(/Resolution:\s*(\d+)\s*[x×]\s*(\d+)\s+Retina\b/i, 2)
    || matchSize(/Resolution:\s*(\d+)\s*[x×]\s*(\d+)/i)
  );
}

// Split `system_profiler SPDisplaysDataType` output into one block per
// display and flag the one carrying `Main Display: Yes`. The launcher opens
// Chrome at `--window-position=0,0`, which on macOS lands on the main display
// regardless of which monitor the user's mouse is on — so on multi-monitor
// setups the launcher must size to the **main** display, not the first one
// system_profiler lists.
//
// Output shape:
//   Graphics/Displays:
//       Apple M5 Max:
//         Displays:
//           Color LCD:
//             Resolution: 3456 x 2234 Retina
//             Main Display: Yes
//           DELL U2725QE:
//             Resolution: 5120 x 2880 (5K/UHD+ ...)
//             UI Looks like: 2560 x 1440 @ 120.00Hz
//
// Display name lines are at one indent deeper than `Displays:` and end with
// a single trailing colon. The key/value lines belonging to a display sit
// deeper still.
function parseMacDisplayBlocks(out) {
  if (!out) return [];
  const blocks = [];
  let current = null;
  // `null` = not inside a `Displays:` section; otherwise the indent of the
  // section header so child-vs-sibling lines can be distinguished.
  let displaysIndent = null;
  const flush = () => {
    if (current) blocks.push(current);
    current = null;
  };

  for (const line of out.split('\n')) {
    const indent = (line.match(/^(\s*)/)[1] || '').length;

    if (/^\s*Displays:\s*$/.test(line)) {
      // Reset on every "Displays:" header so a system_profiler with multiple
      // GPUs (each listing its own displays) still parses correctly.
      flush();
      displaysIndent = indent;
      continue;
    }

    if (displaysIndent === null) continue;
    if (line.trim() === '') continue;

    if (indent <= displaysIndent) {
      // Dropped back to (or above) the section header indent → out of section.
      flush();
      displaysIndent = null;
      continue;
    }

    // Display name lines look like `      <Display Name>:` — sibling indent,
    // single trailing colon, no value after.
    const nameLine = line.match(/^(\s*)([^:\n]+):\s*$/);
    if (nameLine && nameLine[1].length === displaysIndent + 2) {
      flush();
      current = { name: nameLine[2].trim(), text: '', isMain: false };
      continue;
    }

    if (current) {
      current.text += line + '\n';
      if (/Main Display:\s*Yes/i.test(line)) current.isMain = true;
    }
  }
  flush();
  return blocks;
}

function detectMacOS() {
  // system_profiler is slower (~1s) but reliable.
  const out = tryExec('system_profiler SPDisplaysDataType 2>/dev/null');
  if (!out) return null;

  const blocks = parseMacDisplayBlocks(out);
  if (blocks.length === 0) {
    // Structured parse failed (unexpected output shape) — fall back to the
    // first resolution in the raw output, mirroring the historical behavior.
    return parseMacDisplayBlock(out);
  }

  // Prefer the display flagged `Main Display: Yes` because that is where
  // Chrome's `--window-position=0,0` lands on multi-monitor Macs. When no
  // display is flagged (e.g., single-display setups), fall back to the first
  // block, which is also what `system_profiler` lists first.
  const target = blocks.find((b) => b.isMain) || blocks[0];
  return parseMacDisplayBlock(target.text);
}

function detectLinux() {
  const xdpy = tryExec('xdpyinfo 2>/dev/null');
  const xdpyLine = xdpy.match(/dimensions:\s*(\d+)\s*x\s*(\d+)/i);
  if (xdpyLine) {
    return { width: parseInt(xdpyLine[1], 10), height: parseInt(xdpyLine[2], 10) };
  }
  // Fallback: xrandr — pick the connected primary's resolution
  const xrandr = tryExec('xrandr 2>/dev/null');
  if (xrandr) {
    const primary = xrandr.match(/connected\s+primary\s+(\d+)x(\d+)/i);
    if (primary) {
      return { width: parseInt(primary[1], 10), height: parseInt(primary[2], 10) };
    }
    const any = xrandr.match(/connected\s+(\d+)x(\d+)/i);
    if (any) {
      return { width: parseInt(any[1], 10), height: parseInt(any[2], 10) };
    }
  }
  return null;
}

function detectWindows() {
  // PowerShell is universally available on supported Windows; one-liner reads primary screen.
  // Use single-quoted 'x' as the separator so we don't need backslash-escaped double quotes
  // inside the cmd.exe -> PowerShell argument (PowerShell does not honor \" as quote escape).
  const ps = tryExec('powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $b.Width.ToString() + \'x\' + $b.Height.ToString()"');
  const parsed = parseFirstWxH(ps);
  if (parsed) return parsed;

  // Fallback to wmic (deprecated on newer Windows but still common).
  const w = tryExec('wmic desktopmonitor get screenwidth /value 2>nul');
  const h = tryExec('wmic desktopmonitor get screenheight /value 2>nul');
  const wm = w.match(/ScreenWidth=(\d+)/i);
  const hm = h.match(/ScreenHeight=(\d+)/i);
  if (wm && hm) {
    return { width: parseInt(wm[1], 10), height: parseInt(hm[1], 10) };
  }
  return null;
}

function detectScreenSize({ platform = os.platform() } = {}) {
  let result = null;
  if (platform === 'darwin') result = detectMacOS();
  else if (platform === 'linux') result = detectLinux();
  else if (platform === 'win32') result = detectWindows();

  if (result && result.width >= 640 && result.height >= 480) {
    return result;
  }
  return { ...FALLBACK };
}

module.exports = {
  detectScreenSize,
  FALLBACK,
  parseFirstWxH,
  parseMacDisplayBlock,
  parseMacDisplayBlocks,
};
