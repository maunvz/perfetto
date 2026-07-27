// XR composition-trace plugin.
//
// Step 1 of T279000813 ("System-wide Composition Trace"): make the XR composition
// pipeline (SpaceManager writes from aether/SystemShell, and the XR compositor's
// AperturePose/LayerState stages) legible in the Perfetto UI.
//
// It does two things on load, and is inert on traces without our events:
//   1. Adds an "XR pipeline" track group: one lane per (event/stage), each lane's
//      slices named by the entity (aperture/window/token) they touched, so you can
//      see at a glance when a stage stops emitting (e.g. an app that stops
//      submitting its projection layers, or a compositor that pauses at screen-off).
//   2. Registers an "XR Pose" tab that decodes the pos/quat of whichever
//      SpaceManager/AperturePose/LayerState event is selected.
//
// Each lane is a SliceTrack whose dataset `id` is the ORIGINAL `slice.id`, so
// selecting a lane slice yields that slice id and the "XR Pose" tab can look it up
// and decode it. (An earlier version used addDebugSliceTrack, whose pivoted tracks
// materialize a copy with a synthetic row-number id — selecting them produced ids
// that don't exist in `slice`, so the tab showed nothing.)
//
// The SQL here mirrors ../sql/xr_pipeline/stages.sql (the canonical definitions);
// keep them in sync. Facts reused from the linux_mirror sample plugin: instant
// TRACE_EVENTs land in `slice` with dur=0, debug annotations are `args` rows keyed
// 'debug.<name>' (read with extract_arg), and uint64 apertureLow is shown as hex.

import m from 'mithril';
import type {Trace} from '../../public/trace';
import type {PerfettoPlugin} from '../../public/plugin';
import type {Tab} from '../../public/tab';
import {NUM, LONG, STR, STR_NULL, NUM_NULL} from '../../trace_processor/query_result';
import {SliceTrack} from '../../components/tracks/slice_track';
import {SourceDataset} from '../../trace_processor/dataset';
import {TrackNode} from '../../public/workspace';
import {Pose3DTab} from './pose3d';

const XR_EVENTS = "('SpaceManagerWrite','AperturePose','LayerState')";

// COALESCE(stage, poseSource, '') — the sub-stage label used for lanes.
const SUB_EXPR =
  "COALESCE(extract_arg(s.arg_set_id,'debug.stage')," +
  "extract_arg(s.arg_set_id,'debug.poseSource'),'')";

export default class XrCompositionTracePlugin implements PerfettoPlugin {
  static readonly id = 'dev.xrpipeline.CompositionTrace';

  async onTraceLoad(trace: Trace): Promise<void> {
    // Only activate on traces that carry our instrumentation.
    const check = await trace.engine.query(`
      SELECT COUNT(*) AS cnt FROM slice WHERE name IN ${XR_EVENTS} AND dur = 0
    `);
    if (check.firstRow({cnt: NUM}).cnt === 0) return;

    // Materialize the pipeline slices ONCE. extract_arg() is a per-row args lookup;
    // computing it here (one pass) + indexing by lane turns each lane track into a
    // cheap indexed read instead of re-scanning args on every render/zoom. `id` is
    // the original slice.id so selections still resolve in the XR Pose tab.
    await ensureTable(trace);
    // If this trace was augmented by xrbundle, build xr_entity_meta from the embedded
    // XrEntityMeta events so the XR Pose tab enriches (pkg / full UUID) with no clicks.
    await ensureMetaFromEmbedded(trace);

    const lanes = await trace.engine.query(
      `SELECT DISTINCT lane FROM xr_pipeline_slices ORDER BY lane`);

    const group = new TrackNode({name: 'XR pipeline', isSummary: true});
    trace.defaultWorkspace.addChildInOrder(group);

    for (const it = lanes.iter({lane: STR}); it.valid(); it.next()) {
      const lane = it.lane;
      const uri = `dev.xrpipeline.CompositionTrace#${lane}`;
      const laneLit = lane.replace(/'/g, "''");
      const src =
        `SELECT id, ts, dur, name FROM xr_pipeline_slices WHERE lane = '${laneLit}'`;
      trace.tracks.registerTrack({
        uri,
        renderer: SliceTrack.create({
          trace,
          uri,
          dataset: new SourceDataset({
            src,
            schema: {id: NUM, ts: LONG, dur: LONG, name: STR},
          }),
        }),
      });
      group.addChildInOrder(new TrackNode({uri, name: lane}));
    }

    // XR Pose (decode) — a per-selection view, so it belongs in the bottom drawer.
    const tabUri = 'dev.xrpipeline.CompositionTrace#Pose';
    poseTab = new XrPoseTab(trace);
    trace.tabs.registerTab({uri: tabUri, content: poseTab});
    trace.tabs.showTab(tabUri);

    // XR Pose 3D — a persistent spatial view. It lives in the RIGHT SIDE PANEL, not
    // the bottom drawer: the drawer is stolen by 'Current Selection' on every click,
    // whereas the side panel stays open. Hover the timeline for a snapshot;
    // area-select a range for a trail over time.
    const pose3dUri = 'dev.xrpipeline.CompositionTrace#Pose3D';
    const pose3d = new Pose3DTab(trace);
    trace.sidePanel.registerTab({
      uri: pose3dUri,
      title: 'XR Pose 3D',
      icon: 'view_in_ar',
      render: () => pose3d.render(),
    });
    trace.sidePanel.showTab(pose3dUri);

    // Plugin tabs/panels aren't in Perfetto's add-tab menu, so register '>' palette
    // commands to (re)open them if closed.
    trace.commands.registerCommand({
      id: 'dev.xrpipeline.CompositionTrace#openPose',
      name: 'XR pipeline: open XR Pose tab',
      callback: () => trace.tabs.showTab(tabUri),
    });
    trace.commands.registerCommand({
      id: 'dev.xrpipeline.CompositionTrace#openPose3D',
      name: 'XR pipeline: open XR Pose 3D panel',
      callback: () => trace.sidePanel.showTab(pose3dUri),
    });

    // Optional: load dump-derived entity metadata (package name + full UUID +
    // token->window) so the XR Pose tab resolves apertureLow beyond the low 64 bits.
    // The dumps aren't in the trace, so the user picks a file; feed it the JSON
    // from `xr-window-correlate/correlate.py --dir <dumps> --json`.
    trace.commands.registerCommand({
      id: 'dev.xrpipeline.CompositionTrace#loadMeta',
      name: 'XR pipeline: load entity metadata (correlate --json)',
      callback: () => pickAndLoadMeta(trace),
    });
  }
}

// The live XR Pose tab, so loadMeta can invalidate its cache after enrichment.
let poseTab: XrPoseTab | undefined;

interface PoseRow {
  ename: string;
  stage: string | null;
  src: string | null;
  entity: string | null;
  frame: number | null;
  px: number | null; py: number | null; pz: number | null;
  qx: number | null; qy: number | null; qz: number | null; qw: number | null;
  pkg: string | null;        // from loaded dump metadata (else null)
  full_uuid: string | null;  // from loaded dump metadata (else null)
}

class XrPoseTab implements Tab {
  private lastEventId: number | null = null;
  private row: PoseRow | null = null;
  private loading = false;

  constructor(private readonly trace: Trace) {}

  getTitle(): string {
    return 'XR Pose';
  }

  render(): m.Children {
    const sel = this.trace.selection.selection;
    if (sel.kind !== 'track_event') {
      return note('Select a SpaceManagerWrite / AperturePose / LayerState event ' +
                  '(e.g. from the "XR pipeline" lanes) to decode its pose.');
    }
    if (sel.eventId !== this.lastEventId) {
      this.lastEventId = sel.eventId;
      this.row = null;
      this.load(sel.eventId);
    }
    if (this.loading) return note('Loading…');
    if (this.row === null) return note('Selected event is not an XR pipeline event.');

    const r = this.row;
    const kv = (k: string, v: unknown) =>
      m('tr', {style: 'border-bottom:1px solid #222'},
        m('td', {style: 'padding:3px 10px; color:#888'}, k),
        m('td', {style: 'padding:3px 10px'}, `${v}`));
    const f = (v: number | null) => (v === null ? '—' : v.toFixed(6));
    return m('div', {style: 'padding:12px; font-family:monospace; font-size:12px'},
      m('div', {style: 'font-weight:bold; margin-bottom:8px; font-size:13px'},
        `${r.ename}${r.stage ? ' / ' + r.stage : ''}` +
        `${r.src ? ' (' + r.src + ')' : ''}`),
      m('table', {style: 'border-collapse:collapse'},
        kv('entity (apertureLow)', r.entity ?? '—'),
        r.full_uuid ? kv('full uuid', r.full_uuid) : null,
        r.pkg ? kv('package', r.pkg) : null,
        r.frame !== null ? kv('frame', r.frame) : null,
        kv('pos (x,y,z)', `${f(r.px)}, ${f(r.py)}, ${f(r.pz)}`),
        kv('quat (x,y,z,w)', `${f(r.qx)}, ${f(r.qy)}, ${f(r.qz)}, ${f(r.qw)}`)));
  }

  // Force a re-query on next render (e.g. after entity metadata is loaded).
  invalidate(): void {
    this.lastEventId = null;
    m.redraw();
  }

  private async load(eventId: number): Promise<void> {
    this.loading = true;
    // Try enriched (joins xr_entity_meta for pkg/full UUID); if that table isn't
    // loaded the query throws, so fall back to the plain decode.
    try {
      this.row = await this.queryPose(eventId, true)
        .catch(() => this.queryPose(eventId, false));
    } catch {
      this.row = null;
    } finally {
      this.loading = false;
      m.redraw();
    }
  }

  private async queryPose(eventId: number, enriched: boolean): Promise<PoseRow | null> {
    const apLow = `printf('0x%x', extract_arg(s.arg_set_id,'debug.apertureLow'))`;
    const metaCols = enriched
      ? `,
          (SELECT pkg FROM xr_entity_meta WHERE entity_hex = ${apLow}) AS pkg,
          (SELECT full_uuid FROM xr_entity_meta WHERE entity_hex = ${apLow}) AS full_uuid`
      : `, NULL AS pkg, NULL AS full_uuid`;
    const res = await this.trace.engine.query(`
      SELECT
        s.name AS ename,
        extract_arg(s.arg_set_id, 'debug.stage') AS stage,
        extract_arg(s.arg_set_id, 'debug.poseSource') AS src,
        ${apLow} AS entity,
        extract_arg(s.arg_set_id, 'debug.frame') AS frame,
        COALESCE(extract_arg(s.arg_set_id,'debug.posX'), extract_arg(s.arg_set_id,'debug.apPosX')) AS px,
        COALESCE(extract_arg(s.arg_set_id,'debug.posY'), extract_arg(s.arg_set_id,'debug.apPosY')) AS py,
        COALESCE(extract_arg(s.arg_set_id,'debug.posZ'), extract_arg(s.arg_set_id,'debug.apPosZ')) AS pz,
        COALESCE(extract_arg(s.arg_set_id,'debug.quatX'), extract_arg(s.arg_set_id,'debug.apQuatX')) AS qx,
        COALESCE(extract_arg(s.arg_set_id,'debug.quatY'), extract_arg(s.arg_set_id,'debug.apQuatY')) AS qy,
        COALESCE(extract_arg(s.arg_set_id,'debug.quatZ'), extract_arg(s.arg_set_id,'debug.apQuatZ')) AS qz,
        COALESCE(extract_arg(s.arg_set_id,'debug.quatW'), extract_arg(s.arg_set_id,'debug.apQuatW')) AS qw
        ${metaCols}
      FROM slice s
      WHERE s.id = ${eventId} AND s.name IN ${XR_EVENTS}
      LIMIT 1
    `);
    if (res.numRows() === 0) return null;
    const it = res.firstRow({
      ename: STR_NULL, stage: STR_NULL, src: STR_NULL, entity: STR_NULL,
      frame: NUM_NULL, px: NUM_NULL, py: NUM_NULL, pz: NUM_NULL,
      qx: NUM_NULL, qy: NUM_NULL, qz: NUM_NULL, qw: NUM_NULL,
      pkg: STR_NULL, full_uuid: STR_NULL,
    });
    return {...it, ename: it.ename ?? '?'} as PoseRow;
  }
}

// Build the materialized, indexed slice table once per trace. entity_low is kept
// as an int (for any future joins/derived columns); `name` is its hex form for
// display; `lane` = event/sub-stage. All derived purely from the loaded trace.
async function ensureTable(trace: Trace): Promise<void> {
  try {
    await trace.engine.query(`
      CREATE PERFETTO TABLE xr_pipeline_slices AS
      SELECT
        s.id AS id,
        s.ts AS ts,
        0 AS dur,
        extract_arg(s.arg_set_id, 'debug.apertureLow') AS entity_low,
        printf('0x%x', extract_arg(s.arg_set_id, 'debug.apertureLow')) AS name,
        s.name || '/' || ${SUB_EXPR} AS lane
      FROM slice s
      WHERE s.name IN ${XR_EVENTS} AND s.dur = 0
    `);
    await trace.engine.query(
      `CREATE PERFETTO INDEX xr_pipeline_slices_lane ON xr_pipeline_slices(lane)`);
  } catch {
    // Already created (re-entrant load) — safe to ignore.
  }
}

// apertureLow of a full UUID, matching SQL printf('0x%x', apertureLow): the first
// 8 bytes read little-endian. BigInt keeps the full 64 bits (JS numbers can't).
function apLowHex(uuid: string): string {
  const h = uuid.replace(/-/g, '').slice(0, 16); // first 8 bytes, big-endian hex
  let le = '';
  for (let i = 14; i >= 0; i -= 2) le += h.slice(i, i + 2);
  return '0x' + BigInt('0x' + le).toString(16);
}

// Build xr_entity_meta(entity_hex, full_uuid, pkg, role) from correlate.py --json
// rows. Uses SELECT ... UNION ALL (trace_processor rejects `(VALUES ...) AS t(cols)`).
async function loadMeta(trace: Trace, rows: ReadonlyArray<any>): Promise<number> {
  const esc = (s: unknown) => String(s ?? '').replace(/'/g, "''");
  const seen = new Set<string>();
  const selects: string[] = [];
  const add = (hex: string, uuid: string, pkg: string, role: string) => {
    if (seen.has(hex)) return;
    seen.add(hex);
    const cols = `'${esc(hex)}','${esc(uuid)}','${esc(pkg)}','${esc(role)}'`;
    selects.push(selects.length === 0
      ? `SELECT '${esc(hex)}' AS entity_hex, '${esc(uuid)}' AS full_uuid, ` +
        `'${esc(pkg)}' AS pkg, '${esc(role)}' AS role`
      : `SELECT ${cols}`);
  };
  for (const r of rows) {
    if (r.uuid) add(apLowHex(r.uuid), r.uuid, r.pkg ?? '', r.in?.sm || r.category || 'window');
    if (r.sm_token) add(apLowHex(r.sm_token), r.sm_token, r.pkg ?? '', 'token->' + (r.short ?? ''));
  }
  if (selects.length === 0) return 0;
  await trace.engine.query(
    'CREATE OR REPLACE PERFETTO TABLE xr_entity_meta AS\n' + selects.join('\nUNION ALL '));
  return selects.length;
}

// Prompt for the correlate.py --json file (dumps aren't in the trace, and the
// browser can't read local files without a user gesture), then build the table.
function pickAndLoadMeta(trace: Trace): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const rows = JSON.parse(await file.text());
      const n = await loadMeta(trace, rows);
      poseTab?.invalidate();
      console.info(`XR pipeline: loaded ${n} entity mappings from ${file.name}`);
    } catch (e) {
      console.error('XR pipeline: failed to load entity metadata', e);
    }
  };
  input.click();
}

// Build xr_entity_meta from XrEntityMeta events embedded by xrbundle (the augmented
// trace). No-op if the trace wasn't augmented; the file-picker command is the
// fallback for un-augmented traces.
async function ensureMetaFromEmbedded(trace: Trace): Promise<void> {
  try {
    const c = await trace.engine.query(
      `SELECT count(*) AS n FROM slice WHERE name = 'XrEntityMeta'`);
    if (c.firstRow({n: NUM}).n === 0) return;
    await trace.engine.query(`
      CREATE OR REPLACE PERFETTO TABLE xr_entity_meta AS
      SELECT DISTINCT
        extract_arg(s.arg_set_id, 'debug.entity_hex') AS entity_hex,
        extract_arg(s.arg_set_id, 'debug.full_uuid')  AS full_uuid,
        extract_arg(s.arg_set_id, 'debug.pkg')        AS pkg,
        extract_arg(s.arg_set_id, 'debug.role')       AS role
      FROM slice s WHERE s.name = 'XrEntityMeta'`);
  } catch {
    // No embedded metadata / older engine — the file-picker command still works.
  }
}

function note(text: string): m.Children {
  return m('div', {style: 'padding:12px; color:#aaa; font-size:13px'}, text);
}
