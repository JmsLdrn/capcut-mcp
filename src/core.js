// capcut-core: read/edit CapCut desktop draft projects by cloning real templates
// out of a base draft (the only reliable way to produce valid CapCut JSON).
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { probeSync, cfg, APP_DIR } from './media.js';

// ---- where the drafts live (override with CAPCUT_DRAFTS_DIR) ----
const STD_WIN = path.join(os.homedir(), 'AppData/Local/CapCut/User Data/Projects/com.lveditor.draft');
const STD_MAC = path.join(os.homedir(), 'Movies/CapCut/User Data/Projects/com.lveditor.draft');
const CANDIDATES = [cfg(process.env.CAPCUT_DRAFTS_DIR), STD_WIN, STD_MAC, 'D:/Capcut/CapCut Drafts'].filter(Boolean);
const isDir = d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
export const DRAFTS_DIR = CANDIDATES.find(isDir) || (process.platform === 'win32' ? STD_WIN : STD_MAC);
// optional: a draft known to contain a text layer (otherwise we search all drafts for one)
const TEMPLATE_DRAFT = cfg(process.env.CAPCUT_TEMPLATE_DRAFT);
const BACKUP_DIR = path.join(APP_DIR, 'backups');
const KEEP_BACKUPS = 25;

const uid = () => crypto.randomUUID().toUpperCase();
const clone = o => JSON.parse(JSON.stringify(o));
const US = 1e6;
const r3 = x => +x.toFixed(3);
const PHOTO_DURATION = 10800000000;               // what CapCut stores for still images
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
function writeAtomic(p, data) { const tmp = p + '.tmp'; fs.writeFileSync(tmp, data); fs.renameSync(tmp, p); }
const safeName = s => s.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_');

// ---- material lookup ----
function findMat(content, id) {
  for (const k of Object.keys(content.materials || {})) {
    if (Array.isArray(content.materials[k])) { const m = content.materials[k].find(x => x && x.id === id); if (m) return [k, m]; }
  }
  return [null, null];
}
function textOf(mat) { try { return JSON.parse(mat.content).text; } catch { return mat && (mat.content || mat.name) || ''; } }

// ---- template harvesting: one segment (+material +extra refs +empty track) per kind ----
// kinds: video, image, audio, text
function harvest(content) {
  const t = { tracks: {} };
  for (const track of content.tracks || []) {
    if (!t.tracks[track.type]) { const tk = clone(track); tk.segments = []; t.tracks[track.type] = tk; }
    for (const seg of (track.segments || [])) {
      const [k, mat] = findMat(content, seg.material_id);
      if (!mat) continue;
      let kind = null;
      if (track.type === 'video' && k === 'videos') kind = mat.type === 'photo' ? 'image' : 'video';
      else if (track.type === 'audio' && k === 'audios') kind = 'audio';
      else if (track.type === 'text' && k === 'texts') kind = 'text';
      if (!kind || t[kind]) continue;
      const refs = (seg.extra_material_refs || []).map(id => { const [rk, m] = findMat(content, id); return m ? { k: rk, m: clone(m) } : null; }).filter(Boolean);
      t[kind] = { seg: clone(seg), mat: clone(mat), refs };
    }
  }
  return t;
}
let fallbackTpl = null;                              // harvested from other drafts, cached
function fallbackTemplates() {
  if (fallbackTpl) return fallbackTpl;
  const acc = { tracks: {} };
  const names = [];
  if (TEMPLATE_DRAFT) names.push(TEMPLATE_DRAFT);
  for (const d of listDrafts()) if (d.name !== TEMPLATE_DRAFT) names.push(d.name);
  for (const name of names) {
    let c; try { c = readJson(path.join(DRAFTS_DIR, name, 'draft_content.json')); } catch { continue; }
    const h = harvest(c);
    for (const k of ['video', 'image', 'audio', 'text']) if (!acc[k] && h[k]) { acc[k] = h[k]; acc[k].from = name; }
    for (const k of Object.keys(h.tracks)) if (!acc.tracks[k]) acc.tracks[k] = h.tracks[k];
    if (acc.video && acc.audio && acc.text && acc.image) break;
  }
  return (fallbackTpl = acc);
}

export function listDrafts() {
  let names = [];
  try { names = fs.readdirSync(DRAFTS_DIR).filter(n => fs.existsSync(path.join(DRAFTS_DIR, n, 'draft_content.json'))); } catch {}
  return names.map(name => {
    const dir = path.join(DRAFTS_DIR, name);
    let dur = null, mtime = 0;
    try { const p = path.join(dir, 'draft_content.json'); mtime = fs.statSync(p).mtimeMs; dur = readJson(p).duration / US; } catch {}
    return { name, durationSec: dur != null ? r3(dur) : null, modified: new Date(mtime).toISOString().slice(0, 16).replace('T', ' '), locked: fs.existsSync(path.join(dir, '.locked')), _m: mtime };
  }).sort((a, b) => b._m - a._m).map(({ _m, ...d }) => d);
}

// is CapCut running? (writing while open gets clobbered by autosave)
export function capcutRunning() {
  if (process.platform !== 'win32') return false;
  try { return /CapCut\.exe/i.test(execSync('tasklist /FI "IMAGENAME eq CapCut.exe" /NH', { encoding: 'utf8', windowsHide: true })); }
  catch { return false; }
}
function guardClosed(dir, force) {
  if (force) return;
  if (dir && fs.existsSync(path.join(dir, '.locked'))) throw new Error('la bozza è aperta in CapCut (.locked). Chiudi CapCut e riprova: l\'autosalvataggio cancellerebbe le modifiche.');
  if (capcutRunning()) throw new Error('CapCut è aperto. Chiudilo del tutto e riprova: l\'autosalvataggio cancellerebbe le modifiche.');
}

// ---- backups (outside the CapCut folder, so CapCut never sees them) ----
function timelineFiles(dir) {
  const tl = path.join(dir, 'Timelines');
  if (!isDir(tl)) return [];
  return fs.readdirSync(tl).map(id => ({ id, p: path.join(tl, id, 'draft_content.json') })).filter(x => fs.existsSync(x.p));
}
export function backupDraft(name, reason = '') {
  const dir = path.join(DRAFTS_DIR, name);
  const base = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().replace(/[:T]/g, '-').slice(0, 19);
  let stamp = base, n = 2;
  while (fs.existsSync(path.join(BACKUP_DIR, safeName(name), stamp))) stamp = `${base}_${n++}`;   // never overwrite a backup
  const dest = path.join(BACKUP_DIR, safeName(name), stamp);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ['draft_content.json', 'draft_meta_info.json']) if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(dest, f));
  for (const { id, p } of timelineFiles(dir)) { fs.mkdirSync(path.join(dest, 'Timelines', id), { recursive: true }); fs.copyFileSync(p, path.join(dest, 'Timelines', id, 'draft_content.json')); }
  if (reason) fs.writeFileSync(path.join(dest, 'reason.txt'), reason);
  // prune old ones
  const all = fs.readdirSync(path.join(BACKUP_DIR, safeName(name))).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) fs.rmSync(path.join(BACKUP_DIR, safeName(name), old), { recursive: true, force: true });
  return stamp;
}
export function listBackups(name) {
  const d = path.join(BACKUP_DIR, safeName(name));
  if (!isDir(d)) return { draft: name, backups: [] };
  return {
    draft: name, folder: d,
    backups: fs.readdirSync(d).sort().reverse().map(id => {
      let dur = null, reason = '';
      try { dur = r3(readJson(path.join(d, id, 'draft_content.json')).duration / US); } catch {}
      try { reason = fs.readFileSync(path.join(d, id, 'reason.txt'), 'utf8'); } catch {}
      return { id, durationSec: dur, reason };
    }),
  };
}
export function restoreBackup(name, id, { force = false } = {}) {
  const dir = path.join(DRAFTS_DIR, name), src = path.join(BACKUP_DIR, safeName(name), id);
  if (!fs.existsSync(path.join(src, 'draft_content.json'))) throw new Error(`backup non trovato: ${id}`);
  guardClosed(dir, force);
  const before = backupDraft(name, `prima del ripristino di ${id}`);
  fs.copyFileSync(path.join(src, 'draft_content.json'), path.join(dir, 'draft_content.json'));
  if (fs.existsSync(path.join(src, 'draft_meta_info.json'))) fs.copyFileSync(path.join(src, 'draft_meta_info.json'), path.join(dir, 'draft_meta_info.json'));
  const tl = path.join(src, 'Timelines');
  if (isDir(tl)) for (const tid of fs.readdirSync(tl)) {
    const target = path.join(dir, 'Timelines', tid);
    if (isDir(target)) fs.copyFileSync(path.join(tl, tid, 'draft_content.json'), path.join(target, 'draft_content.json'));
  }
  return { restored: id, draft: name, safetyBackup: before };
}

// refs that every clip carries (kept, reset) vs. "looks" that belong to the template clip (dropped)
const STRUCTURAL_REFS = new Set(['speeds', 'placeholder_infos', 'canvases', 'sound_channel_mappings', 'material_colors', 'vocal_separations', 'beats']);
export const STYLE_KINDS = ['transitions', 'material_animations', 'video_effects', 'audio_fades', 'chromas', 'hsl', 'effects'];

export class CapCutDraft {
  constructor(name) {
    this.name = name;
    this.dir = path.join(DRAFTS_DIR, name);
    if (!fs.existsSync(path.join(this.dir, 'draft_content.json'))) throw new Error(`bozza non trovata: "${name}" (in ${DRAFTS_DIR}). Usa capcut_list_drafts per i nomi esatti.`);
    this.content = readJson(path.join(this.dir, 'draft_content.json'));
    this.metaPath = path.join(this.dir, 'draft_meta_info.json');
    this.meta = fs.existsSync(this.metaPath) ? readJson(this.metaPath) : null;
    this._tpl = null;
  }
  templates() {
    if (this._tpl) return this._tpl;
    const t = harvest(this.content);
    if (!t.video || !t.text || !t.audio || !t.image) {
      const f = fallbackTemplates();
      for (const k of ['video', 'audio', 'text', 'image']) if (!t[k] && f[k]) t[k] = f[k];
      for (const k of Object.keys(f.tracks)) if (!t.tracks[k]) t.tracks[k] = f.tracks[k];
    }
    return (this._tpl = t);
  }
  _mats(key) { this.content.materials[key] = this.content.materials[key] || []; return this.content.materials[key]; }
  _nextRender() { let m = -1; for (const tr of this.content.tracks) for (const s of (tr.segments || [])) if ((s.render_index || 0) > m) m = s.render_index; return m + 1; }
  _fps() { return this.content.fps || 30; }
  _frame(us) { const f = this._fps(); return Math.round(Math.round(us * f / US) * US / f); }   // snap to a frame
  _matPath(seg) { const [, m] = findMat(this.content, seg.material_id); return m && m.path ? m.path : ''; }
  _cloneRef(id) { const [k, m] = findMat(this.content, id); if (!m) return id; const c = clone(m); c.id = uid(); this._mats(k).push(c); return c.id; }
  // a full, independent copy of a segment: own material + own extra materials (CapCut's convention)
  _cloneSegment(s) {
    const c = clone(s); c.id = uid();
    const [k, m] = findMat(this.content, s.material_id);
    if (m) { const mc = clone(m); mc.id = uid(); this._mats(k).push(mc); c.material_id = mc.id; }
    c.extra_material_refs = (s.extra_material_refs || []).map(id => this._cloneRef(id));
    return c;
  }

  // ---------- read ----------
  timeline() {
    const c = this.content;
    return {
      name: this.name, durationSec: r3(c.duration / US), fps: c.fps,
      canvas: c.canvas_config && { w: c.canvas_config.width, h: c.canvas_config.height, ratio: c.canvas_config.ratio },
      locked: fs.existsSync(path.join(this.dir, '.locked')), capcutRunning: capcutRunning(),
      tracks: (c.tracks || []).map((tr, ti) => ({
        index: ti, type: tr.type, name: tr.name || undefined, segments: (tr.segments || []).map(s => {
          const [k, m] = findMat(c, s.material_id);
          const out = {
            id: s.id,
            atSec: r3(s.target_timerange.start / US), durSec: r3(s.target_timerange.duration / US),
            srcStartSec: r3((s.source_timerange?.start || 0) / US),
          };
          if (k === 'texts') out.text = textOf(m);
          else if (m) { out.media = m.material_name || m.name || (m.path || '').split(/[\\/]/).pop() || m.type; if (m.path) out.path = m.path; }
          if (s.speed && s.speed !== 1) out.speed = s.speed;
          if (s.visible === false) out.hidden = true;
          const styles = (s.extra_material_refs || []).map(id => findMat(c, id)).filter(([rk]) => STYLE_KINDS.includes(rk)).map(([rk, rm]) => `${rk}:${styleName(rk, rm)}`);
          if (styles.length) out.styles = styles;
          out.layer = s.render_index;
          return out;
        }),
      })),
    };
  }

  // ---------- tracks ----------
  addTrack(type = 'video', name) {
    const tpl = this.templates().tracks[type] || this.templates().tracks.video;
    if (!tpl) throw new Error(`nessun modello di traccia per il tipo ${type}`);
    const tk = clone(tpl); tk.id = uid(); tk.segments = []; tk.name = name || ''; tk.is_default_name = !name;
    this.content.tracks.push(tk);
    return this.content.tracks.length - 1;
  }
  // explicit track, else the first track of that type that is free over [at, at+dur]
  // (never the main video track: overlays must sit above it), else a new track
  _resolveTrack(opts, type, atUs = 0, durUs = 0) {
    if (opts.trackIndex != null) { const tr = this.content.tracks[opts.trackIndex]; if (!tr) throw new Error(`nessuna traccia con indice ${opts.trackIndex}`); return tr; }
    if (opts.trackId) { const tr = this.content.tracks.find(t => t.id === opts.trackId); if (!tr) throw new Error(`nessuna traccia ${opts.trackId}`); return tr; }
    const main = this.content.tracks.find(t => t.type === 'video');
    const free = t => (t.segments || []).every(s => s.target_timerange.start >= atUs + durUs || s.target_timerange.start + s.target_timerange.duration <= atUs);
    const tr = this.content.tracks.find(t => t.type === type && t !== main && free(t));
    return tr || this.content.tracks[this.addTrack(type)];
  }

  // ---------- add media (video/image/audio) ----------
  _addMedia(kind, file, opts) {
    if (!fs.existsSync(file)) throw new Error(`file non trovato: ${file}`);
    const info = probeSync(file);                       // throws a clear error if ffprobe is missing
    if (kind === 'video' && info.isImage) kind = 'image';
    const isAudio = kind === 'audio';
    const T = this.templates();
    const tpl = isAudio ? T.audio : (kind === 'image' ? (T.image || T.video) : T.video);
    if (!tpl) throw new Error(`nessun clip ${kind} da usare come modello: aggiungi a mano un clip di quel tipo in una bozza qualsiasi`);

    const mat = clone(tpl.mat); mat.id = uid();
    mat.path = file.replace(/\\/g, '/');
    const base = path.basename(file);
    if (isAudio) {
      if ('name' in mat) mat.name = base;
      mat.type = 'extract_music';
      for (const k of ['music_id', 'effect_id', 'resource_id', 'third_resource_id', 'category_id', 'category_name', 'intensifies_path', 'request_id', 'source_from', 'team_id', 'tone_type', 'text_id', 'local_material_id', 'aigc_history_id', 'aigc_item_id']) if (typeof mat[k] === 'string') mat[k] = '';
      if ('source_platform' in mat) mat.source_platform = 0;
      if ('check_flag' in mat) mat.check_flag = 1;
      mat.duration = info.durationUs;
    } else {
      mat.material_name = base;
      mat.type = kind === 'image' ? 'photo' : 'video';
      mat.duration = kind === 'image' ? PHOTO_DURATION : info.durationUs;
      mat.width = info.width || 1080; mat.height = info.height || 1920;
      if ('has_audio' in mat || kind === 'video') mat.has_audio = !!info.hasAudio;
      mat.crop = { upper_left_x: 0, upper_left_y: 0, upper_right_x: 1, upper_right_y: 0, lower_left_x: 0, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1 };
      mat.crop_ratio = 'free'; mat.crop_scale = 1;
      for (const k of ['unique_id', 'media_path', 'reverse_path', 'intensifies_path', 'reverse_intensifies_path', 'intensifies_audio_path', 'cartoon_path', 'local_material_id', 'origin_material_id', 'local_id', 'request_id', 'aigc_history_id', 'aigc_item_id', 'material_id', 'material_url', 'formula_id']) if (typeof mat[k] === 'string') mat[k] = '';
      if (mat.matting && typeof mat.matting === 'object') { if ('flag' in mat.matting) mat.matting.flag = 0; if ('path' in mat.matting) mat.matting.path = ''; }
      if (mat.stable && typeof mat.stable === 'object') { if ('stable_level' in mat.stable) mat.stable.stable_level = 0; if ('matrix_path' in mat.stable) mat.stable.matrix_path = ''; }
      if (mat.video_algorithm && Array.isArray(mat.video_algorithm.algorithms)) mat.video_algorithm.algorithms = [];
      if ('has_sound_separated' in mat) mat.has_sound_separated = false;
    }
    const matKey = isAudio ? 'audios' : 'videos';          // CapCut stores images in videos[]
    this._mats(matKey).push(mat);

    const refs = [];
    for (const { k, m } of tpl.refs) {
      if (!STRUCTURAL_REFS.has(k)) continue;              // don't inherit the template clip's transitions/effects/animations
      const c = clone(m); c.id = uid();
      if (k === 'speeds') { c.speed = 1; if ('curve_speed' in c) c.curve_speed = null; if ('mode' in c) c.mode = 0; }
      if (k === 'beats') { if (Array.isArray(c.user_beats)) c.user_beats = []; if (c.ai_beats) c.ai_beats = { ...c.ai_beats, beats_path: '', melody_path: '', melody_url: '', beats_url: '' }; }
      this._mats(k).push(c); refs.push(c.id);
    }
    const seg = clone(tpl.seg); seg.id = uid(); seg.material_id = mat.id; seg.extra_material_refs = refs;
    resetSegment(seg);
    const at = opts.atUs || 0;
    const srcStart = opts.srcStartUs || 0;
    const full = kind === 'image' ? 5 * US : Math.max(0, info.durationUs - srcStart);
    const dur = opts.durUs != null ? opts.durUs : full;
    seg.target_timerange = { start: at, duration: dur };
    seg.source_timerange = { start: srcStart, duration: dur };
    this._applyProps(seg, opts);
    seg.render_index = this._nextRender();
    const track = this._resolveTrack(opts, isAudio ? 'audio' : 'video', at, dur);
    seg.track_render_index = opts.trackRenderIndex != null ? opts.trackRenderIndex : this.content.tracks.indexOf(track);
    track.segments.push(seg);
    track.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    this._recalcDuration();
    return { segmentId: seg.id, trackIndex: this.content.tracks.indexOf(track), atSec: r3(at / US), durSec: r3(dur / US), media: { width: info.width, height: info.height, hasAudio: info.hasAudio, hasAlpha: info.hasAlpha } };
  }
  addVideo(file, opts = {}) { return this._addMedia('video', file, opts); }
  addImage(file, opts = {}) { return this._addMedia('image', file, opts); }
  addAudio(file, opts = {}) { return this._addMedia('audio', file, opts); }

  // ---------- text ----------
  addText(text, opts = {}) {
    const tpl = this.templates().text;
    if (!tpl) throw new Error('nessun testo da usare come modello: crea a mano un testo in una bozza qualsiasi (lo stile verrà copiato da lì).');
    const mat = clone(tpl.mat); mat.id = uid();
    try {
      const content = JSON.parse(mat.content);
      content.text = text;
      if (content.styles && content.styles[0]) {
        content.styles = [content.styles[0]];
        content.styles[0].range = [0, [...text].length];
        if (opts.color) content.styles[0].fill = { content: { render_type: 'solid', solid: { color: hexToRgb(opts.color) } } };
        if (opts.fontSize) content.styles[0].size = opts.fontSize;
      }
      mat.content = JSON.stringify(content);
    } catch { mat.content = JSON.stringify({ text, styles: [{ range: [0, [...text].length], size: opts.fontSize || 15, fill: { content: { solid: { color: hexToRgb(opts.color || '#ffffff') } } } }] }); }
    if ('base_content' in mat) mat.base_content = '';
    this._mats('texts').push(mat);
    const refs = tpl.refs.map(({ k, m }) => { const c = clone(m); c.id = uid(); this._mats(k).push(c); return c.id; });
    const seg = clone(tpl.seg); seg.id = uid(); seg.material_id = mat.id; seg.extra_material_refs = refs;
    seg.common_keyframes = []; seg.keyframe_refs = [];
    const at = opts.atUs || 0, dur = opts.durUs || 3 * US;
    seg.target_timerange = { start: at, duration: dur };
    seg.source_timerange = { start: 0, duration: dur };
    this._applyProps(seg, opts);
    seg.render_index = this._nextRender();
    const track = this._resolveTrack(opts, 'text', at, dur);
    seg.track_render_index = opts.trackRenderIndex != null ? opts.trackRenderIndex : this.content.tracks.indexOf(track);
    track.segments.push(seg);
    track.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    this._recalcDuration();
    return { segmentId: seg.id, trackIndex: this.content.tracks.indexOf(track), styleFrom: tpl.from || this.name };
  }

  // ---------- edit existing segments ----------
  _find(segId) { for (const tr of this.content.tracks) { const s = (tr.segments || []).find(x => x.id === segId); if (s) return { tr, s }; } throw new Error(`segmento non trovato: ${segId}`); }
  moveSegment(segId, atUs, newTrackIndex) {
    const { tr, s } = this._find(segId); const dur = s.target_timerange.duration;
    s.target_timerange.start = atUs;
    if (newTrackIndex != null) {
      const dst = this.content.tracks[newTrackIndex]; if (!dst) throw new Error(`nessuna traccia con indice ${newTrackIndex}`);
      tr.segments = tr.segments.filter(x => x.id !== segId); dst.segments.push(s); s.track_render_index = newTrackIndex;
    }
    for (const t of this.content.tracks) t.segments.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    this._recalcDuration(); return { segmentId: segId, atSec: r3(atUs / US), durSec: r3(dur / US) };
  }
  trimSegment(segId, { atUs, durUs, srcStartUs } = {}) {
    const { s } = this._find(segId);
    const sp = s.speed || 1;
    if (atUs != null) s.target_timerange.start = atUs;
    if (durUs != null) { s.target_timerange.duration = durUs; s.source_timerange.duration = Math.round(durUs * sp); }
    if (srcStartUs != null) s.source_timerange.start = srcStartUs;
    this._recalcDuration(); return { segmentId: segId };
  }
  splitSegment(segId, atUs) {
    const { tr, s } = this._find(segId);
    const t0 = s.target_timerange.start, d = s.target_timerange.duration, sp = s.speed || 1;
    atUs = this._frame(atUs);
    if (atUs <= t0 || atUs >= t0 + d) throw new Error('il punto di taglio deve stare dentro il segmento');
    const left = atUs - t0;
    const right = this._cloneSegment(s);
    // a transition sits at the END of a clip: after a split it belongs to the right half
    const isTrans = id => findMat(this.content, id)[0] === 'transitions';
    s.extra_material_refs = (s.extra_material_refs || []).filter(id => !isTrans(id));
    s.target_timerange.duration = left; s.source_timerange.duration = Math.round(left * sp);
    right.target_timerange = { start: atUs, duration: d - left };
    right.source_timerange = { start: (s.source_timerange.start || 0) + Math.round(left * sp), duration: Math.round((d - left) * sp) };
    right.render_index = s.render_index;                 // same layer as the original
    tr.segments.splice(tr.segments.indexOf(s) + 1, 0, right);
    return { left: segId, right: right.id };
  }
  deleteSegment(segId) { const { tr } = this._find(segId); tr.segments = tr.segments.filter(x => x.id !== segId); this._recalcDuration(); return { deleted: segId }; }
  setProps(segId, props = {}) { const { s } = this._find(segId); this._applyProps(s, props); return { segmentId: segId, applied: Object.keys(props).filter(k => props[k] != null && k !== 'draft' && k !== 'segmentId') }; }
  _applyProps(seg, p) {
    seg.clip = seg.clip || { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } };
    if (p.scale != null) { seg.clip.scale = { x: p.scale, y: p.scale }; }
    if (p.scaleX != null) seg.clip.scale.x = p.scaleX;
    if (p.scaleY != null) seg.clip.scale.y = p.scaleY;
    if (p.posX != null) seg.clip.transform.x = p.posX;
    if (p.posY != null) seg.clip.transform.y = p.posY;
    if (p.rotation != null) seg.clip.rotation = p.rotation;
    if (p.opacity != null) seg.clip.alpha = p.opacity;
    if (p.volume != null) { seg.volume = p.volume; if (p.volume > 0 && 'last_nonzero_volume' in seg) seg.last_nonzero_volume = p.volume; }
    if (p.visible != null) seg.visible = p.visible;
    if (p.speed != null) {
      const old = seg.speed || 1; seg.speed = p.speed;
      const spId = (seg.extra_material_refs || []).find(id => findMat(this.content, id)[0] === 'speeds');
      if (spId) { const [, sp] = findMat(this.content, spId); if (sp) sp.speed = p.speed; }
      if (seg.target_timerange) seg.target_timerange.duration = Math.round(seg.target_timerange.duration * old / p.speed);
      if (this.content) this._recalcDuration();
    }
  }
  _recalcDuration() { let max = 0; for (const tr of this.content.tracks) for (const s of (tr.segments || [])) max = Math.max(max, s.target_timerange.start + s.target_timerange.duration); this.content.duration = max; }

  // ---------- rough cut (premontaggio) ----------
  // keeps: [{ file | segmentId, startSec, endSec, note }] in SOURCE seconds, in final order.
  // Rebuilds the main video track as the keeps laid end to end; every keep becomes its own segment.
  roughCut(keeps, { trackIndex, padSec = 0.08 } = {}) {
    if (!Array.isArray(keeps) || !keeps.length) throw new Error('serve almeno una parte da tenere');
    const ti = trackIndex != null ? trackIndex : this.content.tracks.findIndex(t => t.type === 'video');
    const tr = this.content.tracks[ti];
    if (!tr || tr.type !== 'video') throw new Error(`la traccia ${ti} non è una traccia video`);
    const origs = tr.segments.map(s => ({ s, path: this._matPath(s) }));
    const norm = p => path.basename(String(p || '')).toLowerCase();
    const stem = p => norm(p).replace(/\.[^.]+$/, '');
    const pick = k => {
      if (k.segmentId) { const o = origs.find(o => o.s.id === k.segmentId); if (!o) throw new Error(`segmento non trovato sulla traccia ${ti}: ${k.segmentId}`); return o; }
      const want = String(k.file || '');
      const cands = origs.filter(o => o.path && (o.path.replace(/\\/g, '/').toLowerCase() === want.replace(/\\/g, '/').toLowerCase() || norm(o.path) === norm(want) || stem(o.path) === stem(want)));
      if (!cands.length) throw new Error(`nessun clip della traccia ${ti} usa il file "${want}". File presenti: ${[...new Set(origs.map(o => path.basename(o.path)))].join(', ')}`);
      return cands.find(o => { const a = o.s.source_timerange.start / US, b = a + o.s.source_timerange.duration / US; return k.startSec >= a - 0.01 && k.endSec <= b + 0.01; }) || cands[0];
    };
    const plan = keeps.map(k => {
      if (!(k.endSec > k.startSec)) throw new Error(`parte non valida: ${JSON.stringify(k)}`);
      const o = pick(k); const [, m] = findMat(this.content, o.s.material_id);
      const max = m && m.duration ? m.duration : Infinity;
      return { k, o, A: Math.max(0, this._frame((k.startSec - padSec) * US)), B: Math.min(max, this._frame((k.endSec + padSec) * US)) };
    });
    // padding must never make two consecutive keeps of the same file overlap
    for (let i = 1; i < plan.length; i++) {
      const p = plan[i - 1], q = plan[i];
      if (p.o.path === q.o.path && q.A < p.B && q.k.startSec >= p.k.endSec) { const mid = this._frame((p.k.endSec + q.k.startSec) / 2 * US); p.B = Math.min(p.B, mid); q.A = Math.max(q.A, mid); }
    }
    const segs = []; let cursor = 0; const report = [];
    for (const { k, o, A, B } of plan) {
      const sp = o.s.speed || 1;
      const seg = this._cloneSegment(o.s);
      seg.extra_material_refs = seg.extra_material_refs.filter(id => findMat(this.content, id)[0] !== 'transitions');
      seg.source_timerange = { start: A, duration: B - A };
      const dur = this._frame((B - A) / sp);
      seg.target_timerange = { start: cursor, duration: dur };
      seg.render_index = o.s.render_index;
      segs.push(seg);
      report.push({ atSec: r3(cursor / US), durSec: r3(dur / US), file: path.basename(o.path), srcSec: [r3(A / US), r3(B / US)], note: k.note || undefined });
      cursor += dur;
    }
    const removed = tr.segments.length;
    tr.segments = segs;
    this._recalcDuration();
    const others = this.content.tracks.map((t, i) => ({ i, t })).filter(({ i, t }) => i !== ti && (t.segments || []).length)
      .map(({ i, t }) => `traccia ${i} (${t.type}): ${t.segments.length} elementi non spostati`);
    return { trackIndex: ti, removedSegments: removed, keptSegments: segs.length, mainTrackSec: r3(cursor / US), otherTracksNotMoved: others, cuts: report };
  }

  // ---------- styles (transitions / animations / effects copied from a clip that already has them) ----------
  applyStyle(segIds, { fromDraft, fromSegmentId, kinds }) {
    const src = !fromDraft || fromDraft === this.name ? this : new CapCutDraft(fromDraft);
    const { s: from } = src._find(fromSegmentId);
    const want = kinds && kinds.length ? kinds : STYLE_KINDS;
    const mats = (from.extra_material_refs || []).map(id => findMat(src.content, id)).filter(([k]) => k && want.includes(k));
    if (!mats.length) throw new Error(`il segmento ${fromSegmentId} non ha stili di tipo ${want.join(', ')}`);
    const applied = [];
    for (const id of segIds) {
      const { s } = this._find(id);
      const kindsHere = new Set(mats.map(([k]) => k));
      s.extra_material_refs = (s.extra_material_refs || []).filter(r => !kindsHere.has(findMat(this.content, r)[0]));
      for (const [k, m] of mats) {
        const c = clone(m); c.id = uid();
        if (k === 'material_animations' && Array.isArray(c.animations)) {
          const segDur = s.target_timerange.duration;
          for (const a of c.animations) { a.duration = Math.min(a.duration, segDur); if (a.type === 'out') a.start = segDur - a.duration; }
        }
        this._mats(k).push(c); s.extra_material_refs.push(c.id);
        applied.push(`${id}: ${k} ${styleName(k, m)}`);
      }
    }
    return { applied };
  }

  // escape hatch: apply a JSON-merge-style patch to content (advanced/undocumented ops)
  rawPatch(patch) { deepMerge(this.content, patch); return { ok: true }; }

  // ---------- validate ----------
  validate() {
    const c = this.content; const issues = [], warnings = [];
    const ids = new Set(); let dupMat = 0;
    for (const k of Object.keys(c.materials || {})) if (Array.isArray(c.materials[k])) for (const m of c.materials[k]) { if (!m || !m.id) continue; if (ids.has(m.id)) dupMat++; ids.add(m.id); }
    if (dupMat) warnings.push(`${dupMat} id di materiale duplicati`);
    let shared = 0; const used = new Map();
    for (const tr of c.tracks) for (const s of tr.segments || []) { used.set(s.material_id, (used.get(s.material_id) || 0) + 1); }
    for (const [id, n] of used) if (n > 1 && findMat(c, id)[0] === 'videos') shared++;
    if (shared) warnings.push(`${shared} materiali video condivisi da più segmenti (CapCut preferisce una copia per segmento)`);
    // (segments on different tracks sharing a render_index is normal in CapCut's own drafts: not checked)
    let overlaps = 0;
    for (const tr of c.tracks) {
      const ss = [...(tr.segments || [])].sort((a, b) => a.target_timerange.start - b.target_timerange.start);
      for (let i = 1; i < ss.length; i++) if (ss[i].target_timerange.start < ss[i - 1].target_timerange.start + ss[i - 1].target_timerange.duration - 1) overlaps++;
      for (const s of ss) if (!ids.has(s.material_id)) issues.push(`il segmento ${s.id} punta a un materiale inesistente`);
    }
    if (overlaps) issues.push(`${overlaps} segmenti sovrapposti sulla stessa traccia`);
    const missing = new Set();
    for (const k of ['videos', 'audios']) for (const m of (c.materials?.[k] || [])) if (m.path && !/^(##|http)/.test(m.path) && !fs.existsSync(m.path)) missing.add(m.path);
    if (missing.size) warnings.push(`file media mancanti: ${[...missing].slice(0, 8).join(' | ')}${missing.size > 8 ? ` (+${missing.size - 8})` : ''}`);
    return { ok: issues.length === 0, issues, warnings };
  }

  // ---------- save ----------
  save({ force = false, reason = '' } = {}) {
    guardClosed(this.dir, force);
    const v = this.validate();
    if (!v.ok && !force) throw new Error(`salvataggio annullato, la bozza ha problemi: ${v.issues.join('; ')}`);
    const backup = backupDraft(this.name, reason || 'prima di un salvataggio dall\'MCP');
    if (this.meta && 'tm_duration' in this.meta) this.meta.tm_duration = this.content.duration;
    const json = JSON.stringify(this.content);
    writeAtomic(path.join(this.dir, 'draft_content.json'), json);
    // CapCut keeps an identical copy per timeline: update it too, or CapCut may load the old one
    let mirrored = 0;
    for (const { p } of timelineFiles(this.dir)) {
      let same = true; try { const t = readJson(p); same = !t.id || !this.content.id || t.id === this.content.id; } catch {}
      if (same) { writeAtomic(p, json); mirrored++; }
    }
    if (this.meta) writeAtomic(this.metaPath, JSON.stringify(this.meta));
    return { saved: this.name, durationSec: r3(this.content.duration / US), timelinesUpdated: mirrored, backup, validation: v };
  }
}

function resetSegment(seg) {
  seg.clip = { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } };
  if ('uniform_scale' in seg) seg.uniform_scale = { on: true, value: 1 };
  seg.common_keyframes = []; seg.keyframe_refs = [];
  seg.speed = 1; seg.volume = 1; if ('last_nonzero_volume' in seg) seg.last_nonzero_volume = 1;
  seg.visible = true; seg.reverse = false;
  for (const k of ['is_loop', 'intensifies_audio', 'cartoon', 'is_placeholder']) if (k in seg) seg[k] = false;
  for (const k of ['raw_segment_id', 'group_id', 'template_id']) if (typeof seg[k] === 'string') seg[k] = '';
  if ('caption_info' in seg) seg.caption_info = null;
}

function styleName(kind, m) {
  if (!m) return '?';
  if (kind === 'material_animations') return (m.animations || []).map(a => `${a.type}:${a.name || a.resource_id}`).join('+') || 'vuota';
  return m.name || m.effect_name || m.type || m.resource_id || '?';
}

// every transition / animation / effect used in any draft, with a clip to copy it from
export function styleLibrary() {
  const seen = new Map();
  for (const d of listDrafts()) {
    let c; try { c = readJson(path.join(DRAFTS_DIR, d.name, 'draft_content.json')); } catch { continue; }
    for (const tr of c.tracks || []) for (const s of tr.segments || []) for (const id of s.extra_material_refs || []) {
      const [k, m] = findMat(c, id);
      if (!STYLE_KINDS.includes(k)) continue;
      const nm = styleName(k, m); if (!nm || nm === 'vuota') continue;
      const key = `${k}|${nm}|${tr.type}`;
      if (!seen.has(key)) seen.set(key, { kind: k, name: nm, onTrack: tr.type, fromDraft: d.name, fromSegmentId: s.id, uses: 0 });
      seen.get(key).uses++;
    }
  }
  return [...seen.values()].sort((a, b) => a.kind.localeCompare(b.kind) || b.uses - a.uses);
}

// clone a whole draft folder to a new name, registering it so CapCut lists it
export function cloneDraft(base, newName, { empty = false, force = false } = {}) {
  const src = path.join(DRAFTS_DIR, base), dst = path.join(DRAFTS_DIR, newName);
  if (!fs.existsSync(path.join(src, 'draft_content.json'))) throw new Error(`bozza di partenza non trovata: ${base}`);
  if (fs.existsSync(dst)) throw new Error(`esiste già una bozza chiamata: ${newName}`);
  guardClosed(null, force);
  fs.cpSync(src, dst, { recursive: true, filter: s => !/(\.locked|\.mcpbak|\.tmp)$/.test(s) });
  const fwd = p => p.replace(/\\/g, '/');
  const newId = uid();
  const mp = path.join(dst, 'draft_meta_info.json');
  if (fs.existsSync(mp)) {
    const meta = readJson(mp);
    meta.draft_fold_path = fwd(dst); meta.draft_name = newName; meta.draft_id = newId;
    if ('draft_root_path' in meta) meta.draft_root_path = fwd(DRAFTS_DIR);
    if (empty && 'tm_duration' in meta) meta.tm_duration = 0;
    writeAtomic(mp, JSON.stringify(meta));
  }
  if (empty) {
    const d = new CapCutDraft(newName);
    for (const k of Object.keys(d.content.materials)) if (Array.isArray(d.content.materials[k])) d.content.materials[k] = [];
    for (const tr of d.content.tracks) tr.segments = [];
    d.content.duration = 0;
    const json = JSON.stringify(d.content);
    writeAtomic(path.join(dst, 'draft_content.json'), json);
    for (const { p } of timelineFiles(dst)) writeAtomic(p, json);
  }
  // register in CapCut's draft index
  const rootMeta = path.join(DRAFTS_DIR, 'root_meta_info.json');
  let registered = false;
  try {
    const r = readJson(rootMeta);
    const store = r.all_draft_store || [];
    const from = store.find(e => fwd(e.draft_fold_path || '') === fwd(src));
    if (from) {
      const e = JSON.parse(JSON.stringify(from).split(fwd(src)).join(fwd(dst)));
      e.draft_id = newId; e.draft_name = newName;
      if ('tm_draft_modified' in e) e.tm_draft_modified = Date.now() * 1000;
      if ('tm_draft_create' in e) e.tm_draft_create = Date.now() * 1000;
      store.unshift(e); r.all_draft_store = store;
      fs.copyFileSync(rootMeta, rootMeta + '.mcpbak');
      writeAtomic(rootMeta, JSON.stringify(r));
      registered = true;
    }
  } catch {}
  return { created: newName, dir: dst, registeredInCapCut: registered };
}

function hexToRgb(hex) { const h = hex.replace('#', ''); return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]; }
function deepMerge(t, s) { for (const k of Object.keys(s)) { if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k]) && t[k] && typeof t[k] === 'object') deepMerge(t[k], s[k]); else t[k] = s[k]; } return t; }

export const _us = US;
