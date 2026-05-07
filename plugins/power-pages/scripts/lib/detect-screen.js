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

function detectMacOS() {
  // system_profiler is slower (~1s) but reliable. Pick the first display.
  const out = tryExec('system_profiler SPDisplaysDataType 2>/dev/null');
  if (out) {
    // Prefer "UI Looks like" (logical resolution after Retina scaling) when present.
    const looksLine = out.match(/UI Looks like:\s*(\d+)\s*[x×]\s*(\d+)/i);
    if (looksLine) {
      return { width: parseInt(looksLine[1], 10), height: parseInt(looksLine[2], 10) };
    }
    const resLine = out.match(/Resolution:\s*(\d+)\s*[x×]\s*(\d+)/i);
    if (resLine) {
      return { width: parseInt(resLine[1], 10), height: parseInt(resLine[2], 10) };
    }
  }
  return null;
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

module.exports = { detectScreenSize, FALLBACK, parseFirstWxH };
