# logview

A per-app log filter for **Turborepo**. When `turbo dev` runs `apps/*` in one
terminal, the output from every app is interleaved and hard to read. `logview`
wraps the command, colors each app, pins a **filter badge bar** to the top of
the terminal, and lets you toggle apps on and off from an interactive dropdown.

It works with anything that prefixes lines with `[app-name]` — Turborepo, npm
workspaces, pnpm `--parallel`, etc. Zero dependencies, Node 16+.

```
 logview  f=filter  1-9=toggle  a=all  n=none  /=search  q=quit
1[core-services] 2[admin-console] 3[auth-api] 4  analytics-api   5[web-app]
────────────────────────────────────────────────────────────────────────────
[core-services] [10:51:50 AM] Starting compilation in watch mode...
[auth-api]      [10:52:04 AM] Found 0 errors. Watching for file changes.
[admin-console]  ○ Compiling /src/middleware ...
```

Apps shown as a solid colored badge are **visible**; dimmed ones are **hidden**
(above, `analytics-api` is hidden).

## Install

It's a single file. Pick whichever fits your team:

**Option A — run it directly (no install)**

```bash
node logview.js turbo dev
```

**Option B — install into the repo so everyone gets a `logview` command**

From the folder containing `package.json`:

```bash
npm link          # or: npm install -g .
logview turbo dev
```

**Option C — drop it in your monorepo and add a script**

In your root `package.json`:

```json
{
  "scripts": {
    "dev": "node ./tools/logview.js turbo dev"
  }
}
```

## Usage

```bash
logview turbo dev            # wrap turbo and filter interactively
logview pnpm dev             # any command works
logview --only auth-api,core-services turbo dev   # start pre-filtered
logview --hide admin-console turbo dev            # start with some hidden
```

### Interactive keys

| Key        | Action                                            |
|------------|---------------------------------------------------|
| `f`        | open the app filter **dropdown**                  |
| `1`–`9`    | toggle an app on/off by its number                |
| `a`        | show all apps                                      |
| `n`        | hide all apps                                      |
| `/`        | search — type text, `Enter` to apply, `Esc` clears |
| wheel / `↑` `↓` | **scroll through history** (pauses the live tail) |
| `PgUp` / `PgDn` | scroll a page at a time                       |
| `Home` / `g` | jump to the oldest buffered line                |
| `End` / `G`  | jump back to the live tail                       |
| `q`        | quit (also stops the wrapped command)             |

In the dropdown: `↑`/`↓` move, `space` toggles the highlighted app, `a`/`n`
all/none, `Enter` or `Esc` closes.

### Scrolling back through old logs

Scroll up with the mouse wheel (or `↑` / `PgUp`) to review earlier output — the
live tail **pauses** while you read and the header shows `⏸ scrolled +N` so you
know new lines are being buffered, not lost. Press `End` (or `G`) to snap back
to the bottom and resume following. The last 10,000 filtered lines are kept in
memory, and changing the filter re-applies to that whole history.

> Because the wheel is used for scrolling, click-drag text selection needs
> **Shift+drag** while logview is running (standard for terminal apps that
> capture the mouse).

### Try it without turbo

A demo emitter is included:

```bash
npm run demo        # == node logview.js node demo.js
```

## Terminal support (Windows)

Works in **Git Bash**, **PowerShell**, and **Windows Terminal**. The pinned
badge bar uses standard ANSI scroll regions, supported by the modern Windows
console (Windows 10 1903+ / Windows Terminal). If you're on a very old console
and the header looks off, use plain mode (below).

**Git Bash**

```bash
node logview.js turbo dev
```

**PowerShell**

```powershell
node .\logview.js turbo dev
```

## Non-interactive / pipe mode

For CI, log files, or when you just want a filtered stream with no UI:

```bash
turbo dev | logview --only auth-api        # pipe mode (no keyboard UI)
logview --no-ui --hide admin-console turbo dev
```

In pipe mode the keyboard controls are unavailable (stdin is the log stream),
so use `--only` / `--hide` to choose what shows.

## Notes

- Lines with no `[app]` prefix (turbo banners, multi-line stack traces) are
  grouped with the most recent app so a message stays together when filtered.
- Because `logview` takes over the keyboard for its controls, keystrokes are
  **not** forwarded to the wrapped dev server. If your workflow depends on
  typing into `next dev` (e.g. its interactive prompts), run that app on its
  own or use `--no-ui`.
