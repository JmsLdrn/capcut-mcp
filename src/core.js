// capcut-core: read/edit CapCut desktop draft projects by cloning real templates
// out of a base draft (the only reliable way to produce valid CapCut JSON).
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';

// ---- where the drafts live (override with CAPCUT_DRAFTS_DIR) ----
const STD_WIN = path.join(os.homedir(), 'AppData/Local/CapCut/User Data/Projects/com.lveditor.draft');
const STD_MAC = path.join(os.homedir(), 'Movies/CapCut/User Data/Projects/com.lveditor.draft');
const CANDIDATES = [
  process.env.CAPCUT_DRAFTS_DIR,
  'D:/Capcut/CapCut Drafts',
  STD_WIN,
  STD_MAC,
].filter(Boolean);
// pick the first candidate that exists; otherwise fall back to the OS-standard CapCut location
export const DRAFTS_DIR =
  CANDIDATES.find(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } })
  || (process.platform === 'win32' ? STD_WIN : STD_MAC);
// a draft known to contain video/text/audio layers, used to harvest templates
const TEMPLATE_DRAFT = process.env.CAPCUT_TEMPLATE_DRAFT || '0723';

// CapCut 9.3.0 on macOS names the timeline file 'draft_info.json' rather
// than 'draft_content.json'. With the name hardcoded, listDrafts() matched
// nothing and every other call threw "draft not found", so the server was
// inert on that platform while looking correctly installed.
//
// Resolution happens ONCE per draft, in the constructor, and save() reuses
// that exact path. The dangerous version of this bug reads one file and
// writes the other, leaving CapCut showing stale content.
const CONTENT_NAMES = ["draft_content.json", "draft_info.json"];
function contentPath(dir) {
  for (const n of CONTENT_NAMES) {
    const p = path.join(dir, n);
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

const uid = () => crypto.randomUUID().toUpperCase();
const clone = o => JSON.parse(JSON.stringify(o));
const US = 1e6;

function probeDur(file) {
  try { return Math.round(parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${file}"`).toString().trim()) * US); }
  catch { return 5 * US; }
}
function probeWH(file) {
  try { const [w, h] = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "${file}"`).toString().trim().split('x').map(Number); return { w: w || 1920, h: h || 1080 }; }
  catch { return { w: 1920, h: 1080 }; }
}

// ---- template harvesting: pull one segment (+its material +extra_material_refs +a track) per type ----
function findMat(content, id) {
  for (const k of Object.keys(content.materials || {})) {
    if (Array.isArray(content.materials[k])) { const m = content.materials[k].find(x => x && x.id === id); if (m) return [k, m]; }
  }
  return [null, null];
}
function harvest(content) {
  const t = { tracks: {} };
  for (const track of content.tracks || []) {
    if (!t.tracks[track.type]) { const tk = clone(track); tk.segments = []; t.tracks[track.type] = tk; }
    for (const seg of (track.segments || [])) {
      const [, mat] = findMat(content, seg.material_id);
      const type = mat && mat.type ? mat.type : track.type;
      if (t[type]) continue;
      if (!mat) continue;
      const refs = (seg.extra_material_refs || []).map(id => { const [k, m] = findMat(content, id); return m ? { k, m: clone(m) } : null; }).filter(Boolean);
      t[type] = { seg: clone(seg), mat: clone(mat), refs };
    }
  }
  return t;
}

export function listDrafts() {
  let names = [];
  try { names = fs.readdirSync(DRAFTS_DIR).filter(n => { try { return fs.statSync(path.join(DRAFTS_DIR, n)).isDirectory() && contentPath(path.join(DRAFTS_DIR, n)) !== null; } catch { return false; } }); } catch {}
  return names.map(name => {
    const dir = path.join(DRAFTS_DIR, name);
    let dur = null;
    try { dur = JSON.parse(fs.readFileSync(contentPath(dir), 'utf8')).duration / US; } catch {}
    return { name, locked: fs.existsSync(path.join(dir, '.locked')), durationSec: dur };
  });
}

// is CapCut running? (writing while open gets clobbered by autosave)
function capcutRunning() {
  if (process.platform === 'win32') {
    try { return /CapCut\.exe/i.test(execSync('tasklist /FI "IMAGENAME eq CapCut.exe" /NH', { encoding: 'utf8' })); }
    catch { return false; }
  }
  // Without this branch the check returned false on anything but Windows, so
  // on macOS the "refuses to save while CapCut is running" protection did not
  // exist: a save with CapCut open races its autosave, and whichever writes
  // last wins. That risks silently destroying work in the editor.
  //
  // pgrep -x matches the process name exactly, so it cannot be fooled by an
  // unrelated process whose command line merely mentions CapCut -- including
  // this MCP server itself, whose path contains "capcut-mcp" and which a
  // substring match (`pgrep -f capcut`) would match, making the guard fire
  // permanently and refuse every save.
  if (process.platform === 'darwin') {
    try { return execSync('pgrep -x CapCut || true', { encoding: 'utf8' }).trim().length > 0; }
    catch { return false; }
  }
  return false;
}

export class CapCutDraft {
  constructor(name) {
    this.name = name;
    this.dir = path.join(DRAFTS_DIR, name);
    this.contentPath = contentPath(this.dir);
    if (!this.contentPath) throw new Error(`draft not found: ${name} (in ${DRAFTS_DIR})`);
    this.content = JSON.parse(fs.readFileSync(this.contentPath, 'utf8'));
    this.metaPath = path.join(this.dir, 'draft_meta_info.json');
    this.meta = fs.existsSync(this.metaPath) ? JSON.parse(fs.readFileSync(this.metaPath, 'utf8')) : null;
    this._tpl = null;
  }
  templates() {
    if (this._tpl) return this._tpl;
    let t = harvest(this.content);
    // fill any missing segment type from the template draft
    if (!t.video || !t.text || !t.audio) {
      try { const base = JSON.parse(fs.readFileSync(contentPath(path.join(DRAFTS_DIR, TEMPLATE_DRAFT)), 'utf8')); const bt = harvest(base);
        for (const k of ['video', 'audio', 'text', 'image']) if (!t[k] && bt[k]) t[k] = bt[k];
        for (const k of Object.keys(bt.tracks)) if (!t.tracks[k]) t.tracks[k] = bt.tracks[k];
      } catch {}
    }
    this._tpl = t; return t;
  }
  _mats(key) { this.content.materials[key] = this.content.materials[key] || []; return this.content.materials[key]; }
  _nextRender() { let m = -1; for (const tr of this.content.tracks) for (const s of (tr.segments || [])) if ((s.render_index || 0) > m) m = s.render_index; return m + 1; }

  // ---------- read ----------
  timeline() {
    const c = this.content;
    return {
      name: this.name, durationSec: +(c.duration / US).toFixed(3), fps: c.fps,
      canvas: c.canvas_config && { w: c.canvas_config.width, h: c.canvas_config.height, ratio: c.canvas_config.ratio },
      locked: fs.existsSync(path.join(this.dir, '.locked')), capcutRunning: capcutRunning(),
      tracks: (c.tracks || []).map((tr, ti) => ({
        index: ti, type: tr.type, name: tr.name, segments: (tr.segments || []).map(s => {
          const [, m] = findMat(c, s.material_id);
          return {
            id: s.id, material: m ? (m.material_name || (m.path || '').split(/[\\/]/).pop() || m.type) : null,
            atSec: +(s.target_timerange.start / US).toFixed(3), durSec: +(s.target_timerange.duration / US).toFixed(3),
            srcStartSec: +((s.source_timerange?.start || 0) / US).toFixed(3), renderIndex: s.render_index, trackRenderIndex: s.track_render_index,
          };
        }),
      })),
    };
  }

  // ---------- tracks ----------
  addTrack(type = 'video', name) {
    const tpl = this.templates().tracks[type] || this.templates().tracks.video;
    if (!tpl) throw new Error(`no track template for type ${type}`);
    const tk = clone(tpl); tk.id = uid(); tk.segments = []; tk.name = name || `${type} track`; tk.is_default_name = false;
    this.content.tracks.push(tk);
    return this.content.tracks.length - 1;
  }
  _resolveTrack(opts, type) {
    if (opts.trackIndex != null) { const tr = this.content.tracks[opts.trackIndex]; if (!tr) throw new Error(`no track at index ${opts.trackIndex}`); return tr; }
    if (opts.trackId) { const tr = this.content.tracks.find(t => t.id === opts.trackId); if (!tr) throw new Error(`no track ${opts.trackId}`); return tr; }
    let tr = this.content.tracks.find(t => t.type === type); if (tr) return tr;
    return this.content.tracks[this.addTrack(type)];
  }

  // ---------- add media (video/image/audio) ----------
  _addMedia(kind, file, opts) {
    if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
    const type = kind === 'audio' ? 'audio' : (kind === 'image' ? 'photo' : 'video');
    const tplType = kind === 'image' ? (this.templates().image ? 'image' : 'video') : kind;
    const tpl = this.templates()[tplType] || this.templates().video;
    if (!tpl) throw new Error(`no ${kind} template available`);
    const dur = opts.durUs != null ? opts.durUs : probeDur(file);
    const mat = clone(tpl.mat); mat.id = uid(); mat.path = file.replace(/\\/g, '/'); mat.material_name = path.basename(file); mat.type = type;
    if (kind !== 'audio') { const { w, h } = probeWH(file); mat.width = w; mat.height = h; }
    // This was:
    //   kind === 'audio' ? probeDur(file) : (mat.duration || probeDur(file))
    // The video branch kept the duration of whatever material the TEMPLATE
    // was cloned from -- 14.6s here -- so every generated video material
    // claims the source file is 14.6 seconds long. CapCut then treats any
    // source_timerange.start beyond that as out of range and clamps it to 0,
    // so every segment plays from the beginning of its file no matter what
    // in-point was written. A 27-minute two-camera cut came out as both
    // cameras replaying their opening seconds over and over.
    //
    // Audio never had the bug because its branch always probed. That
    // asymmetry is what identified it: the WAVs were in sync and only the
    // video was wrong, twice over (this and local_material_id).
    //
    // Always probe. The `||` saved one ffprobe call and cost correctness.
    mat.duration = probeDur(file);
    ['local_material_id', 'origin_material_id', 'local_id', 'request_id', 'aigc_history_id', 'aigc_item_id'].forEach(k => { if (k in mat) mat[k] = ''; });
    const matKey = kind === 'audio' ? 'audios' : (kind === 'image' ? 'videos' : 'videos'); // CapCut stores images in videos[]
    this._mats(matKey).push(mat);
    const refs = tpl.refs.map(({ k, m }) => { const c = clone(m); c.id = uid(); this._mats(k).push(c); return c.id; });
    const seg = clone(tpl.seg); seg.id = uid(); seg.material_id = mat.id; seg.extra_material_refs = refs;
    const at = opts.atUs || 0;
    seg.target_timerange = { start: at, duration: dur };
    seg.source_timerange = { start: opts.srcStartUs || 0, duration: dur };
    this._applyProps(seg, opts);
    seg.render_index = this._nextRender();
    const track = this._resolveTrack(opts, kind === 'audio' ? 'audio' : 'video');
    seg.track_render_index = opts.trackRenderIndex != null ? opts.trackRenderIndex : (this.content.tracks.indexOf(track));
    track.segments.push(seg);
    this.content.duration = Math.max(this.content.duration || 0, at + dur);
    return { segmentId: seg.id, endUs: at + dur };
  }
  addVideo(file, opts = {}) { return this._addMedia('video', file, opts); }
  addImage(file, opts = {}) { return this._addMedia('image', file, opts); }
  addAudio(file, opts = {}) { return this._addMedia('audio', file, opts); }

  // ---------- text ----------
  addText(text, opts = {}) {
    const tpl = this.templates().text;
    if (!tpl) throw new Error('no text template found. Set CAPCUT_TEMPLATE_DRAFT to a draft that contains a text layer.');
    const mat = clone(tpl.mat); mat.id = uid();
    try {
      const content = JSON.parse(mat.content);
      content.text = text;
      if (content.styles && content.styles[0]) {
        content.styles[0].range = [0, text.length];
        if (opts.color) content.styles[0].fill = { content: { solid: { color: hexToRgb(opts.color) } } };
        if (opts.fontSize) content.styles[0].size = opts.fontSize;
      }
      mat.content = JSON.stringify(content);
    } catch { mat.content = JSON.stringify({ text, styles: [{ range: [0, text.length], size: opts.fontSize || 15, fill: { content: { solid: { color: hexToRgb(opts.color || '#ffffff') } } } }] }); }
    this._mats('texts').push(mat);
    const refs = tpl.refs.map(({ k, m }) => { const c = clone(m); c.id = uid(); this._mats(k).push(c); return c.id; });
    const seg = clone(tpl.seg); seg.id = uid(); seg.material_id = mat.id; seg.extra_material_refs = refs;
    const at = opts.atUs || 0, dur = opts.durUs || 3 * US;
    seg.target_timerange = { start: at, duration: dur };
    seg.source_timerange = { start: 0, duration: dur };
    this._applyProps(seg, opts);
    seg.render_index = this._nextRender();
    const track = this._resolveTrack(opts, 'text');
    seg.track_render_index = opts.trackRenderIndex != null ? opts.trackRenderIndex : this.content.tracks.indexOf(track);
    track.segments.push(seg);
    this.content.duration = Math.max(this.content.duration || 0, at + dur);
    return { segmentId: seg.id, endUs: at + dur };
  }

  // ---------- edit existing segments ----------
  _find(segId) { for (const tr of this.content.tracks) { const s = (tr.segments || []).find(x => x.id === segId); if (s) return { tr, s }; } throw new Error(`segment not found: ${segId}`); }
  moveSegment(segId, atUs, newTrackIndex) {
    const { tr, s } = this._find(segId); const dur = s.target_timerange.duration;
    s.target_timerange.start = atUs;
    if (newTrackIndex != null && this.content.tracks[newTrackIndex]) { tr.segments = tr.segments.filter(x => x.id !== segId); this.content.tracks[newTrackIndex].segments.push(s); }
    this._recalcDuration(); return { segmentId: segId, atSec: atUs / US, durSec: dur / US };
  }
  trimSegment(segId, { atUs, durUs, srcStartUs } = {}) {
    const { s } = this._find(segId);
    if (atUs != null) s.target_timerange.start = atUs;
    if (durUs != null) { s.target_timerange.duration = durUs; s.source_timerange.duration = durUs; }
    if (srcStartUs != null) s.source_timerange.start = srcStartUs;
    this._recalcDuration(); return { segmentId: segId };
  }
  splitSegment(segId, atUs) {
    const { tr, s } = this._find(segId);
    const t0 = s.target_timerange.start, d = s.target_timerange.duration;
    if (atUs <= t0 || atUs >= t0 + d) throw new Error('split point must be inside the segment');
    const left = atUs - t0;
    const right = clone(s); right.id = uid();
    // clone extra_material_refs so the two halves don't share state
    right.extra_material_refs = (s.extra_material_refs || []).map(id => { const [k, m] = findMat(this.content, id); if (!m) return id; const c = clone(m); c.id = uid(); this._mats(k).push(c); return c.id; });
    s.target_timerange.duration = left; s.source_timerange.duration = left;
    right.target_timerange = { start: atUs, duration: d - left };
    right.source_timerange = { start: (s.source_timerange.start || 0) + left, duration: d - left };
    right.render_index = this._nextRender();
    tr.segments.push(right);
    return { left: segId, right: right.id };
  }
  deleteSegment(segId) { const { tr } = this._find(segId); tr.segments = tr.segments.filter(x => x.id !== segId); this._recalcDuration(); return { deleted: segId }; }
  setProps(segId, props = {}) { const { s } = this._find(segId); this._applyProps(s, props); return { segmentId: segId, applied: Object.keys(props) }; }
  _applyProps(seg, p) {
    seg.clip = seg.clip || { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } };
    if (p.scale != null) { seg.clip.scale = { x: p.scale, y: p.scale }; }
    if (p.scaleX != null) seg.clip.scale.x = p.scaleX;
    if (p.scaleY != null) seg.clip.scale.y = p.scaleY;
    if (p.posX != null) seg.clip.transform.x = p.posX;
    if (p.posY != null) seg.clip.transform.y = p.posY;
    if (p.rotation != null) seg.clip.rotation = p.rotation;
    if (p.opacity != null) seg.clip.alpha = p.opacity;
    if (p.volume != null) seg.volume = p.volume;
    if (p.visible != null) seg.visible = p.visible;
    if (p.speed != null) { seg.speed = p.speed; const spId = (seg.extra_material_refs || []).find(id => findMat(this.content, id)[0] === 'speeds'); if (spId) { const [, sp] = findMat(this.content, spId); if (sp) sp.speed = p.speed; } }
  }
  _recalcDuration() { let max = 0; for (const tr of this.content.tracks) for (const s of (tr.segments || [])) max = Math.max(max, s.target_timerange.start + s.target_timerange.duration); this.content.duration = max; }

  // escape hatch: apply a JSON-merge-style patch to content (advanced/undocumented ops)
  rawPatch(patch) { deepMerge(this.content, patch); return { ok: true }; }

  // ---------- validate ----------
  validate() {
    const c = this.content; const issues = [], warnings = [];
    const ids = new Set(); let dupMat = 0;
    for (const k of Object.keys(c.materials || {})) if (Array.isArray(c.materials[k])) for (const m of c.materials[k]) { if (ids.has(m.id)) dupMat++; ids.add(m.id); }
    if (dupMat) issues.push(`${dupMat} duplicate material id(s)`);
    let overlaps = 0;
    const ris = new Map();                                   // render_index -> [ {start,end} ] across all tracks
    for (const tr of c.tracks) {
      const ss = [...(tr.segments || [])].sort((a, b) => a.target_timerange.start - b.target_timerange.start);
      for (const s of ss) { const e = { a: s.target_timerange.start, b: s.target_timerange.start + s.target_timerange.duration }; (ris.get(s.render_index) || ris.set(s.render_index, []).get(s.render_index)).push(e); }
      for (let i = 1; i < ss.length; i++) if (ss[i].target_timerange.start < ss[i - 1].target_timerange.start + ss[i - 1].target_timerange.duration) overlaps++;
    }
    // a duplicate render_index only matters if those two segments actually overlap in time
    let riClash = 0;
    for (const arr of ris.values()) for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) if (arr[i].a < arr[j].b && arr[j].a < arr[i].b) riClash++;
    if (overlaps) issues.push(`${overlaps} overlapping segment(s) on a single track`);
    if (riClash) issues.push(`${riClash} overlapping segment pair(s) share a render_index (ambiguous layer order)`);
    else if (ris.size < [...ris.values()].reduce((n, a) => n + a.length, 0)) warnings.push('some non-overlapping segments share a render_index (harmless; CapCut does this for sequential clips)');
    for (const s of (c.materials?.videos || [])) if (s.path && !fs.existsSync(s.path)) issues.push(`missing media file: ${s.path}`);
    return { ok: issues.length === 0, issues, warnings };
  }

  // ---------- save ----------
  save({ force = false } = {}) {
    if (!force) {
      if (fs.existsSync(path.join(this.dir, '.locked'))) throw new Error('draft is locked (open in CapCut). Close CapCut, or pass force:true. Autosave will overwrite edits made while open.');
      if (capcutRunning()) throw new Error('CapCut is running. Close it before saving, or pass force:true.');
    }
    const v = this.validate();
    const cPath = this.contentPath;
    try { fs.copyFileSync(cPath, cPath + '.mcpbak'); } catch {}
    const tmp = cPath + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.content)); fs.renameSync(tmp, cPath);
    if (this.meta) { try { fs.copyFileSync(this.metaPath, this.metaPath + '.mcpbak'); } catch {} const mt = this.metaPath + '.tmp'; fs.writeFileSync(mt, JSON.stringify(this.meta)); fs.renameSync(mt, this.metaPath); }
    return { saved: this.name, durationSec: +(this.content.duration / US).toFixed(3), validation: v };
  }
}

// clone a whole draft folder to a new name (valid scaffolding), optionally emptied
export function cloneDraft(base, newName, { empty = false } = {}) {
  const src = path.join(DRAFTS_DIR, base), dst = path.join(DRAFTS_DIR, newName);
  if (!contentPath(src)) throw new Error(`base draft not found: ${base}`);
  if (fs.existsSync(dst)) throw new Error(`draft already exists: ${newName}`);
  fs.mkdirSync(dst, { recursive: true });
  for (const fn of fs.readdirSync(src)) { const s = path.join(src, fn); try { if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(dst, fn)); } catch {} }
  if (empty) {
    const d = new CapCutDraft(newName);
    for (const k of Object.keys(d.content.materials)) if (Array.isArray(d.content.materials[k])) d.content.materials[k] = [];
    for (const tr of d.content.tracks) tr.segments = [];
    d.content.duration = 0; d.content.id = uid(); d.content.name = newName;
    fs.writeFileSync(contentPath(dst), JSON.stringify(d.content));
  }
  return { created: newName, dir: dst };
}

function hexToRgb(hex) { const h = hex.replace('#', ''); return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]; }
function deepMerge(t, s) { for (const k of Object.keys(s)) { if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k]) && t[k] && typeof t[k] === 'object') deepMerge(t[k], s[k]); else t[k] = s[k]; } return t; }

export const _us = US;
