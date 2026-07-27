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
import {NUM, STR, STR_NULL} from '../../trace_processor/query_result';

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

async function loadStream(trace: Trace, name: string, sub: string,
                          prefix: string): Promise<ByEntity> {
  const res = await trace.engine.query(`
    SELECT printf('0x%x', extract_arg(s.arg_set_id,'debug.apertureLow')) AS e,
      s.ts AS ts,
      extract_arg(s.arg_set_id,'debug.${prefix}X') AS px,
      extract_arg(s.arg_set_id,'debug.${prefix}Y') AS py,
      extract_arg(s.arg_set_id,'debug.${prefix}Z') AS pz,
      extract_arg(s.arg_set_id,'debug.${prefix}QuatX') AS qx,
      extract_arg(s.arg_set_id,'debug.${prefix}QuatY') AS qy,
      extract_arg(s.arg_set_id,'debug.${prefix}QuatZ') AS qz,
      extract_arg(s.arg_set_id,'debug.${prefix}QuatW') AS qw,
      extract_arg(s.arg_set_id,'debug.poseSource') AS src
    FROM slice s
    WHERE s.name='${name}' AND s.dur=0 AND ${sub}
    ORDER BY e, ts`);
  const it = res.iter({
    e: STR, ts: NUM, px: NUM, py: NUM, pz: NUM,
    qx: NUM, qy: NUM, qz: NUM, qw: NUM, src: STR_NULL,
  });
  const out: ByEntity = new Map();
  for (; it.valid(); it.next()) {
    let arr = out.get(it.e);
    if (!arr) out.set(it.e, arr = []);
    arr.push({ts: it.ts, p: [it.px, it.py, it.pz], q: [it.qx, it.qy, it.qz, it.qw], src: it.src});
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
      `${P}='shellContainerLocalToRaw'`, 'pos');
    this.children = await loadStream(this.trace, 'SpaceManagerWrite',
      `${P}='aetherChild'`, 'pos');
    this.latched = await loadStream(this.trace, 'AperturePose',
      `extract_arg(s.arg_set_id,'debug.stage')='Latched'`, 'apPos');
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
    return m('div', {
      style: 'position:relative; width:100%; height:520px; background:#0b0b0f',
      oncreate: (v) => this.mount(v.dom as HTMLElement),
      onremove: () => this.unmount(),
    });
  }

  private mount(el: HTMLElement): void {
    const w = el.clientWidth || 800, h = el.clientHeight || 520;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;height:100%;display:block';
    el.appendChild(canvas);
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
      this.raf = requestAnimationFrame(loop);
      const cw = el.clientWidth, ch = el.clientHeight;
      if (cw && ch && (cw !== this.renderer!.domElement.width || ch !== this.renderer!.domElement.height)) {
        this.renderer!.setSize(cw, ch, false);
        this.camera!.aspect = cw / ch; this.camera!.updateProjectionMatrix();
      }
      const mk = this.marker();
      if (mk !== undefined && mk !== this.lastMarker) { this.lastMarker = mk; this.rebuild(mk); }
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
    cancelAnimationFrame(this.raf);
    this.renderer?.dispose();
    this.renderer = undefined;
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

  private rebuild(marker: number): void {
    if (!this.gizmos) return;
    this.gizmos.clear();
    const rows: string[] = [];
    const swatch = (c: number) =>
      `<span style="display:inline-block;width:9px;height:9px;background:#${c.toString(16).padStart(6, '0')};margin-right:5px"></span>`;
    const fmt = (s: Sample) =>
      `(${s.p.map((x) => x.toFixed(2)).join(', ')})`;
    const label = (e: string) => {
      const md = this.meta.get(e);
      return md && (md.pkg || md.role)
        ? `${e} ${md.role}${md.pkg ? ' ' + md.pkg.split('/').pop() : ''}` : e;
    };

    // Active container (RAW): the one with a sample at the marker; prefer most writes.
    let containerMat: any | undefined;
    let containerName = '';
    let best = -1;
    for (const [e, arr] of this.containers) {
      const s = lastLE(arr, marker);
      if (!s) continue;
      if (arr.length > best) { best = arr.length; containerMat = this.matrix(s); containerName = e; }
      const c = 0xdddddd;
      this.addGizmo(this.matrix(s), 0.4, c);
      rows.push(`${swatch(c)}container ${label(e)} ${fmt(s)}`);
    }

    // Latched aperture poses (RAW).
    for (const [e, arr] of this.latched) {
      const s = lastLE(arr, marker);
      if (!s) continue;
      const c = new THREE.Color().setHSL(hue(e), 0.7, 0.55).getHex();
      this.addGizmo(this.matrix(s), 0.28, c);
      rows.push(`${swatch(c)}latched ${label(e)} src=${s.src ?? '?'} ${fmt(s)}`);
    }

    // aetherChild (container frame) composed with the active container -> RAW.
    for (const [tok, arr] of this.children) {
      const s = lastLE(arr, marker);
      if (!s || !containerMat) continue;
      const world = new THREE.Matrix4().multiplyMatrices(containerMat, this.matrix(s));
      const win = this.tokenToWindow.get(tok);
      const c = win ? new THREE.Color().setHSL(hue(win), 0.9, 0.6).getHex() : 0xff33ff;
      this.addGizmo(world, 0.34, c);
      rows.push(`${swatch(c)}child ${label(tok)} ∘ ${containerName.slice(0, 8)}` +
        `${win ? ' → win ' + win : ''} ${fmt(s)}`);
    }

    if (this.legend) {
      const ms = (marker / 1e9).toFixed(3);
      this.legend.innerHTML =
        `<b>marker t=${ms}s</b>  (hover the timeline)<br>` +
        (rows.length ? rows.join('<br>') : '(no poses at/before marker)');
    }
  }
}
