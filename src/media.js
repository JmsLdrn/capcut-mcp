// capcut-media: everything that touches media files outside the CapCut draft JSON —
// locating ffmpeg/ffprobe, probing, frame grabs, speech-block detection, Whisper
// transcription (ffmpeg's built-in whisper.cpp filter), downloads, one-time setup,
// and a tiny background-job runner so long work never hits the client's tool timeout.
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn, execFileSync } from 'child_process';

// ---------- config ----------
// mcpb leaves "${user_config.x}" literally when an optional field is blank: treat that as unset
export const cfg = v => (typeof v === 'string' && v.trim() && !/^\$\{.*\}$/.test(v.trim())) ? v.trim() : '';
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
export const APP_DIR = path.join(process.platform === 'win32' ? LOCALAPPDATA : path.join(os.homedir(), '.local', 'share'), 'capcut-mcp');
export const MODELS_DIR = path.join(APP_DIR, 'models');
const TMP_DIR = path.join(APP_DIR, 'tmp');
const TRANSCRIPTS_DIR = path.join(APP_DIR, 'transcripts');
export const MEDIA_DIR = cfg(process.env.CAPCUT_MEDIA_DIR) || path.join(os.homedir(), 'Videos', 'CapCut MCP');
export const LANGUAGE = cfg(process.env.CAPCUT_LANGUAGE) || 'it';

const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
export const MODELS = {
  'large-v3-turbo-q5_0': { file: 'ggml-large-v3-turbo-q5_0.bin', mb: 574, note: 'consigliato: preciso e veloce' },
  'large-v3-turbo': { file: 'ggml-large-v3-turbo.bin', mb: 1620, note: 'come sopra, non quantizzato' },
  'medium-q5_0': { file: 'ggml-medium-q5_0.bin', mb: 539, note: 'buono, più lento' },
  'small': { file: 'ggml-small.bin', mb: 488, note: 'PC lenti; meno preciso' },
  'base': { file: 'ggml-base.bin', mb: 148, note: 'solo per prove' },
};
const VAD = { file: 'ggml-silero-v5.1.2.bin', url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin' };
export const MODEL_NAME = MODELS[cfg(process.env.CAPCUT_WHISPER_MODEL)] ? cfg(process.env.CAPCUT_WHISPER_MODEL) : 'large-v3-turbo-q5_0';

const mkdirp = d => { fs.mkdirSync(d, { recursive: true }); return d; };
const r2 = x => Math.round(x * 100) / 100;
const exists = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// ---------- ffmpeg / ffprobe discovery ----------
function candidates(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const out = [];
  const envDir = cfg(process.env.CAPCUT_FFMPEG_DIR);
  if (envDir) out.push(path.join(envDir, exe), path.join(envDir, 'bin', exe));
  out.push(path.join(APP_DIR, 'ffmpeg', 'bin', exe));
  if (process.platform === 'win32') {
    // winget's Gyan.FFmpeg is the "full" build, which ships the whisper filter
    out.push(path.join(LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', exe));
    const pk = path.join(LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const d of fs.readdirSync(pk).filter(d => /^Gyan\.FFmpeg/i.test(d)))
        for (const sub of fs.readdirSync(path.join(pk, d))) out.push(path.join(pk, d, sub, 'bin', exe));
    } catch {}
  } else {
    out.push(`/opt/homebrew/bin/${exe}`, `/usr/local/bin/${exe}`);
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) if (dir) out.push(path.join(dir, exe));
  return out;
}
const binCache = {};
export function bin(name, refresh = false) {
  if (!refresh && binCache[name] && exists(binCache[name])) return binCache[name];
  for (const c of candidates(name)) if (exists(c)) return (binCache[name] = c);
  return null;
}
export function need(name) {
  const b = bin(name) || bin(name, true);
  if (!b) throw new Error(`${name} non trovato sul PC. Esegui lo strumento capcut_setup (install:true): installa ffmpeg automaticamente.`);
  return b;
}

let whisperOk = null;
export function hasWhisperFilter() {
  if (whisperOk !== null) return whisperOk;
  const ff = bin('ffmpeg'); if (!ff) return false;
  try { whisperOk = /\bwhisper\b/.test(execFileSync(ff, ['-hide_banner', '-filters'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch { whisperOk = false; }
  return whisperOk;
}
export function ffmpegVersion() {
  const ff = bin('ffmpeg'); if (!ff) return null;
  try { return execFileSync(ff, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true }).split('\n')[0].trim(); } catch { return null; }
}

// spawn with no console window, collecting stdout as Buffer
export function run(name, args, { cwd, timeoutMs = 0, onStdout, onStderr } = {}) {
  const exe = need(name);
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = []; let err = '';
    const timer = timeoutMs ? setTimeout(() => { p.kill(); reject(new Error(`${name} timeout dopo ${timeoutMs / 1000}s`)); }, timeoutMs) : null;
    p.stdout.on('data', d => { out.push(d); onStdout && onStdout(d); });
    p.stderr.on('data', d => { const s = d.toString(); err = (err + s).slice(-20000); onStderr && onStderr(s); });
    p.on('error', e => { if (timer) clearTimeout(timer); reject(e); });
    p.on('close', code => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new Error(`${name} è uscito con codice ${code}: ${err.trim().split('\n').slice(-4).join(' | ')}`));
    });
  });
}

// ---------- probing ----------
function summarize(j) {
  const v = (j.streams || []).find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = (j.streams || []).find(s => s.codec_type === 'audio');
  let w = v ? v.width : null, h = v ? v.height : null;
  // phones store portrait video as landscape + a rotation: report what the viewer sees
  let rot = 0;
  if (v) {
    if (v.tags && v.tags.rotate) rot = +v.tags.rotate;
    for (const sd of v.side_data_list || []) if (sd.rotation != null) rot = +sd.rotation;
    if (Math.abs(rot) % 180 === 90) [w, h] = [h, w];
  }
  const fr = v && (v.avg_frame_rate || v.r_frame_rate);
  const fps = fr && fr.includes('/') ? (([n, d]) => (+d ? +n / +d : null))(fr.split('/')) : null;
  const isImage = !!v && (/^(png|mjpeg|jpeg|webp|bmp|tiff|gif)$/.test(v.codec_name) && (!j.format || !j.format.duration || +j.format.duration < 0.05 || /image2|png_pipe|jpeg_pipe|webp_pipe/.test(j.format.format_name)));
  return {
    durationSec: j.format && j.format.duration ? r2(+j.format.duration) : null,
    durationUs: j.format && j.format.duration ? Math.round(+j.format.duration * 1e6) : 0,
    hasVideo: !!v, hasAudio: !!a, isImage,
    width: w, height: h, rotation: rot, fps: fps ? r2(fps) : null,
    videoCodec: v ? v.codec_name : null, pixFmt: v ? v.pix_fmt : null,
    hasAlpha: !!(v && /^(yuva|rgba|bgra|argb|abgr|ya|gbrap|pal8)/.test(v.pix_fmt || '')),
    audioCodec: a ? a.codec_name : null, sampleRate: a ? +a.sample_rate : null,
    sizeMB: j.format && j.format.size ? r2(+j.format.size / 1048576) : null,
  };
}
const PROBE_ARGS = f => ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f];
export function probeSync(file) {
  const out = execFileSync(need('ffprobe'), PROBE_ARGS(file), { encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20 });
  return summarize(JSON.parse(out));
}
export async function probe(file) {
  if (!exists(file)) throw new Error(`file non trovato: ${file}`);
  const { stdout } = await run('ffprobe', PROBE_ARGS(file), { timeoutMs: 30000 });
  return { file, ...summarize(JSON.parse(stdout.toString())) };
}

// ---------- frames (Claude can look at them) ----------
export async function frames(file, times, { height = 512 } = {}) {
  if (!exists(file)) throw new Error(`file non trovato: ${file}`);
  const out = [];
  for (const t of times.slice(0, 8)) {
    const { stdout } = await run('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1',
      '-vf', `scale=-2:${height}`, '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '4', '-'], { timeoutMs: 30000 });
    if (stdout.length) out.push({ t, data: stdout.toString('base64') });
  }
  return out;
}

// ---------- audio → speech blocks ----------
export async function decodePcm(file, sr = 16000) {
  if (!exists(file)) throw new Error(`file non trovato: ${file}`);
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(sr), '-f', 's16le', '-']);
  return { pcm: new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2)), sr };
}

// Energy-based segmentation. Whisper on a whole recording collapses repeated takes into one,
// so we cut the audio into "blocks of speech" first and transcribe each block on its own.
export function speechBlocks(pcm, sr, { thresholdDb, minGapSec = 0.3, minBlockSec = 0.25 } = {}) {
  const FR = Math.round(0.02 * sr), n = Math.floor(pcm.length / FR);
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0; for (let j = i * FR, e = j + FR; j < e; j++) { const x = pcm[j] / 32768; s += x * x; }
    db[i] = 20 * Math.log10(Math.sqrt(s / FR) + 1e-9);
  }
  const sorted = Float32Array.from(db).sort();
  const q = p => sorted[Math.min(n - 1, Math.max(0, Math.floor(n * p)))];
  const floorDb = q(0.05), speechDb = q(0.95);
  let thr = thresholdDb;
  if (thr == null) thr = Math.max(-60, Math.min(-30, Math.min(floorDb + 0.55 * (speechDb - floorDb), speechDb - 20)));
  const raw = []; let i = 0;
  while (i < n) { if (db[i] > thr) { let j = i; while (j < n && db[j] > thr) j++; raw.push([i * 0.02, j * 0.02]); i = j; } else i++; }
  const merged = [];
  for (const b of raw) { if (merged.length && b[0] - merged[merged.length - 1][1] < minGapSec) merged[merged.length - 1][1] = b[1]; else merged.push([...b]); }
  const blocks = merged.filter(([a, b]) => b - a >= minBlockSec).map(([a, b], k) => {
    let peak = -120; for (let f = Math.floor(a / 0.02); f < Math.min(n, Math.ceil(b / 0.02)); f++) if (db[f] > peak) peak = db[f];
    return { i: k, a: r2(a), b: r2(b), dur: r2(b - a), peakDb: Math.round(peak) };
  });
  return { durationSec: r2(pcm.length / sr), floorDb: Math.round(floorDb), speechDb: Math.round(speechDb), thresholdDb: Math.round(thr), blocks };
}

// ---------- who is speaking: level per block ----------
// Shoots often have someone behind the camera dictating each line before the speaker says it.
// With a lavalier mic the dictated line is several dB quieter than the take. We report a level
// per block (90th percentile of 50 ms RMS frames) and three hints, all to be confirmed by
// looking at frames (a whispered line is quiet too):
//   quiet            block well below the main voice
//   repeatedLouderIn the same words come back louder a few seconds later (dictated → repeated)
//   parts            block that starts quiet and ends at full voice (dictation + immediate repeat)
// Measured on a real shoot: prompts −25…−35 dB, the speaker −16…−23 dB, own sentence tails
// a few dB lower — so we never split on a loud→quiet drop, only on quiet→loud.
const LV_STEP = 0.05;
function envelope(pcm, sr) {
  const FR = Math.round(LV_STEP * sr), n = Math.floor(pcm.length / FR), db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0; for (let j = i * FR, e = j + FR; j < e; j++) { const x = pcm[j] / 32768; s += x * x; }
    db[i] = 20 * Math.log10(Math.sqrt(s / FR) + 1e-9);
  }
  return db;
}
function levelDb(env, a, b) {
  const v = Array.from(env.subarray(Math.max(0, Math.floor(a / LV_STEP)), Math.min(env.length, Math.ceil(b / LV_STEP)))).sort((x, y) => x - y);
  return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.9))] : -120;
}
// a block that starts quiet and ends at full voice: cut at the pause (>= 150 ms, 10 dB under the block)
// where the quiet side (>= 1 s) is >= 6 dB under the loud side (>= 0.6 s, near the main voice)
function promptThenTake(env, a, b, mainVoiceDb) {
  const lvl = levelDb(env, a, b), f0 = Math.ceil(a / LV_STEP), f1 = Math.floor(b / LV_STEP);
  let best = null;
  for (let f = f0; f < f1; f++) {
    if (env[f] >= lvl - 10) continue;
    let g = f; while (g < f1 && env[g] < lvl - 10) g++;
    const cut = ((f + g) / 2) * LV_STEP;
    if (g - f >= 3 && cut - a >= 1 && b - cut >= 0.6) {
      const L = levelDb(env, a, cut), R = levelDb(env, cut, b);
      if (R - L >= 6 && R >= mainVoiceDb - 3 && (!best || R - L > best.R - best.L)) best = { cut, L, R };
    }
    f = g;
  }
  return best && [{ a: r2(a), b: r2(best.cut), levelDb: Math.round(best.L), quiet: true }, { a: r2(best.cut), b: r2(b), levelDb: Math.round(best.R) }];
}
export const QUIET_DB = 5;   // this far under the main voice = probably not the on-camera speaker
export function blockLevels(pcm, sr, blocks) {
  const env = envelope(pcm, sr);
  const withLvl = blocks.map(b => ({ ...b, levelDb: Math.round(levelDb(env, b.a, b.b)) }));
  // main voice = level reached by the loudest 15% of spoken time (the speaker is the loudest voice on a lavalier)
  const byLvl = [...withLvl].sort((x, y) => y.levelDb - x.levelDb);
  const total = byLvl.reduce((s, b) => s + (b.b - b.a), 0);
  let acc = 0, mainVoiceDb = byLvl.length ? byLvl[0].levelDb : null;
  for (const b of byLvl) { acc += b.b - b.a; mainVoiceDb = b.levelDb; if (acc >= 0.15 * total) break; }
  if (mainVoiceDb == null) return { mainVoiceDb, blocks: withLvl };
  return {
    mainVoiceDb,
    blocks: withLvl.map(b => {
      const parts = promptThenTake(env, b.a, b.b, mainVoiceDb);
      return { ...b, ...(b.levelDb <= mainVoiceDb - QUIET_DB ? { quiet: true } : {}), ...(parts ? { parts } : {}) };
    }),
  };
}

// the same line said again, louder, within a few seconds → the first one was probably dictated
const words = t => new Set(String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z]+/g, ' ').split(' ').filter(w => w.length >= 3));
function sameLine(x, y) {
  const A = words(x), B = words(y), m = Math.min(A.size, B.size);
  if (!m) return false;
  let c = 0; for (const w of A) if (B.has(w)) c++;
  return m === 1 ? A.size === 1 && B.size === 1 && c === 1 : c / m >= 0.6;
}
export function markRepeats(blocks, { windowSec = 15, minDiffDb = 3 } = {}) {
  return blocks.map((b, k) => {
    if (b.levelDb == null) return b;
    for (let j = k + 1; j < blocks.length && j <= k + 4 && blocks[j].a - b.b <= windowSec; j++) {
      const o = blocks[j];
      if (o.levelDb - b.levelDb >= minDiffDb && sameLine(b.text, o.text)) return { ...b, repeatedLouderIn: o.i };
    }
    return b;
  });
}

// ---------- Whisper transcription (per block) ----------
function wavHeader(samples, sr) {
  const h = Buffer.alloc(44), bytes = samples * 2;
  h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(bytes, 40);
  return h;
}
export function modelPath(name = MODEL_NAME) { return path.join(MODELS_DIR, MODELS[name].file); }
export function vadPath() { return path.join(MODELS_DIR, VAD.file); }
export function modelsReady(name = MODEL_NAME) { return exists(modelPath(name)) && exists(vadPath()); }

function parseWhisperJson(txt) {
  // the filter writes one JSON object per segment; be tolerant of separators
  const segs = [];
  for (const m of txt.matchAll(/\{[^{}]*\}/g)) { try { const o = JSON.parse(m[0]); if (o.text != null) segs.push(o); } catch {} }
  return segs;
}

export async function transcribe(job, file, { language = LANGUAGE, model = MODEL_NAME, thresholdDb, minGapSec, blocks } = {}) {
  need('ffmpeg');
  if (!hasWhisperFilter()) throw new Error('questo ffmpeg non ha il filtro whisper. Esegui capcut_setup con install:true per installare la build completa.');
  if (!MODELS[model]) throw new Error(`modello sconosciuto: ${model}. Disponibili: ${Object.keys(MODELS).join(', ')}`);
  if (!modelsReady(model)) throw new Error('modello Whisper non ancora scaricato. Esegui capcut_setup con install:true.');
  const st = fs.statSync(file);
  const key = crypto.createHash('md5').update(JSON.stringify([path.resolve(file), st.size, st.mtimeMs, model, language, thresholdDb, minGapSec, blocks])).digest('hex').slice(0, 12);
  const cachePath = path.join(mkdirp(TRANSCRIPTS_DIR), `${path.basename(file).replace(/[^\w.-]+/g, '_')}.${key}.json`);
  if (exists(cachePath)) {
    job.progress = 'trovata trascrizione già fatta';
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (cached.mainVoiceDb !== undefined || !cached.blocks || !cached.blocks.length) return cached;
    // transcript from before 0.3.0: add the per-block levels (a few seconds) and update the cache
    job.progress = 'misuro il volume dei blocchi';
    const { pcm, sr } = await decodePcm(file);
    const lv = blockLevels(pcm, sr, cached.blocks);
    const upd = { ...cached, mainVoiceDb: lv.mainVoiceDb, blocks: markRepeats(lv.blocks) };
    fs.writeFileSync(cachePath, JSON.stringify(upd));
    return upd;
  }

  job.progress = 'estraggo l\'audio';
  const { pcm, sr } = await decodePcm(file);
  const det = blocks && blocks.length
    ? { durationSec: r2(pcm.length / sr), blocks: blocks.map((b, i) => ({ i, a: r2(b.a), b: r2(b.b), dur: r2(b.b - b.a) })) }
    : speechBlocks(pcm, sr, { thresholdDb, minGapSec });
  if (!det.blocks.length) return { file, ...det, blocks: [], note: 'nessun parlato trovato: prova un thresholdDb più basso' };
  const lv = blockLevels(pcm, sr, det.blocks);

  // lay the blocks end to end with long silences between them, so the VAD inside the
  // whisper filter hands each block to Whisper on its own (no merging of repeated takes)
  const PAD = 0.15, GAP = 1.5, gapN = Math.round(GAP * sr);
  const parts = []; const map = []; let cursor = 0;
  for (const b of det.blocks) {
    const s0 = Math.max(0, Math.round((b.a - PAD) * sr)), s1 = Math.min(pcm.length, Math.round((b.b + PAD) * sr));
    map.push({ c0: cursor / sr, c1: (cursor + s1 - s0) / sr, src0: s0 / sr });
    parts.push(pcm.subarray(s0, s1), new Int16Array(gapN)); cursor += (s1 - s0) + gapN;
  }
  mkdirp(TMP_DIR);
  const id = crypto.randomUUID().slice(0, 8);
  const wav = path.join(TMP_DIR, `${id}.wav`), outJson = path.join(TMP_DIR, `${id}.json`);
  const fd = fs.openSync(wav, 'w');
  try { fs.writeSync(fd, wavHeader(cursor, sr)); for (const p of parts) fs.writeSync(fd, Buffer.from(p.buffer, p.byteOffset, p.byteLength)); }
  finally { fs.closeSync(fd); }

  const totalSec = cursor / sr;
  // whisper.cpp pads every block to a 30 s window, so cost is per block (~8-10 s each on a fast CPU)
  const guessMin = Math.max(1, Math.round(det.blocks.length * 10 / 60));
  job.progress = `trascrivo ${det.blocks.length} blocchi di parlato: stima ${guessMin} min o più su un PC lento`;
  // relative paths + cwd = APP_DIR: avoids escaping "C:\..." inside the filtergraph
  const rel = p => path.relative(APP_DIR, p).split(path.sep).join('/');
  const af = `whisper=model=${rel(modelPath(model))}:language=${language}:queue=20:vad_model=${rel(vadPath())}` +
    `:vad_min_silence_duration=0.6:vad_min_speech_duration=0.1:destination=${rel(outJson)}:format=json`;
  const t0 = Date.now();
  try {
    await run('ffmpeg', ['-hide_banner', '-nostats', '-progress', 'pipe:1', '-i', rel(wav), '-af', af, '-f', 'null', '-'], {
      cwd: APP_DIR,
      onStdout: d => {
        const m = /out_time_us=(\d+)/g; let x, last; while ((x = m.exec(d.toString()))) last = +x[1];
        if (!last) return;
        // ffmpeg reports audio fed into the filter, which runs ~20 s ahead of Whisper: estimate conservatively
        const f = Math.min(0.99, last / 1e6 / totalSec), el = (Date.now() - t0) / 1000;
        const total = Math.max(guessMin * 60, f > 0.25 ? el / f : 0);
        const left = Math.max(1, Math.round((total - el) / 60));
        job.progress = `trascrizione circa ${Math.round(Math.min(f, el / total) * 100)}% · ${Math.round(el / 60)} min trascorsi · ne mancano circa ${left}`;
      },
    });
    const segs = parseWhisperJson(fs.existsSync(outJson) ? fs.readFileSync(outJson, 'utf8') : '');
    // whisper timestamps are ms from the start of the concatenated stream: map back to blocks
    const texts = det.blocks.map(() => []);
    for (const s of segs) {
      const mid = ((+s.start || 0) + (+s.end || 0)) / 2000;
      let k = map.findIndex(m => mid >= m.c0 - 0.4 && mid <= m.c1 + 0.4);
      if (k < 0) k = map.reduce((best, m, j) => Math.abs((m.c0 + m.c1) / 2 - mid) < Math.abs((map[best].c0 + map[best].c1) / 2 - mid) ? j : best, 0);
      texts[k].push(String(s.text).trim());
    }
    const result = {
      file, language, model, durationSec: det.durationSec, thresholdDb: det.thresholdDb, floorDb: det.floorDb,
      mainVoiceDb: lv.mainVoiceDb, seconds: Math.round((Date.now() - t0) / 1000),
      blocks: markRepeats(lv.blocks.map((b, k) => ({ ...b, text: texts[k].join(' ').replace(/\s+/g, ' ').trim() }))),
    };
    fs.writeFileSync(cachePath, JSON.stringify(result));
    return result;
  } finally {
    for (const p of [wav, outJson]) try { fs.unlinkSync(p); } catch {}
  }
}

// ---------- downloads (e.g. Higgsfield results) ----------
const EXT_BY_TYPE = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/mp4': '.m4a' };
async function fetchToFile(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download fallito (${res.status}) da ${url.slice(0, 120)}`);
  const total = +res.headers.get('content-length') || 0;
  const tmp = dest + '.part'; const fd = fs.openSync(tmp, 'w'); let got = 0, last = 0;
  try {
    for await (const chunk of res.body) {
      fs.writeSync(fd, chunk); got += chunk.length;
      if (onProgress && Date.now() - last > 500) { last = Date.now(); onProgress(got, total); }
    }
  } finally { fs.closeSync(fd); }
  if (total && got !== total) { try { fs.unlinkSync(tmp); } catch {} throw new Error(`download incompleto (${got}/${total} byte)`); }
  fs.renameSync(tmp, dest);
  return { bytes: got, contentType: res.headers.get('content-type') || '' };
}
export async function download(job, url, { dir = MEDIA_DIR, filename } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error('serve un URL http(s)');
  mkdirp(dir);
  let name = filename || decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || `download-${Date.now()}`;
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').slice(0, 120);
  let dest = path.join(dir, name);
  const r = await fetchToFile(url, dest + '.dl', (g, t) => { job.progress = `scaricati ${(g / 1048576).toFixed(1)} MB${t ? ` di ${(t / 1048576).toFixed(1)}` : ''}`; });
  if (!path.extname(name)) { const ext = EXT_BY_TYPE[r.contentType.split(';')[0].trim()] || ''; dest += ext; }
  let final = dest, n = 1;
  while (fs.existsSync(final)) final = dest.replace(/(\.[^.]*)?$/, m => ` (${n++})${m}`);
  fs.renameSync(dest + '.dl', final);
  let info = null; try { info = await probe(final); } catch {}
  return { file: final, sizeMB: r2(r.bytes / 1048576), info };
}

// ---------- one-time setup ----------
function wingetExe() {
  const p = path.join(LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'winget.exe');
  return exists(p) ? p : 'winget';
}
export function setupStatus() {
  const ff = bin('ffmpeg', true), fp = bin('ffprobe', true);
  whisperOk = null;
  return {
    ffmpeg: ff, ffprobe: fp, ffmpegVersion: ffmpegVersion(), whisperFilter: ff ? hasWhisperFilter() : false,
    model: MODEL_NAME, modelFile: exists(modelPath()) ? modelPath() : null, vadFile: exists(vadPath()) ? vadPath() : null,
    mediaDir: MEDIA_DIR, appDir: APP_DIR,
  };
}
export async function setup(job, { model = MODEL_NAME } = {}) {
  const log = [];
  const say = s => { log.push(s); job.progress = s; };
  if (!bin('ffmpeg', true) || !bin('ffprobe', true) || !hasWhisperFilter()) {
    if (process.platform !== 'win32') throw new Error('installazione automatica disponibile solo su Windows. Su Mac: brew install ffmpeg (con whisper).');
    say('installo ffmpeg (Gyan.FFmpeg) con winget: può richiedere qualche minuto…');
    await new Promise((resolve, reject) => {
      const p = spawn(wingetExe(), ['install', '--id', 'Gyan.FFmpeg', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'], { windowsHide: true });
      let out = '';
      p.stdout.on('data', d => { out += d; const l = d.toString().trim().split(/\r|\n/).pop(); if (l) job.progress = `winget: ${l.slice(0, 120)}`; });
      p.stderr.on('data', d => { out += d; });
      p.on('error', e => reject(new Error(`winget non disponibile (${e.message}). Installa "App Installer" dal Microsoft Store, poi riprova.`)));
      p.on('close', code => (code === 0 || /already installed|già installat/i.test(out)) ? resolve() : reject(new Error(`winget ha restituito ${code}: ${out.trim().split('\n').slice(-3).join(' | ')}`)));
    });
    whisperOk = null;
    if (!bin('ffmpeg', true) || !bin('ffprobe', true)) throw new Error('ffmpeg installato ma non trovato: riavvia Claude Desktop e riprova.');
    say(`ffmpeg pronto: ${bin('ffmpeg')}`);
    if (!hasWhisperFilter()) say('attenzione: questo ffmpeg non ha il filtro whisper (trascrizione non disponibile).');
  } else say(`ffmpeg già presente: ${bin('ffmpeg')}`);

  mkdirp(MODELS_DIR);
  const want = [[vadPath(), VAD.url, 'VAD silero'], [modelPath(model), HF + MODELS[model].file, `Whisper ${model} (${MODELS[model].mb} MB)`]];
  for (const [dest, url, label] of want) {
    if (exists(dest)) { say(`${label} già scaricato`); continue; }
    say(`scarico ${label}…`);
    await fetchToFile(url, dest, (g, t) => { job.progress = `scarico ${label}: ${Math.round(g / 1048576)} / ${Math.round(t / 1048576)} MB`; });
    say(`${label} scaricato`);
  }
  mkdirp(MEDIA_DIR);
  return { done: true, steps: log, status: setupStatus() };
}

// ---------- generic ffmpeg (escape hatch: convert, cut, chroma, etc.) ----------
export async function ffmpegRaw(job, args) {
  if (!Array.isArray(args) || !args.length) throw new Error('args deve essere una lista di argomenti per ffmpeg');
  let durUs = 0;
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-y', '-progress', 'pipe:1', '-nostats', ...args], {
    onStderr: s => { const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(s); if (m && !durUs) durUs = ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1e6; },
    onStdout: d => { const m = /out_time_us=(\d+)/.exec(d.toString()); if (m) job.progress = durUs ? `${Math.min(99, Math.round(+m[1] / durUs * 100))}%` : `${Math.round(+m[1] / 1e6)} s elaborati`; },
  });
  return { ok: true, log: stderr.trim().split('\n').slice(-6).join('\n') };
}

// ---------- browsing (Claude Desktop has no file access of its own) ----------
const MEDIA_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mts|mp3|wav|m4a|aac|flac|ogg|png|jpe?g|webp|gif|heic)$/i;
export function listFiles(dir, { all = false, limit = 200 } = {}) {
  const roots = dir ? [dir] : [MEDIA_DIR, path.join(os.homedir(), 'Desktop'), path.join(os.homedir(), 'Videos'), path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Documents')];
  if (!dir) return { hint: 'cartelle comuni: passa una di queste come dir', folders: roots.filter(d => fs.existsSync(d)) };
  if (!fs.existsSync(dir)) throw new Error(`cartella non trovata: ${dir}`);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const folders = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);
  const files = entries.filter(e => e.isFile() && (all || MEDIA_EXT.test(e.name))).slice(0, limit).map(e => {
    const st = fs.statSync(path.join(dir, e.name));
    return { name: e.name, sizeMB: r2(st.size / 1048576), modified: st.mtime.toISOString().slice(0, 16).replace('T', ' ') };
  });
  return { dir: path.resolve(dir), folders, files };
}

// ---------- background jobs ----------
const jobs = new Map(); let seq = 0;
export function startJob(kind, fn) {
  const job = { id: `${kind}-${++seq}`, kind, status: 'in corso', progress: 'avvio', startedAt: Date.now(), result: null, error: null };
  job.promise = Promise.resolve().then(() => fn(job))
    .then(r => { job.status = 'finito'; job.result = r; job.progress = 'finito'; })
    .catch(e => { job.status = 'errore'; job.error = (e && e.message) || String(e); });
  jobs.set(job.id, job);
  return job;
}
export async function waitJob(id, waitSec = 25) {
  const job = jobs.get(id); if (!job) throw new Error(`job sconosciuto: ${id}`);
  await Promise.race([job.promise, new Promise(r => setTimeout(r, Math.max(0, Math.min(50, waitSec)) * 1000))]);
  const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
  if (job.status === 'finito') return { jobId: id, status: job.status, elapsedSec: elapsed, result: job.result };
  if (job.status === 'errore') return { jobId: id, status: job.status, elapsedSec: elapsed, error: job.error };
  return { jobId: id, status: job.status, elapsedSec: elapsed, progress: job.progress, next: `richiama capcut_job_status con jobId "${id}"` };
}
export function listJobs() { return [...jobs.values()].map(j => ({ jobId: j.id, status: j.status, progress: j.progress })); }
