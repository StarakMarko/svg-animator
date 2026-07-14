/* ================================================================
   SVG ANIMATOR — Morph Path Editor  (v2)
   Handles injected DIRECTLY into state.svgElement — no separate
   overlay SVG, so coordinate systems always match.
   ================================================================ */
import { state, bus, addKeyframe, pushUndo } from './app.js';

let overlayG   = null;   // <g> appended to state.svgElement
let activeId   = null;
let activePath = null;
let segments   = [];     // parsed & mutable during drag
let _savedSvgOverflow      = null;  // to restore on deactivate
let _savedContentOverflow  = null;
let _savedViewportOverflow = null;



// ─── Init ────────────────────────────────────────────────────────
export function initMorphEditor() {
  bus.on('element:selected',  refresh);
  bus.on('tracks:changed',    refresh);
  bus.on('keyframe:selected', refresh);
  bus.on('time:changed',      () => { if (overlayG && activePath) renderPoints(); });
  bus.on('svg:loaded',        deactivate);
  bus.on('undo',              () => { if (overlayG && activePath) renderPoints(); });
}

// ─── Activate / deactivate ───────────────────────────────────────
function refresh() {
  const id     = state.selectedId;
  const info   = id ? state.elements.get(id)    : null;
  const tracks = id ? state.animations.get(id)  : null;
  const morphSelected =
    state.selectedTrack?.property   === 'morph' &&
    state.selectedTrack?.elementId  === id;

  if (!id || info?.type !== 'path' || !tracks?.has('morph') || !morphSelected) {
    deactivate(); return;
  }
  activate(id, info.el);
}

function activate(elementId, pathEl) {
  if (activeId === elementId && overlayG?.isConnected) { renderPoints(); return; }
  deactivate();
  activeId   = elementId;
  activePath = pathEl;

  // Allow handles to render OUTSIDE the SVG viewBox
  _savedSvgOverflow = state.svgElement.style.overflow || '';
  state.svgElement.style.overflow = 'visible';

  const content  = document.getElementById('canvas-content');
  const viewport = document.getElementById('canvas-viewport');
  if (content)  { _savedContentOverflow  = content.style.overflow  || ''; content.style.overflow  = 'visible'; }
  if (viewport) { _savedViewportOverflow = viewport.style.overflow || ''; viewport.style.overflow = 'visible'; }


  showBadge(true);
  // One rAF so the SVG is in DOM and getCTM() is valid
  requestAnimationFrame(() => { ensureOverlay(); renderPoints(); });
}


function deactivate() {
  if (overlayG) { overlayG.remove(); overlayG = null; }
  // Restore overflow
  if (state.svgElement && _savedSvgOverflow !== null) {
    state.svgElement.style.overflow = _savedSvgOverflow;
    _savedSvgOverflow = null;
  }
  const content  = document.getElementById('canvas-content');
  const viewport = document.getElementById('canvas-viewport');
  if (content  && _savedContentOverflow  !== null) { content.style.overflow  = _savedContentOverflow;  _savedContentOverflow  = null; }
  if (viewport && _savedViewportOverflow !== null) { viewport.style.overflow = _savedViewportOverflow; _savedViewportOverflow = null; }
  showBadge(false);
  activeId = null; activePath = null; segments = [];
}



// ─── Overlay <g> (lives inside the original SVG) ─────────────────
function ensureOverlay() {
  if (overlayG?.isConnected) return;
  if (!state.svgElement) return;
  overlayG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  overlayG.id = 'morph-editor-overlay';
  overlayG.setAttribute('pointer-events', 'none');
  state.svgElement.appendChild(overlayG);
}

// ─── Handle radius (SVG viewport units ≈ desiredPx on screen) ────
function svgR(desiredPx) {
  try {
    const rect = state.svgElement.getBoundingClientRect();
    const vb   = state.svgElement.viewBox.baseVal;
    if (rect.width > 0 && vb.width > 0)
      return (desiredPx * vb.width) / rect.width;
  } catch (_) {}
  return desiredPx;
}

// ─── Render handles ──────────────────────────────────────────────
function renderPoints() {
  if (!overlayG || !activePath) return;
  overlayG.innerHTML = '';

  segments = parsePath(activePath.getAttribute('d') || '');

  // ctm maps path-local → SVG viewport coords
  let ctm;
  try { ctm = activePath.getCTM(); } catch (_) {}
  if (!ctm) return;

  const ra = svgR(6);    // anchor radius
  const rc = svgR(4);    // control-point radius
  const sw = svgR(1.5);  // stroke-width
  const swThin = svgR(1);

  segments.forEach((seg, idx) => {
    if (seg.cmd === 'Z') return;

    // Anchor in SVG viewport coords
    const aPos = xfPt(ctm, seg.x, seg.y);

    // ── Bezier control handles ──────────────────────────────────
    if ((seg.cmd === 'C' || seg.cmd === 'Q') && seg.x1 !== undefined) {
      const cp1Pos  = xfPt(ctm, seg.x1, seg.y1);
      const prevAnc = prevAnchor(idx);
      const prevPos = xfPt(ctm, prevAnc.x, prevAnc.y);

      // arm: prev-anchor → cp1
      overlayG.appendChild(mkLine(prevPos.x, prevPos.y, cp1Pos.x, cp1Pos.y, swThin));

      const cp1 = mkCircle(cp1Pos.x, cp1Pos.y, rc, '#ff9f4a', '#fff', swThin);
      cp1.setAttribute('pointer-events', 'all');
      cp1.style.cursor = 'crosshair';
      makeDraggable(cp1,
        (sx, sy, el) => {
          const l = screenToLocal(sx, sy);
          segments[idx].x1 = l.x; segments[idx].y1 = l.y;
          const np = xfPt(ctm, l.x, l.y);
          el.setAttribute('cx', np.x); el.setAttribute('cy', np.y);
          activePath.setAttribute('d', serialize(segments));
        },
        commitKeyframe
      );
      overlayG.appendChild(cp1);
    }

    if (seg.cmd === 'C' && seg.x2 !== undefined) {
      const cp2Pos = xfPt(ctm, seg.x2, seg.y2);

      // arm: anchor → cp2
      overlayG.appendChild(mkLine(aPos.x, aPos.y, cp2Pos.x, cp2Pos.y, swThin));

      const cp2 = mkCircle(cp2Pos.x, cp2Pos.y, rc, '#ff9f4a', '#fff', swThin);
      cp2.setAttribute('pointer-events', 'all');
      cp2.style.cursor = 'crosshair';
      makeDraggable(cp2,
        (sx, sy, el) => {
          const l = screenToLocal(sx, sy);
          segments[idx].x2 = l.x; segments[idx].y2 = l.y;
          const np = xfPt(ctm, l.x, l.y);
          el.setAttribute('cx', np.x); el.setAttribute('cy', np.y);
          activePath.setAttribute('d', serialize(segments));
        },
        commitKeyframe
      );
      overlayG.appendChild(cp2);
    }

    // ── Anchor circle ───────────────────────────────────────────
    const anchor = mkCircle(aPos.x, aPos.y, ra, '#4a9eff', '#fff', sw);
    anchor.setAttribute('pointer-events', 'all');
    anchor.style.cursor = 'move';
    makeDraggable(anchor,
      (sx, sy, el) => {
        const l = screenToLocal(sx, sy);
        segments[idx].x = l.x; segments[idx].y = l.y;
        const np = xfPt(ctm, l.x, l.y);
        el.setAttribute('cx', np.x); el.setAttribute('cy', np.y);
        activePath.setAttribute('d', serialize(segments));
      },
      commitKeyframe
    );
    overlayG.appendChild(anchor);
  });
}

function prevAnchor(segIdx) {
  for (let i = segIdx - 1; i >= 0; i--)
    if (segments[i].cmd !== 'Z') return { x: segments[i].x, y: segments[i].y };
  return { x: 0, y: 0 };
}

function commitKeyframe() {
  if (!activeId) return;
  addKeyframe(activeId, 'morph', state.currentTime, serialize(segments));
  requestAnimationFrame(renderPoints);
}

// ─── Coordinate helpers ──────────────────────────────────────────

/** Transform a path-local point through ctm → SVG viewport */
function xfPt(ctm, x, y) {
  const pt = state.svgElement.createSVGPoint();
  pt.x = x; pt.y = y;
  return pt.matrixTransform(ctm);
}

/** Screen pixel → path-local coordinate */
function screenToLocal(sx, sy) {
  try {
    const pt = state.svgElement.createSVGPoint();
    pt.x = sx; pt.y = sy;
    return pt.matrixTransform(activePath.getScreenCTM().inverse());
  } catch (_) { return { x: sx, y: sy }; }
}

// ─── Drag helper ─────────────────────────────────────────────────
function makeDraggable(el, onDrag, onRelease) {
  el.addEventListener('mousedown', e => {
    e.stopPropagation(); e.preventDefault();
    pushUndo();   // snapshot BEFORE drag begins (enables undo of this drag)
    const move = ev => { ev.preventDefault(); onDrag(ev.clientX, ev.clientY, el); };
    const up   = ()  => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup',   up);
      onRelease();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup',   up);
  });
}

// ─── SVG factories ───────────────────────────────────────────────
function mkCircle(cx, cy, r, fill, stroke, sw) {
  const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', r);
  c.setAttribute('fill', fill); c.setAttribute('stroke', stroke);
  c.setAttribute('stroke-width', sw);
  return c;
}

function mkLine(x1, y1, x2, y2, sw) {
  const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  l.setAttribute('x1', x1); l.setAttribute('y1', y1);
  l.setAttribute('x2', x2); l.setAttribute('y2', y2);
  l.setAttribute('stroke', '#ff9f4a80');
  l.setAttribute('stroke-width', sw);
  l.setAttribute('stroke-dasharray', `${svgR(3)} ${svgR(2)}`);
  return l;
}

// ─── Badge ───────────────────────────────────────────────────────
function showBadge(visible) {
  let b = document.getElementById('morph-edit-badge');
  if (!b && visible) {
    b = document.createElement('div');
    b.id = 'morph-edit-badge';
    b.textContent = '✏ MORPH EDIT — drag blue points  |  Ctrl+Z to undo';
    Object.assign(b.style, {
      position: 'absolute', top: '8px', left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(255,159,74,0.92)', color: '#1a1a2e',
      fontFamily: 'Inter,sans-serif', fontSize: '11px',
      fontWeight: '600', letterSpacing: '0.04em',
      padding: '4px 14px', borderRadius: '20px',
      pointerEvents: 'none', zIndex: '200', whiteSpace: 'nowrap',
    });
    document.getElementById('canvas-area').appendChild(b);
  }
  if (b) b.style.display = visible ? 'block' : 'none';
}

// ─── Path parser — produces ABSOLUTE segments ─────────────────────
// Handles: M m L l H h V v C c S s Q q T t Z z
export function parsePath(d) {
  const re = /([MmLlHhVvCcSsQqTtZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
  const tokens = [];
  let m;
  while ((m = re.exec(d)) !== null)
    tokens.push(m[1] ? { t: 'c', v: m[1] } : { t: 'n', v: parseFloat(m[2]) });

  const segs = [];
  let i = 0, cx = 0, cy = 0, sx = 0, sy = 0;
  let lastCmd = '', lastCPX = 0, lastCPY = 0;

  const num = n => {
    const r = [];
    while (r.length < n && i < tokens.length && tokens[i].t === 'n') r.push(tokens[i++].v);
    return r;
  };
  const hasNum = () => i < tokens.length && tokens[i].t === 'n';

  while (i < tokens.length) {
    if (tokens[i].t !== 'c') { i++; continue; }
    const cmd = tokens[i++].v;
    do {
      switch (cmd) {
        case 'M':{ const[x,y]=num(2);cx=x;cy=y;sx=x;sy=y;segs.push({cmd:'M',x,y});break; }
        case 'm':{ const[dx,dy]=num(2);cx+=dx;cy+=dy;sx=cx;sy=cy;segs.push({cmd:'M',x:cx,y:cy});break; }
        case 'L':{ const[x,y]=num(2);cx=x;cy=y;segs.push({cmd:'L',x,y});break; }
        case 'l':{ const[dx,dy]=num(2);cx+=dx;cy+=dy;segs.push({cmd:'L',x:cx,y:cy});break; }
        case 'H':{ const[x]=num(1);cx=x;segs.push({cmd:'L',x:cx,y:cy});break; }
        case 'h':{ const[dx]=num(1);cx+=dx;segs.push({cmd:'L',x:cx,y:cy});break; }
        case 'V':{ const[y]=num(1);cy=y;segs.push({cmd:'L',x:cx,y:cy});break; }
        case 'v':{ const[dy]=num(1);cy+=dy;segs.push({cmd:'L',x:cx,y:cy});break; }
        case 'C':{ const[x1,y1,x2,y2,x,y]=num(6);lastCPX=x2;lastCPY=y2;cx=x;cy=y;
                   segs.push({cmd:'C',x1,y1,x2,y2,x,y});break; }
        case 'c':{ const[dx1,dy1,dx2,dy2,dx,dy]=num(6);
                   segs.push({cmd:'C',x1:cx+dx1,y1:cy+dy1,x2:cx+dx2,y2:cy+dy2,x:cx+dx,y:cy+dy});
                   lastCPX=cx+dx2;lastCPY=cy+dy2;cx+=dx;cy+=dy;break; }
        case 'S':{ const[x2,y2,x,y]=num(4);
                   const x1s=(lastCmd==='C'||lastCmd==='S')?2*cx-lastCPX:cx;
                   const y1s=(lastCmd==='C'||lastCmd==='S')?2*cy-lastCPY:cy;
                   segs.push({cmd:'C',x1:x1s,y1:y1s,x2,y2,x,y});
                   lastCPX=x2;lastCPY=y2;cx=x;cy=y;break; }
        case 's':{ const[dx2,dy2,dx,dy]=num(4);const x2=cx+dx2,y2=cy+dy2,x=cx+dx,y=cy+dy;
                   const x1s=(lastCmd==='C'||lastCmd==='c'||lastCmd==='S'||lastCmd==='s')?2*cx-lastCPX:cx;
                   const y1s=(lastCmd==='C'||lastCmd==='c'||lastCmd==='S'||lastCmd==='s')?2*cy-lastCPY:cy;
                   segs.push({cmd:'C',x1:x1s,y1:y1s,x2,y2,x,y});
                   lastCPX=x2;lastCPY=y2;cx=x;cy=y;break; }
        case 'Q':{ const[x1,y1,x,y]=num(4);lastCPX=x1;lastCPY=y1;cx=x;cy=y;
                   segs.push({cmd:'Q',x1,y1,x,y});break; }
        case 'q':{ const[dx1,dy1,dx,dy]=num(4);
                   segs.push({cmd:'Q',x1:cx+dx1,y1:cy+dy1,x:cx+dx,y:cy+dy});
                   lastCPX=cx+dx1;lastCPY=cy+dy1;cx+=dx;cy+=dy;break; }
        case 'T':{ const[x,y]=num(2);
                   const x1t=(lastCmd==='Q'||lastCmd==='T')?2*cx-lastCPX:cx;
                   const y1t=(lastCmd==='Q'||lastCmd==='T')?2*cy-lastCPY:cy;
                   segs.push({cmd:'Q',x1:x1t,y1:y1t,x,y});lastCPX=x1t;lastCPY=y1t;cx=x;cy=y;break; }
        case 't':{ const[dx,dy]=num(2);const x=cx+dx,y=cy+dy;
                   const x1t=(lastCmd==='Q'||lastCmd==='q'||lastCmd==='T'||lastCmd==='t')?2*cx-lastCPX:cx;
                   const y1t=(lastCmd==='Q'||lastCmd==='q'||lastCmd==='T'||lastCmd==='t')?2*cy-lastCPY:cy;
                   segs.push({cmd:'Q',x1:x1t,y1:y1t,x,y});lastCPX=x1t;lastCPY=y1t;cx=x;cy=y;break; }
        case 'Z':case 'z':segs.push({cmd:'Z'});cx=sx;cy=sy;break;
        default:break;
      }
      lastCmd = cmd;
    } while (hasNum() && cmd !== 'Z' && cmd !== 'z');
  }
  return segs;
}

// ─── Serialize segments → d string ───────────────────────────────
export function serializePath(segs) {
  const r = n => Math.round(n * 1000) / 1000;
  return segs.map(s => {
    switch (s.cmd) {
      case 'M': return `M ${r(s.x)} ${r(s.y)}`;
      case 'L': return `L ${r(s.x)} ${r(s.y)}`;
      case 'C': return `C ${r(s.x1)} ${r(s.y1)} ${r(s.x2)} ${r(s.y2)} ${r(s.x)} ${r(s.y)}`;
      case 'Q': return `Q ${r(s.x1)} ${r(s.y1)} ${r(s.x)} ${r(s.y)}`;
      case 'Z': return 'Z';
      default:  return '';
    }
  }).filter(Boolean).join(' ');
}

// Local alias used inside this module
const serialize = serializePath;
