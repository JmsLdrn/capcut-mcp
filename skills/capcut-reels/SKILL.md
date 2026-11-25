---
name: capcut-reels
description: >-
  Edit CapCut desktop drafts through the capcut MCP (tools named capcut_*): rough-cut
  talking-head recordings (premontaggio: drop silences and false starts, keep every
  complete take), transcribe with Whisper offline, place clips / images / audio /
  captions, copy CapCut transitions and animations, and drop in motion graphics or
  b-roll generated elsewhere (e.g. Higgsfield). Use whenever the user mentions a
  CapCut project, a "bozza", a premontaggio, reels/shorts/TikTok editing, or wants
  generated media put into a CapCut timeline.
---

# CapCut editing with the capcut MCP

Works in Claude Desktop (chat) with no shell: every file operation goes through a
`capcut_*` tool. Users are often non-technical and Italian-speaking — explain in plain
Italian, one step at a time, and never assume they know file paths.

## Ground rules
- **Edits live in memory until `capcut_save`.** Before saving, ask the user to close
  CapCut completely (autosave would overwrite the edit). Don't pass `force` unless they
  confirm CapCut is closed and the save still refuses.
- **Every save makes a backup** (`capcut_list_backups`, `capcut_restore_backup`). Mention
  this when the user is worried about breaking a project.
- **Seconds everywhere.** Never pass microseconds.
- **First run on a PC:** if a tool reports missing ffmpeg or Whisper model, run
  `capcut_setup` with `install: true` and keep the user informed (one-time ~600 MB).
- **Long jobs** (setup, transcription, downloads, ffmpeg) return a `jobId`; poll with
  `capcut_job_status` (it waits up to 50 s per call). Transcription costs ~8–15 s per
  spoken phrase: for long recordings tell the user the estimate and offer to continue
  when they write back, instead of polling dozens of times.
- **Finding files:** `capcut_list_files` (no args → common folders). To see footage,
  use `capcut_view_frames` (by file, or by draft + timeline seconds).

## Premontaggio (rough cut of a talking-head recording)
1. `capcut_list_drafts` → `capcut_read_timeline`. The main video track is the first
   video track; note each source `path` on it.
2. `capcut_transcribe` each source file. Output = numbered speech blocks
   `[start–end]` in **source-file seconds**, each transcribed on its own (so repeated
   takes are not merged), with a level in dB and hints: `▽ basso` (well under the main
   voice), `↻ ripetuto più forte in #n` (same words said louder right after), `↳` (block
   that starts quiet and ends at full voice, with the split time).
3. Decide per block:
   - **Keep every complete take** of a sentence, even if repeated 3–5 times — the user
     picks the best one later. Never "choose the best take" yourself unless asked.
   - **Dictated lines are not takes.** Often someone behind the camera reads each line
     and the person on camera repeats it. Drop the dictated one and keep only what the
     person on camera says. Typical sign: the same sentence twice in a row, the first
     quieter (▽/↻); with `↳` keep only the loud part. **Always confirm with
     `capcut_view_frames`** inside the block: a person who is still, with a closed mouth,
     is listening (dictation); one who talks and gestures is doing a take. A line
     whispered on purpose (hand by the mouth) is quiet but is a take. If the same words
     appear twice inside one long block, check frames at several points and cut there.
   - Drop: silence, takes interrupted mid-sentence (false starts), noises, off-script
     remarks, swearing/asides.
   - Very short blocks reading "Grazie a tutti", "Sottotitoli…", "[Musica]" are Whisper
     hallucinations on noise — drop them.
   - A complete but doubtful take (mumbled word, wrong word): keep it and list it.
   - A take split across two adjacent blocks (pause mid-sentence) → keep both blocks.
4. `capcut_rough_cut` with `keeps` in chronological order (`file` + `startSec` +
   `endSec` straight from the blocks, `note` = first words). Each keep becomes its own
   segment, end to end.
5. Other tracks (titles, music, SFX from a reused template) are **not** moved — tell the
   user they are now out of sync and offer to realign them later.
6. `capcut_validate` → ask to close CapCut → `capcut_save` (with a `note`).
7. Report: duration before/after, a table "timeline time | sentence | number of takes",
   doubtful takes, how many dictated lines were dropped, and that the original is in the
   backups.

## Captions and text
- `capcut_add_text` clones the style (font, stroke, animation) of an existing text layer.
  Set `CAPCUT_TEMPLATE_DRAFT` (extension settings) to the draft whose caption style
  they want; otherwise the first text found in any draft is used.
- For word-synced captions transcribe the *final* cut's source files and place one text
  per block at its timeline position (block start − keep start + keep `atSec`).

## Motion graphics, b-roll, generated media (Higgsfield etc.)
- Generated assets come back as URLs → `capcut_download` (saves to the media folder,
  returns path + probe info) → `capcut_add_video` / `capcut_add_image` at the right time.
  Omit `trackIndex` to land on a free overlay track above the main video; use
  `volume: 0` for silent overlays.
- Check `hasAlpha` in the probe: an overlay without transparency covers the speaker. If
  the generator gave a solid background, suggest a version with a flat green/magenta
  background and CapCut's Chroma key, or use it full-screen as a cutaway.
- Use `capcut_view_frames` on the draft to pick moments/positions that don't cover the
  face or the product.

## CapCut transitions, animations, effects
- You cannot invent CapCut effects; you can **copy** ones already used. `capcut_style_library`
  lists every transition / animation / effect in the user's drafts with a source clip;
  `capcut_apply_style` copies it onto target segments (animations are re-timed to the
  target's length). If the effect they want isn't there, ask them to apply it once by hand
  in any draft, then copy it everywhere.
- Reliable "punch-in" zoom on cuts: `capcut_set_props` with `scale` 1.1–1.2 on alternate
  segments.

## Other tools
- `capcut_clone_draft` (CapCut must be closed): try risky edits on a copy.
- `capcut_ffmpeg`: conversions, trims, extracting audio, making a chroma-key version.
- `capcut_raw_patch`: last resort for undocumented JSON; inspect a real example first.

## Limits to state honestly
- The CapCut draft format is undocumented; after big edits ask the user to open the
  draft and check it. Backups make every change reversible.
- No final export: the user exports from CapCut.
- Windows only for automatic setup.
