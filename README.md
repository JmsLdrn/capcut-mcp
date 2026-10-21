# capcut-mcp

An MCP server that lets Claude **read and edit CapCut desktop draft projects** — add/move/trim/split clips, text, audio, images; set transforms; validate; save. It works by cloning real segment/material templates out of an existing draft (the only reliable way to produce valid CapCut JSON), and it saves atomically with a backup and a validation pass.

> **Free & open source (MIT).** Built by [James Aldrin Boncales](https://jmsldrn.com) for editors who want Claude to drive CapCut for them.
>
> **Not affiliated with CapCut or ByteDance.** CapCut's draft format is proprietary and undocumented; this tool reads/writes it defensively (clone-from-template, backups, validation), but a CapCut update can shift the schema. **Keep the backups it makes.**

## Requirements
- **Node 18+**
- **ffmpeg/ffprobe** on PATH (used to read media duration/resolution)
- **CapCut desktop** (Windows layout assumed; macOS path is auto-detected too)

## Configure (env, optional)
- `CAPCUT_DRAFTS_DIR` — your CapCut Drafts folder. Auto-detects the standard `%LOCALAPPDATA%\CapCut\...` (Windows) / `~/Movies/CapCut/...` (macOS) locations; **set this if your drafts live elsewhere** (e.g. a different drive).
- `CAPCUT_TEMPLATE_DRAFT` — name of a draft that contains video **and text** layers, used to harvest templates when the draft you're editing lacks one. **Default `0723` is the author's own draft and won't exist on your machine** — set this to one of *your* drafts that has a text layer, or the `capcut_add_text` tool won't work. (Everything else works without it.)

## Install
```bash
git clone https://github.com/JmsLdrn/capcut-mcp
cd capcut-mcp
npm install
```
Then register it in Claude Code — **use the absolute path to `src/server.js` on your machine**:
```bash
claude mcp add capcut --scope user -- node "/ABSOLUTE/PATH/TO/capcut-mcp/src/server.js"
```
…or add a project-scoped `.mcp.json` at your repo root (copy `mcp.json.example` and edit the paths):
```json
{
  "mcpServers": {
    "capcut": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/capcut-mcp/src/server.js"],
      "env": { "CAPCUT_DRAFTS_DIR": "", "CAPCUT_TEMPLATE_DRAFT": "" }
    }
  }
}
```
Leave the `env` values blank to auto-detect, or fill them in (see **Configure** above). Restart Claude Code; the tools then appear as `mcp__capcut__*`.

## Workflow (important)
1. **Close CapCut** on the draft you want to edit. CapCut autosaves on a timer; writing while it's open gets clobbered. `capcut_save` refuses if CapCut is running or the draft's `.locked` file is present (override with `force: true` only if you know it's safe).
2. Edits are a **session**: `capcut_add_*` / `capcut_move_*` etc. accumulate in memory. Nothing hits disk until **`capcut_save`**.
3. `capcut_save` writes `draft_content.json` (or `draft_info.json` on newer CapCut builds) (+ meta) **atomically** after making a `.mcpbak` backup, and runs `capcut_validate`.
4. Reopen the draft in CapCut.

All times at the tool boundary are in **seconds** (converted to CapCut's microseconds internally).

## Tools
| Tool | Purpose |
|---|---|
| `capcut_list_drafts` | list drafts + duration + lock status |
| `capcut_read_timeline` | full read: canvas, fps, tracks, every segment |
| `capcut_clone_draft` | copy a draft (optionally emptied) for a fresh build |
| `capcut_add_video / _image / _audio` | place media at a time on a track |
| `capcut_add_text` | text overlay (needs a text template draft) |
| `capcut_add_track` | new video/audio/text/sticker track |
| `capcut_move_segment` | change start time / track |
| `capcut_trim_segment` | change start / duration / source in-point |
| `capcut_split_segment` | split at a time |
| `capcut_delete_segment` | remove |
| `capcut_set_props` | scale / position / rotation / opacity / volume / speed / visibility |
| `capcut_raw_patch` | advanced deep-merge escape hatch for undocumented ops |
| `capcut_validate` | overlaps, duplicate ids, missing media |
| `capcut_save` / `capcut_discard` | persist / drop the session |

## Companion skill
A Claude **skill** ships in [`skills/capcut-reels/`](skills/capcut-reels/SKILL.md). It teaches Claude the full production pipeline these tools were built for — record → captions (WhisperFlow) → motion graphics (HyperFrames) → probe/render (ffprobe/ffmpeg) → assemble & caption the CapCut draft via this MCP. Copy the `capcut-reels` folder into your Claude skills directory to install it.

## Guardrails
- Won't save while CapCut is open (autosave clobber protection).
- `.mcpbak` backup + atomic temp-then-rename write.
- Post-edit validation (overlaps, duplicate material ids, layer-order clashes, missing media).
- New drafts are **cloned from a known-good base**, never built from an empty object.

## Limitations (be honest with these)
- CapCut's draft format is **proprietary and undocumented**, and changes between CapCut versions. This server is defensive (clone-from-template, backup, validate) but a CapCut update can still shift the schema — keep the backups.
- **Effects, transitions, animations, and rich text styling are best-effort.** The well-understood ops (place/move/trim/split media + basic text + transforms) are solid; anything exotic should go through `capcut_raw_patch` against a template you've inspected.
- `capcut_add_text` needs a draft with a text layer to harvest from (`CAPCUT_TEMPLATE_DRAFT`).

## Architecture
- `src/core.js` — pure engine (`CapCutDraft` class + `cloneDraft`/`listDrafts`). Testable without MCP.
- `src/server.js` — thin MCP stdio server; declares the tools and calls the core.

## License & credits
MIT © 2026 [James Aldrin Boncales](https://jmsldrn.com). Contributions and issues welcome. If this saves you time, a link back to [jmsldrn.com](https://jmsldrn.com) is appreciated — not required.

*Always keep a copy of important drafts before batch-editing. This software is provided "as is", without warranty.*
