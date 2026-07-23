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
| `detect_scene_changes` | Detect timestamps of significant visual change (new screen, message sent, dialog opened) |
| `scan_frames` | Extract evenly spaced frames from a video (optionally within a time range) to actually look at the footage |
| `cut_silence` | Detect silence in a project's source and add trim regions covering it |
| `trim_range` | Add a trim region (a range to cut) to a project |
| `add_zoom` | Add a zoom-in region focused on a point in frame — renders as a real animated zoom |
| `suggest_zooms` | Analyze recorded cursor clicks/dwells to suggest zoom regions (needs desktop-recording telemetry) |
| `add_webcam_bubble` | Enable/position a webcam overlay |
| `apply_frame_style` | Set frame, wallpaper, padding, corner radius, shadow, aspect ratio |
| `transcribe_audio` | Transcribe any media file to text with word-level timestamps (whisper.cpp) |
| `add_caption_track` | Transcribe a project's video and write the result as its caption track |
| `render_preview` | Render the current edits (trim + zoom + wallpaper/padding/radius/shadow/webcam) and return sampled frames as images |
| `export_final` | Export the fully composited (trim + zoom + static layout) video to an MP4 |

## What's real vs. not yet

Real and tested (see the project's plan artifact for the full roadmap):
- The `.recordly` project file format — read/write is byte-compatible with the desktop app. Editing a project here and opening it in Recordly works, and vice versa.
- Silence detection, trim regions, webcam settings, frame style — genuine data-level edits, atomically saved.
- `transcribe_audio` / `add_caption_track` — real speech-to-text using the app's own bundled `whisper-cli` binary and model, with word-level timestamps. Includes a caption-parsing fix for whisper.cpp's zero-width control/punctuation tokens (ported from `electron/ipc/captions/parser.ts`, fixed here).
- `suggest_zooms` — ports the app's own click-clustering auto-zoom heuristic (`zoomSuggestionUtils.ts`) over a recording's `<video>.cursor.json` telemetry sidecar. Correctly reports "no telemetry" rather than fabricating suggestions for videos with no tracked cursor (e.g. phone screen recordings).
- `export_final` / `render_preview` — a real ffmpeg pipeline that applies trim regions and composites wallpaper background, padding, rounded corners (squircle mask), drop shadow, a webcam bubble, **and animated zoom regions** (ease in, hold, ease out — via the `zoompan` filter). The static layout geometry is ported verbatim from the app's own pure math (`computePaddedLayout`/`scalePreviewBorderRadius`, `webcamOverlay.ts`, `squircle.ts`, `shadowProfile.ts`, `ZOOM_DEPTH_SCALES`). Zoom *rendering* itself (`zoomRenderer.ts`) is new ffmpeg-native code, not a port — Recordly's own zoom rendering is a per-frame Canvas/WebGL redraw with no ffmpeg equivalent to port. Everything here was verified visually against real rendered frames, not just "ran without error" — including two ffmpeg-version-specific dead ends found by testing (this build's `crop` filter accepts `t`-referencing expressions and even advertises command support, but neither actually works — confirmed empirically — so zoom uses `zoompan` instead, which does animate correctly here).
- `detect_scene_changes` / `scan_frames` — the fix for a real gap: earlier versions gave the model no way to actually see the raw footage before deciding where to trim/zoom, so those decisions were guesses. `detect_scene_changes` (ffmpeg scene-score) flags candidate moments; verified against the demo video it correctly caught a known screen transition (a manually-identified idle→content cut at 3.8s came back as a detected change at 3.92s) but is noisy/imperfect on its own — a chat bubble appearing on a mostly-static background can be too subtle to score highly. It's meant to be paired with `scan_frames` (extract real frames around a candidate timestamp, or sweep a whole video/range) so the model looks at what actually happened rather than trusting the heuristic blindly.

Not yet wired (this is where the *dynamic* render pipeline lives — per-frame Canvas/WebGL rendering tied to code that only runs inside the desktop app's renderer process):
- Cursor rendering and device-frame chrome (`frame` field, e.g. browser mockups) are stored correctly in the project file but not yet rendered in export. Recordly's real compositor for these is `src/lib/exporter/modernFrameRenderer.ts` (4000+ lines of per-frame Canvas/WebGL work) — wiring these means bridging to the running desktop app, not writing new ffmpeg filters.
- Zoom rendering here doesn't handle `connectZooms` (smooth chained transitions between adjacent regions) — each region eases in/out independently.
- Webcam bubble compositing here assumes it starts at the same time as the main recording (a `timeOffsetMs` shift is applied, but only as a simple ms offset — not validated against the app's own sync logic beyond that).
- Speaker diarization is still just a plan item, not a tool.

## Project schema

Only the fields a tool actually touches are modeled (`src/projectStore.ts`); everything else in the project file is read and written back untouched, so this server can't accidentally clobber a setting it doesn't know about. The trim/zoom/webcam/frame field shapes, and the layout/webcam/shadow/squircle geometry, mirror the main app's own source files exactly (see file-level comments in each ported module for the exact original).
