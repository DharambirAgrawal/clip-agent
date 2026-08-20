<p align="center">
  <img width="220" alt="ClipAgent Logo" src="https://github.com/user-attachments/assets/414b8838-6731-45d4-a815-6e3c0aa1fe52" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-111827?style=for-the-badge" alt="macOS Windows Linux" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/license-AGPL%203.0-2563eb?style=for-the-badge" alt="AGPL 3.0 license" />
</p>

### Screen recording and editing, driven by Claude

ClipAgent is a screen recorder and editor for **walkthroughs, demos, and product videos**, with an MCP server so Claude can transcribe, trim, style, and export it directly. No timeline dragging required.

<img width="1280" height="720" alt="MP4 to GIF export" src="https://github.com/user-attachments/assets/e6d68606-5fc0-4f70-99cd-7521982dc13b" />

---

## What is ClipAgent?

ClipAgent is a desktop screen recorder and editor with motion-driven presentation tools built in (auto-zooms, cursor polish, webcam bubbles, styled frames), plus an [MCP](https://modelcontextprotocol.io) server (`mcp-server/`) that exposes that same editing model as tools an AI agent can call. Instead of sending raw footage to a motion designer for zooms and polish, or dragging clips on a timeline by hand, Claude can open a project, look at the footage, cut silence, add zooms, generate captions, and export, all directly against the app's real project file format.

ClipAgent runs on:

- **macOS** 14.0+
- **Windows** 10 Build 19041+
- **Linux** on modern distros

Platform notes:

- **macOS** uses native ScreenCaptureKit-based capture helpers.
- **Windows** uses a native Windows Graphics Capture (WGC) helper on supported builds, with native WASAPI audio support.
- **Linux** records through Electron capture APIs. Cursor hiding is not supported on Linux today.

---

## Features

### Recording
- Record an entire display or a single app window
- Jump directly from recording into the editor
- Capture microphone audio and system audio
- Resume editing from saved `.recordly` project files

### Timeline and editing
- Drag-and-drop timeline editing with trims, zooms, speed regions, and annotations
- Automatic zoom suggestions based on cursor click/dwell activity
- Text, image, and figure annotations, plus extra audio regions
- Crop-aware edits and save/reopen of full editor state

### Cursor polish
- Rendered cursor overlay with size, smoothing, motion blur, click bounce, sway, and loop mode
- macOS-style cursor assets for the overlay

### Webcam overlay
- Enable, position, resize, and mirror a webcam bubble
- Roundness, shadow, and margin control
- Optional zoom-reactive scaling so the bubble stays balanced during motion

### Frame styling
- Built-in and custom wallpapers, solid colors, and gradients
- Padding, rounded corners, background blur, drop shadows, and aspect-ratio presets

### Captions
- Automatic transcription via a bundled `whisper.cpp` runtime, with word-level timestamps

### Export
- MP4 and GIF export with quality, frame-rate, loop, and size controls

### AI-driven editing (MCP)
- Claude (or any MCP client) can transcribe, trim, zoom, style, caption, and export a project directly (see [MCP Tools](#mcp-tools) below)

### Extensions
- A permission-gated extension system (carried over from Recordly) for cursor click sounds, device frames, browser mockups, wallpapers, render hooks, and settings panels, loaded locally via `Extensions -> Open Directory`

---

## Tech Stack

**Desktop app**
- [Electron](https://www.electronjs.org/) + [Vite](https://vitejs.dev/) for the shell and build pipeline
- [React](https://react.dev/) + TypeScript for the UI, styled with Tailwind CSS and Radix UI primitives
- [PixiJS](https://pixijs.com/) for scene composition/rendering (preview and export share the same rendering path)
- Native platform helpers written in Swift (macOS ScreenCaptureKit) and C++/CMake (Windows Graphics Capture, NVIDIA CUDA compositor, cursor monitor)
- `ffmpeg-static` / `ffprobe-static` for media probing and export, `mediabunny`/`mp4box`/`web-demuxer` for in-app media handling
- [Vitest](https://vitest.dev/) for unit tests (100+ test files across the editor, exporter, and Electron layers) and [Biome](https://biomejs.dev/) for linting/formatting

**MCP server** (`mcp-server/`)
- [`@modelcontextprotocol/sdk`](https://modelcontextprotocol.io) over stdio
- TypeScript, [Zod](https://zod.dev/) for tool input schemas
- Its own `ffmpeg`/`ffprobe` pipeline (trim, zoom via the `zoompan` filter, frame/webcam/shadow compositing) and the app's bundled `whisper-cli` binary for transcription

---

## MCP Tools

The MCP server (`mcp-server/`) reads and writes the exact same `.recordly` project files the desktop app uses, so a project edited by Claude opens correctly in the app and vice versa. It exposes these tools:

| Tool | What it does |
|---|---|
| `list_projects` | List `.recordly` project files with name, source video, last-updated time |
| `create_project` | Create a new project from a source video file |
| `open_project` | Read a project's current editing state |
| `get_media_info` | Duration, resolution, frame rate, audio presence for any media file |
| `detect_silence` | Detect silent ranges in a file's audio track |
| `detect_scene_changes` | Detect timestamps of significant visual change (new screen, message sent, dialog opened) |
| `scan_frames` | Extract evenly spaced frames from a video (optionally within a time range) so the model can actually look at the footage |
| `cut_silence` | Detect silence in a project's source and add trim regions covering it |
| `trim_range` | Add a trim region (a range to cut) to a project |
| `add_zoom` | Add a zoom-in region focused on a point in frame; renders as a real animated zoom |
| `suggest_zooms` | Analyze recorded cursor clicks/dwells to suggest zoom regions (needs desktop-recording telemetry) |
| `add_webcam_bubble` | Enable/position a webcam overlay |
| `apply_frame_style` | Set frame, wallpaper, padding, corner radius, shadow, aspect ratio |
| `transcribe_audio` | Transcribe any media file to text with word-level timestamps (whisper.cpp) |
| `add_caption_track` | Transcribe a project's video and write the result as its caption track |
| `render_preview` | Render the current edits (trim + zoom + wallpaper/padding/radius/shadow/webcam) and return sampled frames as images |
| `export_final` | Export the fully composited (trim + zoom + static layout) video to an MP4 |

Silence detection, trims, webcam settings, frame style, transcription, zoom rendering, and export are real, tested data- and ffmpeg-level operations, not mocks. Some parts of the desktop app's dynamic per-frame Canvas/WebGL renderer (cursor rendering, device-frame chrome, chained zoom transitions, speaker diarization) aren't wired into the MCP export pipeline yet. See [`mcp-server/README.md`](./mcp-server/README.md) for the full, current "what's real vs. not yet" breakdown.

---

## Screenshots

<p align="center">
  <img src="https://i.postimg.cc/8CrQtGJf/Screenshot-2026-04-30-at-5-11-52-pm.png" width="700" alt="ClipAgent recording interface screenshot">
</p>

<p align="center">
  <img src="https://i.postimg.cc/pLSMfrTM/Screenshot-2026-04-30-at-5-11-45-pm.png" width="700" alt="ClipAgent editor screenshot">
</p>

<p align="center">
  <img src="https://i.postimg.cc/Zn9VY6bg/Screenshot-2026-03-18-at-6-32-59-pm.png" width="700" alt="ClipAgent timeline screenshot">
</p>

---

## Getting Started

### Download a build

No prebuilt releases are published for this fork yet. Build from source below. (The upstream Recordly project publishes its own releases at [webadderallorg/Recordly/releases](https://github.com/webadderallorg/Recordly/releases), but those are a different app.)

### Build from source

**Prerequisites**

- **macOS:** Xcode Command Line Tools (`xcode-select --install`)
- **Linux (Ubuntu/Debian):** `sudo apt install build-essential cmake libx11-dev libxtst-dev libxrandr-dev libxt-dev`
- **Windows:** Visual Studio 2022 (or Build Tools) with the C++ workload and CMake

**Steps**

```bash
git clone https://github.com/DharambirAgrawal/clip-agent.git
cd clip-agent
npm install
npm run dev
```

For packaged builds: `npm run build`, or a target-specific variant such as `npm run build:mac`, `npm run build:win`, or `npm run build:linux`.

**macOS "App cannot be opened"**: locally built apps may be quarantined by macOS. Remove the flag with:

```bash
xattr -rd com.apple.quarantine /Applications/ClipAgent.app
```

### System requirements

| Platform | Minimum version | Notes |
|---|---|---|
| **macOS** | macOS 14.0 (Sonoma) | Required for ScreenCaptureKit audio and microphone capture |
| **Windows** | Windows 10 20H1 (Build 19041, May 2020) | Required for the native WGC helper and best cursor-hiding behavior |
| **Linux** | Any modern distro | Recording works through Electron capture; system audio generally requires PipeWire |

> [!IMPORTANT]
> On Windows builds older than 19041, recording can still work through fallback capture, but the real OS cursor may remain visible in recordings.

---

## Usage

### Record and edit in the app

1. Launch ClipAgent, select a screen or window, choose microphone/system-audio options, and start recording.
2. Stop recording to open the editor: add trims, zooms, speed regions, and annotations; tune cursor behavior; style the frame; add/adjust the webcam overlay; add extra audio; crop and pick an aspect ratio.
3. Save your work anytime as a `.recordly` project, and export to **MP4** or **GIF** with format-specific quality/size/loop settings.

### Connect ClipAgent to Claude via MCP

```bash
cd mcp-server
npm install
npm run build
```

Then point your MCP client at the built server, for example in Claude Desktop's or Claude Code's MCP config:

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

By default the server reads/writes the same `Projects` folder the desktop app uses (`~/Library/Application Support/ClipAgent/recordings/Projects` on macOS, the OS-equivalent elsewhere). Set `RECORDLY_USER_DATA_DIR` to point it at a different data directory (e.g. a `-dev` build). Once connected, Claude can list your projects, look at the footage (`scan_frames`, `detect_scene_changes`), cut silence, add zooms and captions, and export, using the [MCP Tools](#mcp-tools) above.

---

## Limitations

### Cursor capture
ClipAgent renders a polished cursor overlay on top of the recording; platform cursor-hiding behavior still depends on OS support. macOS/ScreenCaptureKit can exclude the real cursor cleanly. Windows needs Build 19041+ and the native capture helper, or the real cursor may remain visible. Linux's Electron desktop capture doesn't support cursor hiding, so enabling the rendered overlay there can show both cursors.

### System audio
Native WASAPI on Windows; usually requires PipeWire on Linux; requires macOS 14.0+ and the ScreenCaptureKit workflow on macOS.

### MCP export pipeline
As noted in [MCP Tools](#mcp-tools), a few of the desktop editor's dynamic rendering features (cursor overlay rendering, device-frame chrome, chained zoom transitions, speaker diarization) aren't yet reproduced by the MCP server's ffmpeg-based export. Those live in the app's per-frame Canvas/WebGL renderer.

---

## How It Works

ClipAgent combines a platform-specific capture layer with a renderer-driven editor and export pipeline, plus an MCP server that drives the same project format through a parallel, ffmpeg-based pipeline for AI-driven editing.

### Capture
- Electron coordinates recording and application flow
- macOS uses native ScreenCaptureKit helpers; Windows uses a native Windows Graphics Capture (WGC) helper and native audio helpers where available

### Editing (desktop app)
- Timeline regions define zooms, trims, speed changes, audio overlays, and annotations
- Cursor and webcam styling are applied in the editor state
- Scene composition and preview rendering are handled by PixiJS; the same scene logic is used for export

### Editing (MCP server)
- `mcp-server/` is a standalone Node/TypeScript process speaking MCP over stdio, built with the official `@modelcontextprotocol/sdk`
- It reads and writes the same `.recordly` project JSON as the desktop app (`mcp-server/src/projectStore.ts`), touching only the fields a given tool needs so it can't clobber settings it doesn't understand
- Media analysis (`detect_silence`, `detect_scene_changes`, `get_media_info`) and rendering (`render_preview`, `export_final`) run against a second, ffmpeg-native pipeline rather than the app's Canvas/WebGL renderer: trim, static layout (wallpaper/padding/corners/shadow/webcam), and animated zoom (via ffmpeg's `zoompan` filter) are ported from or verified against the app's own geometry code
- Transcription (`transcribe_audio`, `add_caption_track`) uses the desktop app's own bundled `whisper-cli` binary and model for real word-level speech-to-text
- `suggest_zooms` reuses the app's click-clustering auto-zoom heuristic over a recording's cursor-telemetry sidecar file

### Projects
- `.recordly` files store the source media path plus editor state so work can be reopened later, in the app or through the MCP server

---

## License

ClipAgent is licensed under the **AGPL 3.0**, same as the project it's forked from, with an additional attribution requirement carried over from that license (see below). See [`LICENSE.md`](./LICENSE.md) for the full text and its additional terms.

---

## Credits

ClipAgent is a fork of [Recordly](https://github.com/webadderallorg/Recordly) (AGPLv3), created by [@webadderall](https://x.com/webadderall).

Recordly itself originally started as a fork of [OpenScreen](https://github.com/siddharthvaddem/openscreen); over 80% of its code has diverged since, though many features such as its zoom animations are directly ported from early versions of Recordly.

---
