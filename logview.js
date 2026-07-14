#!/usr/bin/env node
/*
 * logview — a per-app log filter for Turborepo (and any tool that prefixes
 * lines with [app-name]).
 *
 * Wraps a command, colors each app, pins a filter "badge bar" to the top of
 * the terminal, and lets you toggle apps on/off from an interactive dropdown.
 *
 * Usage:
 *   logview turbo dev
 *   logview pnpm dev
 *   logview --only auth-api,core-services turbo dev   (start filtered)
 *   turbo dev | logview                               (pipe mode, no UI)
 *
 * Zero dependencies. Node 16+.
 */

'use strict';

const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opts = { only: null, hide: null, noUi: false, help: false, command: [] };

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (opts.command.length > 0) { opts.command.push(a); continue; }
  switch (a) {
    case '-h':
    case '--help': opts.help = true; break;
    case '--no-ui': opts.noUi = true; break;
    case '--only': opts.only = splitList(argv[++i]); break;
    case '--hide': opts.hide = splitList(argv[++i]); break;
    case '--': break; // explicit separator; rest is the command
    default:
      // First non-flag token starts the command; everything after is verbatim.
      opts.command.push(a);
  }
}

function splitList(s) {
  if (!s) return [];
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

if (opts.help) { printHelp(); process.exit(0); }

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const stripAnsi = s => s.replace(ANSI, '');

const CSI = '\x1b[';
const reset = '\x1b[0m';
const dim = t => `\x1b[2m${t}\x1b[22m`;
const bold = t => `\x1b[1m${t}\x1b[22m`;

// A palette of distinct 256-colors used to tint each app badge.
const PALETTE = [39, 208, 41, 170, 220, 51, 203, 129, 118, 214, 45, 199, 82, 165, 226, 33];
function colorFor(index) { return PALETTE[index % PALETTE.length]; }
const fg = (code, t) => `\x1b[38;5;${code}m${t}${reset}`;
const bgBadge = (code, t) => `\x1b[48;5;${code}m\x1b[38;5;16m ${t} ${reset}`;

// ---------------------------------------------------------------------------
// App registry — discovered dynamically as lines arrive.
// ---------------------------------------------------------------------------
/** @type {Map<string,{name:string,color:number,visible:boolean,index:number}>} */
const apps = new Map();
let appOrder = [];

function ensureApp(name) {
  if (apps.has(name)) return apps.get(name);
  const index = apps.size;
  let visible = true;
  if (opts.only && opts.only.length) visible = opts.only.includes(name);
  if (opts.hide && opts.hide.includes(name)) visible = false;
  const app = { name, color: colorFor(index), visible, index };
  apps.set(name, app);
  appOrder.push(name);
  return app;
}

// Detect the leading [app] prefix. Rejects timestamps like [10:51:50 AM].
const APP_RE = /^\s*\[([^\]]+)\]/;
function detectApp(rawLine) {
  const m = APP_RE.exec(stripAnsi(rawLine));
  if (!m) return null;
  const tok = m[1].trim();
  // App names have no spaces and aren't clock times.
  if (/\s/.test(tok) || /\d{1,2}:\d{2}(:\d{2})?/.test(tok)) return null;
  return tok;
}

let lastApp = null;

// ---------------------------------------------------------------------------
// Search filter (optional text match, applied on top of app visibility)
// ---------------------------------------------------------------------------
let searchTerm = '';

function lineVisible(app, text) {
  if (app && apps.has(app) && !apps.get(app).visible) return false;
  if (searchTerm && !stripAnsi(text).toLowerCase().includes(searchTerm.toLowerCase())) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Ring buffer of recent lines so filter changes can redraw retroactively.
// ---------------------------------------------------------------------------
const RING_MAX = 10000;
const ring = []; // { app, text }

function record(app, text) {
  ring.push({ app, text });
  if (ring.length > RING_MAX) ring.shift();
}

// ---------------------------------------------------------------------------
// Interactive UI (only when stdout is a TTY and --no-ui not set)
// ---------------------------------------------------------------------------
const interactive = process.stdout.isTTY && !opts.noUi && process.stdin.isTTY;

const HEADER_ROWS = 2; // title + badge bar
let rows = process.stdout.rows || 40;
let cols = process.stdout.columns || 100;
let overlayOpen = false;
let overlayCursor = 0;
let pendingWhileOverlay = [];
let scrollOffset = 0; // 0 = following the live tail; >0 = N filtered lines scrolled up

function regionTop() { return HEADER_ROWS + 1; }
function regionBottom() { return rows; }

function enterUi() {
  process.stdout.write('\x1b[?1049h'); // alt screen buffer
  process.stdout.write('\x1b[2J');      // clear
  process.stdout.write('\x1b[?1000h\x1b[?1006h'); // enable SGR mouse (wheel scroll)
  applyScrollRegion();
  drawHeader();
  parkCursor();
  if (process.stdin.setRawMode) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onKey);
  process.stdout.on('resize', onResize);
}

function leaveUi() {
  process.stdout.write('\x1b[?1000l\x1b[?1006l'); // disable mouse tracking
  process.stdout.write(CSI + 'r');       // reset scroll region
  process.stdout.write('\x1b[?25h');     // show cursor
  process.stdout.write('\x1b[?1049l');   // leave alt screen
  if (process.stdin.setRawMode) process.stdin.setRawMode(false);
}

function applyScrollRegion() {
  process.stdout.write(`${CSI}${regionTop()};${regionBottom()}r`);
}
function parkCursor() {
  process.stdout.write(`${CSI}${regionBottom()};1H`);
}

// --- scrollback helpers -----------------------------------------------------
function visibleEntries() { return ring.filter(e => lineVisible(e.app, e.text)); }
function regionHeight() { return regionBottom() - regionTop() + 1; }
function maxOffset() { return Math.max(0, visibleEntries().length - regionHeight()); }
function scrollBy(delta) {
  const prev = scrollOffset;
  scrollOffset = Math.max(0, Math.min(scrollOffset + delta, maxOffset()));
  if (scrollOffset !== prev) { redrawRegion(); drawHeader(); }
}
function scrollToTop() { scrollOffset = maxOffset(); redrawRegion(); drawHeader(); }
function followTail() { if (scrollOffset !== 0) { scrollOffset = 0; redrawRegion(); drawHeader(); } }
function resetScroll() { scrollOffset = 0; }

function badgeBar() {
  const parts = appOrder.map(name => {
    const a = apps.get(name);
    const label = a.visible ? bgBadge(a.color, name) : dim(`  ${name}  `);
    const num = a.index < 9 ? dim(String(a.index + 1)) : ' ';
    return num + label;
  });
  if (parts.length === 0) return dim(' (waiting for output…) ');
  return parts.join(' ');
}

function statusLine() {
  const hint = bold('logview') + dim('  f=filter  1-9=toggle  a=all  /=search  ↑↓/wheel=scroll  q=quit');
  const state = scrollOffset > 0
    ? fg(214, `  ⏸ scrolled +${scrollOffset} · End=live`)
    : fg(41, '  ● live');
  const search = (searchMode || searchTerm) ? fg(220, `  /${searchTerm}${searchMode ? '▌' : ''}`) : '';
  return hint + state + search;
}

// Rewrite only the top status row (cheap; used while frozen during streaming).
function drawStatusRow() {
  process.stdout.write('\x1b[?25l' + `${CSI}1;1H${CSI}2K` + statusLine());
}

function drawHeader() {
  process.stdout.write('\x1b[?25l'); // hide cursor while drawing
  process.stdout.write(`${CSI}1;1H${CSI}2K` + statusLine());
  process.stdout.write(`${CSI}2;1H${CSI}2K` + badgeBar());
  parkCursor();
  process.stdout.write(scrollOffset > 0 ? '\x1b[?25l' : '\x1b[?25h');
}

function clip(s) {
  // Trim by visible width to avoid wrapping the header rows.
  const plain = stripAnsi(s);
  if (plain.length <= cols) return s;
  // Rough clip: cut the plain form and drop styling beyond limit.
  return s; // headers are short in practice; keep styling intact
}

function writeLog(app, text) {
  if (!interactive) { process.stdout.write(text + '\n'); return; }
  if (overlayOpen) { pendingWhileOverlay.push({ app, text }); return; }
  if (scrollOffset > 0) {
    // User is viewing history — keep their view anchored, don't scroll it.
    scrollOffset = Math.min(scrollOffset + 1, maxOffset());
    drawStatusRow();
    return;
  }
  const prefixColored = app && apps.has(app)
    ? recolorPrefix(app, text)
    : text;
  process.stdout.write(prefixColored + '\n');
}

// Replace the leading [app] with a colored version for readability.
function recolorPrefix(app, text) {
  const a = apps.get(app);
  const plain = stripAnsi(text);
  const m = APP_RE.exec(plain);
  if (!m) return text;
  const rest = text.slice(text.indexOf(']') + 1);
  return fg(a.color, `[${app}]`) + rest;
}

function redrawRegion() {
  // Clear the scroll region and reprint a window into the ring buffer.
  process.stdout.write('\x1b[?25l');
  for (let r = regionTop(); r <= regionBottom(); r++) {
    process.stdout.write(`${CSI}${r};1H${CSI}2K`);
  }
  const visible = ring.filter(e => lineVisible(e.app, e.text));
  const height = regionBottom() - regionTop() + 1;
  if (scrollOffset > Math.max(0, visible.length - height)) {
    scrollOffset = Math.max(0, visible.length - height); // clamp after resize/filter
  }
  const end = visible.length - scrollOffset;      // exclusive
  const start = Math.max(0, end - height);
  const slice = visible.slice(start, end);
  let row = regionBottom() - slice.length + 1;
  if (row < regionTop()) row = regionTop();
  for (const e of slice) {
    process.stdout.write(`${CSI}${row};1H`);
    const line = e.app && apps.has(e.app) ? recolorPrefix(e.app, e.text) : e.text;
    process.stdout.write(line);
    row++;
  }
  parkCursor();
  process.stdout.write(scrollOffset > 0 ? '\x1b[?25l' : '\x1b[?25h');
}

// ---------------------------------------------------------------------------
// Filter dropdown overlay
// ---------------------------------------------------------------------------
function openOverlay() {
  if (appOrder.length === 0) return;
  overlayOpen = true;
  overlayCursor = 0;
  drawOverlay();
}

function drawOverlay() {
  process.stdout.write('\x1b[?25l');
  const title = ' Filter apps  ↑↓ move · space toggle · a all · n none · enter/esc close ';
  const boxTop = regionTop();
  // Clear region first
  for (let r = regionTop(); r <= regionBottom(); r++) {
    process.stdout.write(`${CSI}${r};1H${CSI}2K`);
  }
  process.stdout.write(`${CSI}${boxTop};1H` + fg(220, bold(title)));
  appOrder.forEach((name, i) => {
    const a = apps.get(name);
    const row = boxTop + 1 + i;
    if (row > regionBottom()) return;
    const cursor = i === overlayCursor ? fg(220, '❯ ') : '  ';
    const box = a.visible ? fg(a.color, '[x]') : dim('[ ]');
    const label = a.visible ? fg(a.color, name) : dim(name);
    process.stdout.write(`${CSI}${row};1H` + cursor + box + ' ' + label);
  });
}

function closeOverlay() {
  overlayOpen = false;
  // Flush anything buffered while the overlay was open into the ring.
  for (const e of pendingWhileOverlay) record(e.app, e.text);
  pendingWhileOverlay = [];
  resetScroll();
  drawHeader();
  redrawRegion();
}

// ---------------------------------------------------------------------------
// Keyboard handling
// ---------------------------------------------------------------------------
let searchMode = false;

function handleMouse(s) {
  const m = /\x1b\[<(\d+);\d+;\d+[Mm]/.exec(s);
  if (!m) return;
  const btn = parseInt(m[1], 10);
  if (btn === 64) scrollBy(3);       // wheel up  → into history
  else if (btn === 65) scrollBy(-3); // wheel down → toward live tail
}

function onKey(buf) {
  const s = buf.toString('utf8');

  // Mouse wheel (SGR) — scroll history whenever a normal view is showing.
  if (s.startsWith('\x1b[<')) {
    if (!overlayOpen && !searchMode) handleMouse(s);
    return;
  }

  if (searchMode) return handleSearchKey(s);
  if (overlayOpen) return handleOverlayKey(s);

  switch (s) {
    case 'q':
    case '\x03': // ctrl-c
      shutdown(0);
      return;
    case 'f':
      openOverlay();
      return;
    case 'a':
      resetScroll(); setAll(true); drawHeader(); redrawRegion();
      return;
    case 'n':
      resetScroll(); setAll(false); drawHeader(); redrawRegion();
      return;
    case '/':
      searchMode = true; searchTerm = ''; drawHeader();
      return;
    // --- scrollback controls ---
    case '\x1b[A': scrollBy(1); return;                    // ↑
    case '\x1b[B': scrollBy(-1); return;                   // ↓
    case '\x1b[5~': scrollBy(regionHeight() - 1); return;  // PageUp
    case '\x1b[6~': scrollBy(-(regionHeight() - 1)); return; // PageDown
    case '\x1b[H': case '\x1b[1~': case 'g': scrollToTop(); return; // Home / g
    case '\x1b[F': case '\x1b[4~': case 'G': followTail(); return;  // End / G
  }
  if (/^[1-9]$/.test(s)) {
    const idx = parseInt(s, 10) - 1;
    if (idx < appOrder.length) {
      const a = apps.get(appOrder[idx]);
      a.visible = !a.visible;
      resetScroll(); drawHeader(); redrawRegion();
    }
  }
}

function handleOverlayKey(s) {
  if (s === '\x1b' || s === '\r' || s === '\n' || s === 'f') { closeOverlay(); return; }
  if (s === '\x1b[A' || s === 'k') { overlayCursor = (overlayCursor - 1 + appOrder.length) % appOrder.length; drawOverlay(); return; }
  if (s === '\x1b[B' || s === 'j') { overlayCursor = (overlayCursor + 1) % appOrder.length; drawOverlay(); return; }
  if (s === ' ') {
    const a = apps.get(appOrder[overlayCursor]);
    a.visible = !a.visible; drawOverlay(); return;
  }
  if (s === 'a') { setAll(true); drawOverlay(); return; }
  if (s === 'n') { setAll(false); drawOverlay(); return; }
  if (s === '\x03') { shutdown(0); }
}

function handleSearchKey(s) {
  if (s === '\r' || s === '\n' || s === '\x1b') {
    if (s === '\x1b') searchTerm = '';
    searchMode = false; resetScroll(); drawHeader(); redrawRegion(); return;
  }
  if (s === '\x7f' || s === '\b') { searchTerm = searchTerm.slice(0, -1); resetScroll(); drawHeader(); redrawRegion(); return; }
  if (s === '\x03') { shutdown(0); return; }
  if (s >= ' ') { searchTerm += s; resetScroll(); drawHeader(); redrawRegion(); }
}

function setAll(v) { for (const a of apps.values()) a.visible = v; }

function onResize() {
  rows = process.stdout.rows || rows;
  cols = process.stdout.columns || cols;
  applyScrollRegion();
  drawHeader();
  if (overlayOpen) drawOverlay(); else redrawRegion();
}

// ---------------------------------------------------------------------------
// Line ingestion
// ---------------------------------------------------------------------------
function ingest(rawLine) {
  const line = rawLine.replace(/\r$/, '');
  let app = detectApp(line);
  if (app) { ensureApp(app); lastApp = app; }
  else { app = lastApp; }

  const appChanged = app && !apps.has(app) ? false : true;
  record(app, line);

  // A newly discovered app means the badge bar changed.
  if (detectApp(line) && interactive) drawHeader();

  if (!lineVisible(app, line)) return;
  writeLog(app, line);
}

function feed(stream) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      ingest(line);
    }
  });
  stream.on('end', () => { if (buffer) ingest(buffer); });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
let child = null;

function shutdown(code) {
  if (interactive) leaveUi();
  if (child && !child.killed) {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
  process.exit(code);
}

function start() {
  if (interactive) enterUi();

  if (opts.command.length > 0) {
    const cmdStr = opts.command.join(' ');
    child = spawn(cmdStr, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    feed(child.stdout);
    feed(child.stderr);
    child.on('exit', c => {
      // Give the terminal a moment, then exit with the child's code.
      shutdown(c == null ? 0 : c);
    });
    child.on('error', err => {
      if (interactive) leaveUi();
      console.error('logview: failed to start command:', err.message);
      process.exit(1);
    });
  } else if (!process.stdin.isTTY) {
    // Pipe mode: read logs from stdin. No interactive UI (stdin is the pipe).
    feed(process.stdin);
    process.stdin.on('end', () => process.exit(0));
  } else {
    printHelp();
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function printHelp() {
  const t = `
logview — per-app log filter for Turborepo

USAGE
  logview <command...>          Run a command and filter its output
  logview turbo dev
  logview pnpm dev
  <command> | logview           Pipe mode (filtering via flags, no UI)

OPTIONS
  --only a,b        Start with only these apps visible
  --hide a,b        Start with these apps hidden
  --no-ui           Plain output, no interactive UI (good for CI / pipes)
  -h, --help        Show this help

INTERACTIVE KEYS (when attached to a terminal)
  f          open the app filter dropdown
  1-9        toggle an app on/off by number
  a          show all apps
  n          hide all apps
  /          search text (enter to apply, esc to clear)
  wheel/↑↓   scroll through history (pauses the live tail)
  PgUp/PgDn  scroll a page at a time
  Home / g   jump to the top of history
  End / G    jump back to the live tail
  q          quit
`;
  process.stdout.write(t + '\n');
}

start();
