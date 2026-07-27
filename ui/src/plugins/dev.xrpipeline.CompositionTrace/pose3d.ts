// XR Pose 3D -- a three.js tab that shows, at the timeline marker, the last:
//   * shellContainer write (container-in-RAW)        -> white gizmo
//   * aetherChild write (child-in-container) composed with its container  -> gizmo
//   * latched aperture pose per aperture (rawFromAperture) -> gizmo
// so you can SEE how the transforms relate frame-by-frame (e.g. a composed child
// sitting off its latched aperture = misalignment). OpenXR and three.js share the
// convention (+Y up, -Z forward, right-handed), so poses map directly.
//
// All pose events are preloaded into memory once; the view follows
// trace.timeline.hoverCursorTimestamp via an in-memory binary search (no re-query
// per hover). three.module.js is vendored alongside this file.

import m from 'mithril';
// Vendored three.js (JS build only, no .d.ts). Force `any` so tsc doesn't
// type-analyze the JS build (its inferred types are incomplete); fine for a
// diagnostic viewer.
// @ts-ignore
import * as THREE_ from './three.module.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const THREE: any = THREE_;
import type {Trace} from '../../public/trace';
import type {Tab} from '../../public/tab';
import {NUM, NUM_NULL, STR, STR_NULL} from '../../trace_processor/query_result';

interface Sample {
  ts: number;
  p: [number, number, number];
  q: [number, number, number, number];
  src: string | null;
}
type ByEntity = Map<string, Sample[]>;

interface Meta {
  pkg: string;
  role: string;
}

function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff;
  return (h % 360) / 360;
}

function lastLE(samples: Sample[], ts: number): Sample | undefined {
  // rightmost sample with sample.ts <= ts
  let lo = 0, hi = samples.length - 1, res: Sample | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].ts <= ts) {
      res = samples[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return res;
}

// Samples with s <= ts <= e, strided down to at most `cap` (keeps the last).
function samplesInRange(arr: Sample[], s: number, e: number, cap = 400): Sample[] {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mmid = (lo + hi) >> 1; if (arr[mmid].ts < s) lo = mmid + 1; else hi = mmid; }
  const out: Sample[] = [];
  for (let i = lo; i < arr.length && arr[i].ts <= e; i++) out.push(arr[i]);
  if (out.length <= cap) return out;
  const stride = Math.ceil(out.length / cap);
  const strided = out.filter((_, i) => i % stride === 0);
  if (strided[strided.length - 1] !== out[out.length - 1]) strided.push(out[out.length - 1]);
  return strided;
}

async function loadStream(trace: Trace, name: string, sub: string,
                          posPfx: string, quatPfx: string): Promise<ByEntity> {
  // SpaceManagerWrite args: posX/Y/Z + quatX/Y/Z/W. AperturePose: apPosX.. + apQuatX..
  const res = await trace.engine.query(`
    SELECT printf('0x%x', extract_arg(s.arg_set_id,'debug.apertureLow')) AS e,
      s.ts AS ts,
      extract_arg(s.arg_set_id,'debug.${posPfx}X') AS px,
      extract_arg(s.arg_set_id,'debug.${posPfx}Y') AS py,
      extract_arg(s.arg_set_id,'debug.${posPfx}Z') AS pz,
      extract_arg(s.arg_set_id,'debug.${quatPfx}X') AS qx,
      extract_arg(s.arg_set_id,'debug.${quatPfx}Y') AS qy,
      extract_arg(s.arg_set_id,'debug.${quatPfx}Z') AS qz,
      extract_arg(s.arg_set_id,'debug.${quatPfx}W') AS qw,
      extract_arg(s.arg_set_id,'debug.poseSource') AS src
    FROM slice s
    WHERE s.name='${name}' AND s.dur=0 AND ${sub}
    ORDER BY e, ts`);
  const it = res.iter({
    e: STR, ts: NUM, px: NUM_NULL, py: NUM_NULL, pz: NUM_NULL,
    qx: NUM_NULL, qy: NUM_NULL, qz: NUM_NULL, qw: NUM_NULL, src: STR_NULL,
  });
  const out: ByEntity = new Map();
  for (; it.valid(); it.next()) {
    if (it.px === null || it.qx === null || it.qw === null) continue;  // skip partial rows
    let arr = out.get(it.e);
    if (!arr) out.set(it.e, arr = []);
    arr.push({
      ts: it.ts,
      p: [it.px, it.py!, it.pz!],
      q: [it.qx, it.qy!, it.qz!, it.qw],
      src: it.src,
    });
  }
  return out;
}

export class Pose3DTab implements Tab {
  private containers: ByEntity = new Map();  // shellContainerLocalToRaw (RAW)
  private children: ByEntity = new Map();    // aetherChild (container frame), keyed by token
  private latched: ByEntity = new Map();     // AperturePose Latched (RAW)
  private meta = new Map<string, Meta>();       // entity_hex -> {pkg, role}
  private tokenToWindow = new Map<string, string>(); // token hex -> window aperture hex
  private ready = false;

  private renderer?: any;
  private scene?: any;
  private camera?: any;
  private gizmos?: any;
  private legend?: HTMLDivElement;
  private raf = 0;
  private lastMarker = NaN;
  private lastKey = '';
  private hostEl?: HTMLElement;
  private mountToken = 0;
  private resizeObs?: ResizeObserver;
  // orbit
  private theta = 0.7;
  private phi = 1.2;
  private radius = 6;
  private readonly target = new THREE.Vector3(0, 1.2, 0);

  constructor(private readonly trace: Trace) {
    this.load();
  }

  getTitle(): string {
    return 'XR Pose 3D';
  }

  private async load(): Promise<void> {
    const P = "extract_arg(s.arg_set_id,'debug.poseSource')";
    this.containers = await loadStream(this.trace, 'SpaceManagerWrite',
      `${P}='shellContainerLocalToRaw'`, 'pos', 'quat');
    this.children = await loadStream(this.trace, 'SpaceManagerWrite',
      `${P}='aetherChild'`, 'pos', 'quat');
    this.latched = await loadStream(this.trace, 'AperturePose',
      `extract_arg(s.arg_set_id,'debug.stage')='Latched'`, 'apPos', 'apQuat');
    await this.loadMeta();
    this.ready = true;
    m.redraw();
  }

  private async loadMeta(): Promise<void> {
    try {
      const res = await this.trace.engine.query(
        `SELECT entity_hex AS e, full_uuid AS u, pkg, role FROM xr_entity_meta`);
      const it = res.iter({e: STR, u: STR_NULL, pkg: STR_NULL, role: STR_NULL});
      const shortToWin = new Map<string, string>();
      const tokens: Array<{e: string, role: string}> = [];
      for (; it.valid(); it.next()) {
        this.meta.set(it.e, {pkg: it.pkg ?? '', role: it.role ?? ''});
        if (it.u) shortToWin.set(it.u.slice(0, 8), it.e);       // uuid short -> window hex
        if ((it.role ?? '').startsWith('token->')) tokens.push({e: it.e, role: it.role!});
      }
      for (const t of tokens) {
        const win = shortToWin.get(t.role.slice('token->'.length));
        if (win) this.tokenToWindow.set(t.e, win);
      }
    } catch {
      // no embedded/loaded meta; labels + token->window color-match unavailable.
    }
  }

  private marker(): number | undefined {
    const t = this.trace.timeline.hoverCursorTimestamp;
    if (t !== undefined) return Number(t);
    return Number.isNaN(this.lastMarker) ? undefined : this.lastMarker;
  }

  render(): m.Children {
    if (!this.ready) {
      return m('div', {style: 'padding:12px; color:#aaa'}, 'Loading pose data…');
    }
    // min-height + height:100% so the wrapper has real height in the side panel
    // (its content area doesn't impose one); the canvas fills it absolutely.
    return m('div', {
      style: 'position:relative; width:100%; height:100%; min-height:70vh; background:#0b0b0f',
      oncreate: (v) => this.mount(v.dom as HTMLElement),
      // We append the canvas/legend imperatively; without this Mithril diffs this
      // node on every redraw and strips those children (leaving a blank div).
      onbeforeupdate: () => false,
      onremove: () => this.unmount(),
    });
  }

  private mount(el: HTMLElement): void {
    this.unmount();          // idempotent: tear down any prior renderer/loop/canvas
    el.replaceChildren();    // drop any stale canvas/legend if oncreate re-fired
    this.hostEl = el;
    this.lastKey = '';       // force a rebuild for the current state on (re)mount
    const myToken = ++this.mountToken;
    const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight);
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
    el.appendChild(canvas);
    // Panel resizes don't trigger Mithril redraws; observe the element directly.
    this.resizeObs = new ResizeObserver(() => {
      if (!this.renderer || !this.camera) return;
      const cw = Math.max(1, el.clientWidth), ch = Math.max(1, el.clientHeight);
      this.renderer.setSize(cw, ch, false);
      this.camera.aspect = cw / ch;
      this.camera.updateProjectionMatrix();
    });
    this.resizeObs.observe(el);
    this.legend = document.createElement('div');
    this.legend.style.cssText =
      'position:absolute;top:6px;left:8px;font:11px/1.4 monospace;color:#ddd;' +
      'background:rgba(0,0,0,0.45);padding:6px 8px;border-radius:4px;max-width:60%';
    el.appendChild(this.legend);

    this.renderer = new THREE.WebGLRenderer({canvas, antialias: true});
    this.renderer.setSize(w, h, false);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, w / h, 0.01, 1000);
    this.scene.add(new THREE.GridHelper(20, 20, 0x444444, 0x222222));
    const worldAxes = new THREE.AxesHelper(0.5);  // RAW origin
    this.scene.add(worldAxes);
    this.gizmos = new THREE.Group();
    this.scene.add(this.gizmos);

    // minimal orbit
    let drag = false, lx = 0, ly = 0;
    canvas.addEventListener('mousedown', (e) => { drag = true; lx = e.clientX; ly = e.clientY; });
    window.addEventListener('mouseup', () => { drag = false; });
    canvas.addEventListener('mousemove', (e) => {
      if (!drag) return;
      this.theta -= (e.clientX - lx) * 0.01;
      this.phi = Math.max(0.05, Math.min(Math.PI - 0.05, this.phi - (e.clientY - ly) * 0.01));
      lx = e.clientX; ly = e.clientY;
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.radius = Math.max(0.3, Math.min(80, this.radius * Math.exp(e.deltaY * 0.001)));
    }, {passive: false});

    const loop = () => {
      if (myToken !== this.mountToken) return;  // superseded by a newer mount → stop
      this.raf = requestAnimationFrame(loop);
      const cw = el.clientWidth, ch = el.clientHeight;
      if (cw && ch && (cw !== this.renderer!.domElement.width || ch !== this.renderer!.domElement.height)) {
        this.renderer!.setSize(cw, ch, false);
        this.camera!.aspect = cw / ch; this.camera!.updateProjectionMatrix();
      }
      // Drive from an area selection (trail over the range) if present, else the
      // hover marker (snapshot).
      const sel = this.trace.selection.selection;
      let range: [number, number] | undefined;
      let trail = false;
      if (sel && sel.kind === 'area') {
        range = [Number(sel.start), Number(sel.end)];
        trail = true;
      } else {
        const mk = this.marker();
        if (mk !== undefined) { this.lastMarker = mk; range = [mk, mk]; }
      }
      const key = range ? `${trail ? 'a' : 'p'}:${range[0]}-${range[1]}` : '';
      if (range && key !== this.lastKey) { this.lastKey = key; this.rebuild(range, trail); }
      this.camera!.position.set(
        this.target.x + this.radius * Math.sin(this.phi) * Math.sin(this.theta),
        this.target.y + this.radius * Math.cos(this.phi),
        this.target.z + this.radius * Math.sin(this.phi) * Math.cos(this.theta));
      this.camera!.lookAt(this.target);
      this.renderer!.render(this.scene!, this.camera!);
    };
    loop();
  }

  private unmount(): void {
    this.mountToken++;              // invalidate any running loop
    cancelAnimationFrame(this.raf);
    this.resizeObs?.disconnect();
    this.resizeObs = undefined;
    this.renderer?.dispose();
    this.renderer = undefined;
    this.scene = undefined;
    this.camera = undefined;
    this.gizmos = undefined;
    this.hostEl?.replaceChildren?.();
    this.hostEl = undefined;
  }

  private matrix(s: Sample): any {
    return new THREE.Matrix4().compose(
      new THREE.Vector3(s.p[0], s.p[1], s.p[2]),
      new THREE.Quaternion(s.q[0], s.q[1], s.q[2], s.q[3]),
      new THREE.Vector3(1, 1, 1));
  }

  private addGizmo(mat: any, size: number, color: number): void {
    const a = new THREE.AxesHelper(size);
    a.matrixAutoUpdate = false;
    a.matrix.copy(mat);
    (a.material as any).depthTest = false;
    this.gizmos!.add(a);
    // a small colored dot at the origin for identification
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(size * 0.12, 8, 8),
      new THREE.MeshBasicMaterial({color}));
    dot.matrixAutoUpdate = false; dot.matrix.copy(mat);
    this.gizmos!.add(dot);
  }

  private addTrail(points: any[], color: number): void {
    if (points.length < 2) return;
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(
      geo, new THREE.LineBasicMaterial({color, transparent: true, opacity: 0.85}));
    this.gizmos!.add(line);
  }

  // range=[s,e]; trail=true renders every sample in [s,e] as a path, else a single
  // snapshot at e. Children are composed with the container pose at each sample's time.
  private rebuild(range: [number, number], trail: boolean): void {
    if (!this.gizmos) return;
    this.gizmos.clear();
    const [s, e] = range;
    const rows: string[] = [];
    const swatch = (c: number) =>
      `<span style="display:inline-block;width:9px;height:9px;background:#${c.toString(16).padStart(6, '0')};margin-right:5px"></span>`;
    const pos = (x: Sample) => `(${x.p.map((v) => v.toFixed(2)).join(', ')})`;
    const vec = (x: Sample) => new THREE.Vector3(x.p[0], x.p[1], x.p[2]);
    const label = (e2: string) => {
      const md = this.meta.get(e2);
      return md && (md.pkg || md.role)
        ? `${e2} ${md.role}${md.pkg ? ' ' + md.pkg.split('/').pop() : ''}` : e2;
    };

    // Active container (largest with a sample <= e), for composing children.
    let containerArr: Sample[] | undefined;
    let best = -1;
    for (const [, arr] of this.containers) {
      if (lastLE(arr, e) && arr.length > best) { best = arr.length; containerArr = arr; }
    }
    const containerAt = (t: number) => {
      const cs = containerArr ? lastLE(containerArr, t) : undefined;
      return cs ? this.matrix(cs) : undefined;
    };

    for (const [ce, arr] of this.containers) {
      const c = 0xdddddd;
      if (trail) {
        const ss = samplesInRange(arr, s, e);
        if (!ss.length) continue;
        this.addTrail(ss.map(vec), c);
        this.addGizmo(this.matrix(ss[ss.length - 1]), 0.4, c);
        rows.push(`${swatch(c)}container ${label(ce)} ×${ss.length}`);
      } else {
        const last = lastLE(arr, e); if (!last) continue;
        this.addGizmo(this.matrix(last), 0.4, c);
        rows.push(`${swatch(c)}container ${label(ce)} ${pos(last)}`);
      }
    }

    for (const [le, arr] of this.latched) {
      const c = new THREE.Color().setHSL(hue(le), 0.7, 0.55).getHex();
      if (trail) {
        const ss = samplesInRange(arr, s, e); if (!ss.length) continue;
        this.addTrail(ss.map(vec), c);
        this.addGizmo(this.matrix(ss[ss.length - 1]), 0.28, c);
        rows.push(`${swatch(c)}latched ${label(le)} ×${ss.length}`);
      } else {
        const last = lastLE(arr, e); if (!last) continue;
        this.addGizmo(this.matrix(last), 0.28, c);
        rows.push(`${swatch(c)}latched ${label(le)} src=${last.src ?? '?'} ${pos(last)}`);
      }
    }

    for (const [tok, arr] of this.children) {
      const win = this.tokenToWindow.get(tok);
      const c = win ? new THREE.Color().setHSL(hue(win), 0.9, 0.6).getHex() : 0xff33ff;
      if (trail) {
        const ss = samplesInRange(arr, s, e); if (!ss.length) continue;
        const pts: any[] = [];
        for (const x of ss) {
          const cm = containerAt(x.ts); if (!cm) continue;
          const w = new THREE.Matrix4().multiplyMatrices(cm, this.matrix(x));
          pts.push(new THREE.Vector3().setFromMatrixPosition(w));
        }
        if (!pts.length) continue;
        this.addTrail(pts, c);
        const lastCm = containerAt(ss[ss.length - 1].ts);
        if (lastCm) {
          this.addGizmo(new THREE.Matrix4().multiplyMatrices(lastCm, this.matrix(ss[ss.length - 1])), 0.34, c);
        }
        rows.push(`${swatch(c)}child ${label(tok)}${win ? ' → ' + win : ''} ×${ss.length}`);
      } else {
        const last = lastLE(arr, e); const cm = containerAt(e);
        if (!last || !cm) continue;
        this.addGizmo(new THREE.Matrix4().multiplyMatrices(cm, this.matrix(last)), 0.34, c);
        rows.push(`${swatch(c)}child ${label(tok)}${win ? ' → win ' + win : ''} ${pos(last)}`);
      }
    }

    if (this.legend) {
      const hdr = trail
        ? `<b>trail ${(s / 1e9).toFixed(3)}–${(e / 1e9).toFixed(3)} s</b> (area-select a range; hover for a snapshot)`
        : `<b>marker t=${(e / 1e9).toFixed(3)} s</b> (hover the timeline; area-select for a trail)`;
      this.legend.innerHTML = hdr + '<br>' + (rows.length ? rows.join('<br>') : '(no poses in range)');
    }
  }
}
