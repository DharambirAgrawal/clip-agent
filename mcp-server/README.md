# ClipAgent MCP Server

Exposes ClipAgent's (a Recordly fork's) project-editing model, media analysis, and export as [MCP](https://modelcontextprotocol.io) tools, so Claude (or any MCP client) can edit `.recordly` projects directly instead of a human dragging clips on a timeline.

This is Phase 1 + Phase 2 of the plan: real, working tools wired to the app's actual on-disk project format, ffmpeg, and its bundled whisper.cpp runtime — not a mockup. See the "What's real vs. not yet" section below for the current honest scope.

## Setup

```bash
cd mcp-server
npm install
npm run build
```

Point your MCP client at the built server, e.g. in Claude Desktop / Claude Code's MCP config:

```json
{
  "mcpServers": {
    "recordly": {
      "command": "node",
      "args": ["/absolute/path/to/clip-agent/mcp-server/dist/index.js"]
    }
  }
}
```

By default this reads/writes the same `Projects` folder the ClipAgent desktop app uses (`~/Library/Application Support/ClipAgent/recordings/Projects` on macOS, the OS-equivalent elsewhere). Set `RECORDLY_USER_DATA_DIR` to point at a different data directory (e.g. a `-dev` build).

## Tools

| Tool | What it does |
|---|---|
| `list_projects` | List `.recordly` project files with name, source video, last-updated time |
| `create_project` | Create a new project from a source video file |
| `open_project` | Read a project's current editing state |
| `get_media_info` | Duration, resolution, frame rate, audio presence for any media file |
| `detect_silence` | Detect silent ranges in a file's audio track |
| `cut_silence` | Detect silence in a project's source and add trim regions covering it |
| `trim_range` | Add a trim region (a range to cut) to a project |
| `add_zoom` | Add a zoom-in region focused on a point in frame |
| `add_webcam_bubble` | Enable/position a webcam overlay |
| `apply_frame_style` | Set frame, wallpaper, padding, corner radius |
| `transcribe_audio` | Transcribe any media file to text with word-level timestamps (whisper.cpp) |
| `add_caption_track` | Transcribe a project's video and write the result as its caption track |
| `render_preview` | Render the current edits (trim + wallpaper/padding/radius/shadow/webcam) and return sampled frames as images |
| `export_final` | Export the fully composited (trim + static layout) video to an MP4 |

## What's real vs. not yet

Real and tested (see the project's plan artifact for the full roadmap):
- The `.recordly` project file format — read/write is byte-compatible with the desktop app. Editing a project here and opening it in Recordly works, and vice versa.
- Silence detection, trim regions, zoom regions, webcam settings, frame style — genuine data-level edits, atomically saved.
- `transcribe_audio` / `add_caption_track` — real speech-to-text using Recordly's own bundled `whisper-cli` binary and model, with word-level timestamps. Includes a caption-parsing fix for whisper.cpp's zero-width control/punctuation tokens (ported from `electron/ipc/captions/parser.ts`, fixed here).
- `export_final` / `render_preview` — a real ffmpeg pipeline that applies trim regions **and** composites wallpaper background, padding, rounded corners (squircle mask), drop shadow, and a webcam bubble (position preset, size, crop, mirror, rounding). The geometry is ported verbatim from the app's own pure math (`computePaddedLayout`/`scalePreviewBorderRadius` in `videoPlayback/layoutUtils.ts`, `webcamOverlay.ts`, `squircle.ts`, `shadowProfile.ts`, and the squircle-mask generator in `nativeVideoExport.ts`) — not reimplemented from scratch or guessed. Verified visually (rendered frame inspected, not just "ran without error") and against a real bug ffmpeg exposed (looped image inputs need an explicit `-t` or the encode never terminates).

Not yet wired (this is where the *dynamic* render pipeline lives — per-frame Canvas/WebGL rendering tied to code that only runs inside the desktop app's renderer process):
- **Zoom-region animation** (the actual zoom-in/out motion over time), cursor rendering, and device-frame chrome (`frame` field, e.g. browser mockups) are stored correctly in the project file but not yet rendered in export. Recordly's real compositor for these is `src/lib/exporter/modernFrameRenderer.ts` (4000+ lines of per-frame Canvas/WebGL work) — not something safe to reimplement standalone or verify without the same rendering environment the app runs in. Wiring these means bridging to the running desktop app, not writing new ffmpeg filters.
- Webcam bubble compositing here assumes it starts at the same time as the main recording (a `timeOffsetMs` shift is applied, but only as a simple ms offset — not validated against the app's own sync logic beyond that).
- Speaker diarization, scene detection, auto-reframe are still just plan items, not tools.

## Project schema

Only the fields a tool actually touches are modeled (`src/projectStore.ts`); everything else in the project file is read and written back untouched, so this server can't accidentally clobber a setting it doesn't know about. The trim/zoom/webcam/frame field shapes, and the layout/webcam/shadow/squircle geometry, mirror the main app's own source files exactly (see file-level comments in each ported module for the exact original).
