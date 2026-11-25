#!/usr/bin/env node
// capcut-mcp: MCP stdio server exposing CapCut draft-editing tools.
// Editing tools accumulate in an in-memory session (open -> edit -> edit -> save);
// nothing touches disk until capcut_save. All times are in SECONDS at the tool boundary.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'path';
import { CapCutDraft, cloneDraft, listDrafts, listBackups, restoreBackup, styleLibrary, capcutRunning, DRAFTS_DIR, STYLE_KINDS } from './core.js';
import * as media from './media.js';

const VERSION = '0.3.0';
const US = 1e6;
const open = new Map();                       // name -> live CapCutDraft (unsaved edits)
const get = name => { if (!open.has(name)) open.set(name, new CapCutDraft(name)); return open.get(name); };
const ok = obj => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const err = e => ({ content: [{ type: 'text', text: 'ERRORE: ' + ((e && e.message) || e) }], isError: true });
const wrap = fn => async (a) => { try { const r = await fn(a); return r && r.content ? r : ok(r); } catch (e) { return err(e); } };
const sec = v => v == null ? undefined : Math.round(v * US);

const INSTRUCTIONS = `
Strumenti per montare bozze di CapCut desktop. Parla con l'utente in italiano, in modo semplice: spesso non Ã¨ un tecnico.

REGOLE
- Le modifiche (add/move/trim/split/delete/rough_cut/set_props) restano in memoria finchÃ© non chiami capcut_save. Prima di salvare chiedi all'utente di CHIUDERE CapCut del tutto: se Ã¨ aperto, l'autosalvataggio di CapCut cancella le modifiche. capcut_save rifiuta se CapCut Ã¨ aperto; non usare force senza conferma esplicita.
- Ogni salvataggio crea un backup. Per tornare indietro: capcut_list_backups e capcut_restore_backup.
- Tutti i tempi sono in secondi. Non hai accesso ai file del PC: usa capcut_list_files per trovare cartelle e video, e capcut_view_frames per guardare i fotogrammi.
- Se uno strumento dice che mancano ffmpeg o il modello Whisper, esegui capcut_setup con install:true (solo la prima volta; scarica circa 600 MB).
- Lavori lunghi (setup, trascrizione, download, ffmpeg) partono in background e restituiscono un jobId: controlla con capcut_job_status. Se manca piÃ¹ di qualche minuto, di' all'utente quanto manca e invitalo a riscriverti piÃ¹ tardi invece di controllare di continuo.

PREMONTAGGIO (togliere silenzi e frasi sbagliate da un girato parlato)
1. capcut_read_timeline sulla bozza: trova la traccia video principale e i file del girato (campo path).
2. capcut_transcribe su ogni file: dÃ  i "blocchi" di parlato con inizio/fine (secondi nel file originale), volume in dB e testo. Ogni blocco Ã¨ trascritto da solo, quindi le prese ripetute restano separate.
3. Scegli i blocchi da tenere: tieni TUTTE le prese complete di ogni frase, anche se ripetute piÃ¹ volte (sceglierÃ  l'utente). Togli solo silenzi, partenze interrotte o frasi lasciate a metÃ , rumori e commenti fuori copione. Blocchi brevissimi con testi tipo "Grazie a tutti", "Sottotitoli...", "[Musica]" sono allucinazioni di Whisper, non parlato. Se una presa completa Ã¨ dubbia, tienila e segnalala.
   SUGGERIMENTI: spesso qualcuno dietro la camera detta la frase e chi Ã¨ inquadrato la ripete. La frase dettata NON Ã¨ una presa: toglila e tieni solo quella detta da chi Ã¨ in video. Indizi: la stessa frase due volte di seguito, la prima piÃ¹ bassa (â–½ basso, â†» ripetuto piÃ¹ forte), oppure un blocco che inizia basso e finisce a voce piena (â†³: tieni solo la parte forte). Conferma SEMPRE con capcut_view_frames dentro il blocco: se la persona inquadrata Ã¨ ferma con la bocca chiusa sta ascoltando (suggerimento); se parla e gesticola Ã¨ una presa. Una frase sussurrata apposta (mano vicino alla bocca) Ã¨ bassa ma Ã¨ una presa. Se in un blocco lungo le stesse parole compaiono due volte, guarda i fotogrammi in piÃ¹ punti.
4. capcut_rough_cut con le parti da tenere in ordine cronologico: ogni parte diventa un segmento separato sulla traccia principale. Le altre tracce (titoli, musica) non vengono spostate: dillo all'utente.
5. capcut_validate, poi chiedi di chiudere CapCut e capcut_save. Riassumi: durata prima/dopo, numero di prese per frase, prese dubbie, quanti suggerimenti da dietro la camera hai tolto.

GRAFICHE, MOTION E B-ROLL
- Le animazioni generate con altri connettori (es. Higgsfield) arrivano come URL: scaricale con capcut_download, poi mettile su una traccia sopra il video con capcut_add_video (volume 0 se non serve l'audio). Se il file non ha trasparenza (hasAlpha false) e deve stare sopra il video, avvisa l'utente.
- Transizioni, animazioni ed effetti di CapCut: non puoi inventarli, ma puoi copiarli da un clip che li ha giÃ . Usa capcut_style_library per vedere quelli giÃ  usati nelle bozze e capcut_apply_style per applicarli.
- Testi: capcut_add_text copia lo stile da un testo giÃ  esistente nelle bozze.
`.trim();

const s = new McpServer({ name: 'capcut', version: VERSION }, { instructions: INSTRUCTIONS });
const RO = { readOnlyHint: true, openWorldHint: false };
const tool = (name, description, inputSchema, handler, annotations = {}) =>
  s.registerTool(name, { description, inputSchema, annotations }, wrap(handler));

// run a background job, wait a little, return result or a jobId to poll
async function job(kind, fn, waitSec = 20) {
  const j = media.startJob(kind, fn);
  return media.waitJob(j.id, waitSec);
}

// ---------------- setup & jobs ----------------
tool('capcut_setup', 'Controlla cosa serve (ffmpeg, modello Whisper, cartella bozze). Con install:true installa ffmpeg (winget) e scarica il modello Whisper (~600 MB) in background: da fare una volta sola.',
  { install: z.boolean().optional(), model: z.enum(Object.keys(media.MODELS)).optional().describe('modello Whisper (default large-v3-turbo-q5_0)') },
  async ({ install, model }) => {
    const status = { ...media.setupStatus(), draftsDir: DRAFTS_DIR, drafts: listDrafts().length, capcutRunning: capcutRunning(), version: VERSION };
    const ready = status.ffmpeg && status.ffprobe && status.whisperFilter && status.modelFile && status.vadFile;
    if (!install) return { ready: !!ready, ...status, models: media.MODELS, hint: ready ? 'tutto pronto' : 'esegui di nuovo con install:true' };
    return job('setup', j => media.setup(j, { model: model || media.MODEL_NAME }), 25);
  });

tool('capcut_job_status', 'Stato di un lavoro in background (setup, trascrizione, download, ffmpeg). Attende fino a waitSec secondi (max 50) che finisca.',
  { jobId: z.string(), waitSec: z.number().optional() },
  async ({ jobId, waitSec }) => {
    const r = await media.waitJob(jobId, waitSec == null ? 40 : waitSec);
    if (r.status === 'finito' && r.result && r.result.blocks && r.result.language) return formatTranscript(r.result);
    return r;
  }, RO);

// ---------------- drafts ----------------
tool('capcut_list_drafts', 'Elenca le bozze di CapCut (dalla piÃ¹ recente), con durata e se sono aperte.', {},
  async () => ({ draftsDir: DRAFTS_DIR, capcutRunning: capcutRunning(), drafts: listDrafts() }), RO);

tool('capcut_read_timeline', 'Legge una bozza: formato, fps, tracce e ogni segmento (id, file, tempi, testo, stili). Mostra anche le modifiche non ancora salvate.',
  { draft: z.string() },
  async ({ draft }) => { const d = open.get(draft) || new CapCutDraft(draft); return { ...d.timeline(), unsavedEdits: open.has(draft) }; }, RO);

tool('capcut_clone_draft', 'Duplica una bozza con un nuovo nome (e la registra in CapCut). empty:true la svuota per partire da zero con lo stesso formato. Richiede CapCut chiuso.',
  { base: z.string(), newName: z.string(), empty: z.boolean().optional() },
  async ({ base, newName, empty }) => cloneDraft(base, newName, { empty: !!empty }));

// ---------------- media placement ----------------
const placeOpts = {
  atSec: z.number().describe('inizio sulla timeline, secondi'),
  durSec: z.number().optional().describe('durata (default: tutto il file; immagini 5 s)'),
  srcStartSec: z.number().optional().describe('punto di ingresso dentro il file, secondi'),
  trackIndex: z.number().int().optional().describe('traccia di destinazione; se omessa usa una traccia libera sopra il video principale o ne crea una'),
  trackRenderIndex: z.number().int().optional().describe('ordine dei livelli; piÃ¹ alto = sopra'),
  scale: z.number().optional(), posX: z.number().optional().describe('-1..1 circa, 0 = centro'), posY: z.number().optional(),
  rotation: z.number().optional(), opacity: z.number().optional(), volume: z.number().optional().describe('0 = muto, 1 = normale'), speed: z.number().optional(),
};
const optsFrom = a => ({ atUs: sec(a.atSec), durUs: sec(a.durSec), srcStartUs: sec(a.srcStartSec),
  trackIndex: a.trackIndex, trackRenderIndex: a.trackRenderIndex, scale: a.scale, posX: a.posX, posY: a.posY,
  rotation: a.rotation, opacity: a.opacity, volume: a.volume, speed: a.speed });

tool('capcut_add_video', 'Aggiunge un video (o immagine) alla bozza in un punto della timeline. Modifica in memoria: poi capcut_save.',
  { draft: z.string(), file: z.string().describe('percorso completo del file'), ...placeOpts },
  async (a) => get(a.draft).addVideo(a.file, optsFrom(a)));
tool('capcut_add_image', 'Aggiunge un\'immagine (png/jpg) alla bozza.', { draft: z.string(), file: z.string(), ...placeOpts },
  async (a) => get(a.draft).addImage(a.file, optsFrom(a)));
tool('capcut_add_audio', 'Aggiunge un audio (musica, effetto, voce) alla bozza.', { draft: z.string(), file: z.string(), ...placeOpts },
  async (a) => get(a.draft).addAudio(a.file, optsFrom(a)));

tool('capcut_add_text', 'Aggiunge un testo. Lo stile (font, contorno, animazione) Ã¨ copiato da un testo giÃ  presente in questa bozza o in un\'altra.',
  { draft: z.string(), text: z.string(), atSec: z.number(), durSec: z.number().optional(),
    fontSize: z.number().optional(), color: z.string().optional().describe('esadecimale, es. #ffffff'),
    posX: z.number().optional(), posY: z.number().optional(), scale: z.number().optional(), trackIndex: z.number().int().optional() },
  async (a) => get(a.draft).addText(a.text, { atUs: sec(a.atSec), durUs: sec(a.durSec), fontSize: a.fontSize, color: a.color, posX: a.posX, posY: a.posY, scale: a.scale, trackIndex: a.trackIndex }));

tool('capcut_add_track', 'Aggiunge una traccia vuota (video | audio | text | sticker).',
  { draft: z.string(), type: z.enum(['video', 'audio', 'text', 'sticker']).optional(), name: z.string().optional() },
  async ({ draft, type, name }) => ({ trackIndex: get(draft).addTrack(type || 'video', name) }));

// ---------------- editing ----------------
tool('capcut_move_segment', 'Sposta un segmento a un nuovo inizio ed eventualmente su un\'altra traccia.',
  { draft: z.string(), segmentId: z.string(), atSec: z.number(), trackIndex: z.number().int().optional() },
  async ({ draft, segmentId, atSec, trackIndex }) => get(draft).moveSegment(segmentId, sec(atSec), trackIndex));

tool('capcut_trim_segment', 'Cambia inizio / durata / punto di ingresso nel file di un segmento (secondi).',
  { draft: z.string(), segmentId: z.string(), atSec: z.number().optional(), durSec: z.number().optional(), srcStartSec: z.number().optional() },
  async ({ draft, segmentId, atSec, durSec, srcStartSec }) => get(draft).trimSegment(segmentId, { atUs: sec(atSec), durUs: sec(durSec), srcStartUs: sec(srcStartSec) }));

tool('capcut_split_segment', 'Taglia un segmento in due in un punto della timeline (secondi).',
  { draft: z.string(), segmentId: z.string(), atSec: z.number() },
  async ({ draft, segmentId, atSec }) => get(draft).splitSegment(segmentId, sec(atSec)));

tool('capcut_delete_segment', 'Elimina un segmento.',
  { draft: z.string(), segmentId: z.string() }, async ({ draft, segmentId }) => get(draft).deleteSegment(segmentId));

tool('capcut_set_props', 'Imposta posizione / scala / rotazione / opacitÃ  / volume / velocitÃ  / visibilitÃ  di un segmento.',
  { draft: z.string(), segmentId: z.string(), scale: z.number().optional(), scaleX: z.number().optional(), scaleY: z.number().optional(),
    posX: z.number().optional(), posY: z.number().optional(), rotation: z.number().optional(), opacity: z.number().optional(),
    volume: z.number().optional(), speed: z.number().optional(), visible: z.boolean().optional() },
  async (a) => get(a.draft).setProps(a.segmentId, a));

tool('capcut_rough_cut', 'PREMONTAGGIO: ricostruisce la traccia video principale tenendo solo le parti indicate (tempi nel file sorgente, in ordine finale), una dopo l\'altra. Ogni parte diventa un segmento separato. Usa i blocchi di capcut_transcribe.',
  { draft: z.string(),
    keeps: z.array(z.object({
      file: z.string().optional().describe('file sorgente (percorso o nome, es. IMG_3286.MOV)'),
      segmentId: z.string().optional().describe('in alternativa a file: id del segmento originale'),
      startSec: z.number(), endSec: z.number(), note: z.string().optional(),
    })).min(1),
    trackIndex: z.number().int().optional().describe('default: la prima traccia video'),
    padSec: z.number().optional().describe('margine aggiunto prima/dopo ogni parte (default 0.08 s)') },
  async ({ draft, keeps, trackIndex, padSec }) => get(draft).roughCut(keeps, { trackIndex, padSec }));

tool('capcut_style_library', 'Elenca transizioni, animazioni ed effetti giÃ  usati in tutte le bozze, con il clip da cui copiarli (per capcut_apply_style).', {},
  async () => ({ styles: styleLibrary() }), RO);

tool('capcut_apply_style', 'Copia transizioni / animazioni / effetti da un clip che li ha giÃ  (anche di un\'altra bozza) su uno o piÃ¹ segmenti.',
  { draft: z.string(), segmentIds: z.array(z.string()).min(1), fromDraft: z.string().optional(), fromSegmentId: z.string(),
    kinds: z.array(z.enum(STYLE_KINDS)).optional().describe('default: tutti quelli presenti sul clip di origine') },
  async ({ draft, segmentIds, fromDraft, fromSegmentId, kinds }) => get(draft).applyStyle(segmentIds, { fromDraft: fromDraft || draft, fromSegmentId, kinds }));

tool('capcut_raw_patch', 'Avanzato: unisce una patch JSON dentro draft_content (operazioni non documentate). Usare con cautela.',
  { draft: z.string(), patch: z.record(z.string(), z.any()) }, async ({ draft, patch }) => get(draft).rawPatch(patch));

tool('capcut_validate', 'Controlla la bozza (anche le modifiche non salvate): sovrapposizioni, id duplicati, file mancanti.',
  { draft: z.string() }, async ({ draft }) => get(draft).validate(), RO);

tool('capcut_save', 'Scrive le modifiche su disco (con backup automatico e aggiornando anche la copia in Timelines). Rifiuta se CapCut Ã¨ aperto.',
  { draft: z.string(), note: z.string().optional().describe('promemoria salvato col backup'), force: z.boolean().optional() },
  async ({ draft, force, note }) => {
    if (!open.has(draft)) return { saved: false, message: 'nessuna modifica in sospeso per questa bozza' };
    const r = get(draft).save({ force: !!force, reason: note || '' }); open.delete(draft); return r;
  });

tool('capcut_discard', 'Annulla le modifiche non salvate e ricarica la bozza dal disco.',
  { draft: z.string() }, async ({ draft }) => { const had = open.delete(draft); return { discarded: draft, hadUnsavedEdits: had }; });

tool('capcut_list_backups', 'Elenca i backup di una bozza (uno per ogni salvataggio).',
  { draft: z.string() }, async ({ draft }) => listBackups(draft), RO);

tool('capcut_restore_backup', 'Riporta una bozza a un backup (prima salva un backup dello stato attuale). Richiede CapCut chiuso.',
  { draft: z.string(), backupId: z.string(), force: z.boolean().optional() },
  async ({ draft, backupId, force }) => { open.delete(draft); return restoreBackup(draft, backupId, { force: !!force }); });

// ---------------- media ----------------
tool('capcut_list_files', 'Sfoglia le cartelle del PC per trovare video, audio e immagini. Senza dir mostra le cartelle principali.',
  { dir: z.string().optional(), all: z.boolean().optional().describe('mostra anche i file non multimediali') },
  async ({ dir, all }) => media.listFiles(dir, { all: !!all }), RO);

tool('capcut_probe_media', 'Informazioni su un file: durata, risoluzione (come si vede), fps, audio, trasparenza.',
  { file: z.string() }, async ({ file }) => media.probe(file), RO);

tool('capcut_view_frames', 'Mostra fotogrammi come immagini, per guardare il video. Da un file (file + times nel file) oppure da una bozza (draft + times sulla timeline: usa il video visibile in quel punto).',
  { file: z.string().optional(), draft: z.string().optional(), times: z.array(z.number()).min(1).max(8).describe('secondi') },
  async ({ file, draft, times }) => {
    const shots = [];
    if (file) for (const t of times) shots.push({ file, t, label: `${path.basename(file)} @ ${t}s` });
    else if (draft) {
      const d = open.get(draft) || new CapCutDraft(draft);
      for (const t of times) {
        const at = t * US; let best = null;
        for (const tr of d.content.tracks) if (tr.type === 'video') for (const sg of tr.segments || []) {
          if (sg.visible === false || at < sg.target_timerange.start || at >= sg.target_timerange.start + sg.target_timerange.duration) continue;
          const p = d._matPath(sg); if (!p) continue;
          if (!best || (sg.render_index || 0) > (best.sg.render_index || 0)) best = { sg, p };
        }
        if (best) shots.push({ file: best.p, t: ((best.sg.source_timerange?.start || 0) + (at - best.sg.target_timerange.start) * (best.sg.speed || 1)) / US, label: `timeline ${t}s â†’ ${path.basename(best.p)}` });
      }
    } else throw new Error('serve file oppure draft');
    const content = [];
    for (const sh of shots) {
      const [f] = await media.frames(sh.file, [sh.t]);
      content.push({ type: 'text', text: sh.label });
      if (f) content.push({ type: 'image', data: f.data, mimeType: 'image/jpeg' });
    }
    if (!content.length) content.push({ type: 'text', text: 'nessun fotogramma trovato in quei punti' });
    return { content };
  }, RO);

function formatTranscript(r) {
  const fmt = x => { const m = Math.floor(x / 60); return `${m}:${(x - m * 60).toFixed(2).padStart(5, '0')}`; };
  const lvl = r.mainVoiceDb != null;
  const lines = r.blocks.map(b => {
    const marks = [b.quiet && 'â–½ basso', b.repeatedLouderIn != null && `â†» ripetuto piÃ¹ forte in #${b.repeatedLouderIn}`].filter(Boolean).join(' ');
    const head = `#${b.i} [${b.a.toFixed(2)}â€“${b.b.toFixed(2)}] (${fmt(b.a)})${b.levelDb != null ? ` ${b.levelDb}dB` : ''}${marks ? ' ' + marks : ''}`;
    const parts = b.parts ? `\n     â†³ inizia basso e finisce a voce piena: ${b.parts.map(p => `${p.a.toFixed(2)}â€“${p.b.toFixed(2)} ${p.levelDb}dB${p.quiet ? ' â–½' : ''}`).join(' | ')}` : '';
    return `${head} ${b.text || '(vuoto)'}${parts}`;
  });
  const legend = lvl
    ? `voce principale ${r.mainVoiceDb} dB. â–½ = almeno ${media.QUIET_DB} dB piÃ¹ bassa Â· â†» = stesse parole ripetute piÃ¹ forte poco dopo Â· â†³ = blocco diviso per volume.\n` +
      `Sono indizi di una frase SUGGERITA da dietro la camera (o sussurrata apposta): prima di decidere guarda i fotogrammi con capcut_view_frames.\n`
    : '';
  return `TRASCRIZIONE PER BLOCCHI â€” file: ${r.file}\ndurata ${fmt(r.durationSec)}, ${r.blocks.length} blocchi, soglia ${r.thresholdDb} dB, modello ${r.model}, ${r.seconds ?? 0} s\n` +
    legend + `Tempi in secondi nel file originale: usali cosÃ¬ in capcut_rough_cut (file + startSec/endSec).\n\n${lines.join('\n')}`;
}

tool('capcut_transcribe', 'Trascrive un video/audio a blocchi di parlato (Whisper, sul PC, offline). Ogni blocco ha inizio/fine nel file, volume e testo: le prese ripetute restano separate e le frasi probabilmente suggerite da dietro la camera sono segnalate. Lavoro lungo: restituisce un jobId se non finisce subito.',
  { file: z.string(), language: z.string().optional().describe('default it'), thresholdDb: z.number().optional().describe('soglia del parlato in dB (default automatica)'),
    model: z.enum(Object.keys(media.MODELS)).optional() },
  async ({ file, language, thresholdDb, model }) => {
    const r = await job('transcribe', j => media.transcribe(j, file, { language, thresholdDb, model }), 15);
    if (r.status === 'finito') return formatTranscript(r.result);
    return { ...r, hint: 'circa 8-15 secondi di lavoro per ogni frase detta: controlla con capcut_job_status' };
  });

tool('capcut_download', 'Scarica un file da un URL (es. un video o un\'immagine generati con Higgsfield) nella cartella media, per poi metterlo nella bozza.',
  { url: z.string(), folder: z.string().optional().describe(`default: ${media.MEDIA_DIR}`), filename: z.string().optional() },
  async ({ url, folder, filename }) => job('download', j => media.download(j, url, { dir: folder || media.MEDIA_DIR, filename }), 25));

tool('capcut_ffmpeg', 'Avanzato: esegue ffmpeg con gli argomenti dati (senza "ffmpeg" iniziale), es. per convertire, tagliare, togliere uno sfondo verde. Gira in background.',
  { args: z.array(z.string()).min(1) },
  async ({ args }) => job('ffmpeg', j => media.ffmpegRaw(j, args), 25));

const transport = new StdioServerTransport();
await s.connect(transport);
process.stderr.write(`[capcut-mcp ${VERSION}] pronto. bozze: ${DRAFTS_DIR}\n`);
