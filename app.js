/* ================================================================
   SVG ANIMATOR — Core Application
   State management, event bus, file I/O, initialization
   ================================================================ */
import { initLayers, groupSelected, ungroupSelected, deleteSelected, duplicateSelected } from './layers.js';
import { initCanvas }     from './canvas.js';
import { initTimeline }   from './timeline.js';
import { initProperties } from './properties.js';
import { exportAnimatedSVG } from './exporter.js';
import { initMorphEditor }  from './morphEditor.js';


// ─── Global State ────────────────────────────────────────────────
export const state = {
  svgElement:    null,    // The <svg> DOM element on canvas
  svgSource:     '',      // Original SVG markup
  elements:      new Map(), // id → { el, name, type, parentId, locked, visible }
  selectedId:    null,    // Currently/Primary selected element id
  selectedIds:   new Set(), // All currently selected element ids
  animations:    new Map(), // elementId → Map( property → Keyframe[] )
  currentTime:   0,       // Playhead position in seconds
  duration:      10,      // Total animation duration
  isPlaying:     false,
  zoom:          1,
  nextId:        1,       // Auto-increment for element IDs
  scaleLocked:   true,    // Lock aspect ratio for scale
  selectedKeyframe: null, // { elementId, property, index }
  selectedTrack: null,    // { elementId, property }
};

// ─── Event Bus ───────────────────────────────────────────────────
const _handlers = {};
export const bus = {
  on(event, fn)  { (_handlers[event] ||= []).push(fn); },
  off(event, fn) { _handlers[event] = (_handlers[event] || []).filter(h => h !== fn); },
  emit(event, data) {
    for (const fn of (_handlers[event] || [])) {
      try { fn(data); } catch (e) { console.error(`[bus] Error in ${event}:`, e); }
    }
  }
};

// ─── Undo System ─────────────────────────────────────────────────
const _undoStack = [];
const _redoStack = [];
const MAX_UNDO   = 60;

function snapshotState() {
  const snapAnims = new Map();
  for (const [elId, tracks] of state.animations) {
    const t = new Map();
    for (const [prop, kfs] of tracks) {
      t.set(prop, kfs.map(kf => ({ ...kf, value: structuredClone(kf.value) })));
    }
    snapAnims.set(elId, t);
  }
  
  return {
    svgHTML: state.svgElement ? state.svgElement.innerHTML : '',
    nextId: state.nextId,
    animations: snapAnims,
    lockedStates: Array.from(state.elements.values()).map(info => ({ id: info.el.id, locked: info.locked, visible: info.visible })),
    selectedIds: Array.from(state.selectedIds),
    selectedId: state.selectedId,
  };
}

/** Push a deep snapshot of animations and DOM onto the undo stack. Call BEFORE mutating. */
export function pushUndo() {
  _undoStack.push(snapshotState());
  if (_undoStack.length > MAX_UNDO) _undoStack.shift();
  _redoStack.length = 0; // clear redo stack on new action
}

function restoreState(snap) {
  if (state.svgElement && snap.svgHTML !== undefined) {
    state.svgElement.innerHTML = snap.svgHTML;
    state.nextId = snap.nextId;
    
    // Re-walk to recreate elements map
    state.elements.clear();
    for (const child of state.svgElement.children) {
      walkSVG(child);
    }
    
    // Restore lock/visibility
    for (const ls of snap.lockedStates) {
      const info = state.elements.get(ls.id);
      if (info) {
        info.locked = ls.locked;
        info.visible = ls.visible;
        if (!info.visible) info.el.style.display = 'none';
      }
    }
    
    state.selectedIds = new Set(snap.selectedIds);
    state.selectedId = snap.selectedId;
    
    // Trigger canvas to re-add click listeners to new DOM nodes
    bus.emit('dom:changed');
  }
  
  state.animations = snap.animations;
  applyAnimationAtTime(state.currentTime);
  bus.emit('tracks:changed', null);
  bus.emit('undo', null);
}

export function undo() {
  if (_undoStack.length === 0) return;
  _redoStack.push(snapshotState());
  restoreState(_undoStack.pop());
}

export function redo() {
  if (_redoStack.length === 0) return;
  _undoStack.push(snapshotState());
  restoreState(_redoStack.pop());
}



// ─── ID Assignment ───────────────────────────────────────────────
function assignId(el) {
  if (!el.id) {
    el.id = `svga-${state.nextId++}`;
  } else {
    // Ensure our counter stays ahead
    const m = el.id.match(/^svga-(\d+)$/);
    if (m) state.nextId = Math.max(state.nextId, parseInt(m[1]) + 1);
  }
  return el.id;
}

// Walk an SVG element tree and assign IDs + register in state.elements
export function walkSVG(el, parentId = null, depth = 0) {
  const SVG_TAGS = ['g', 'path', 'rect', 'circle', 'ellipse', 'line',
                    'polyline', 'polygon', 'text', 'image', 'use', 'clipPath', 'mask'];
  const tag = el.tagName?.toLowerCase();
  if (!tag || !SVG_TAGS.includes(tag)) return;

  const originalId = el.getAttribute('id');
  const dataName   = el.getAttribute('data-name');
  const id         = assignId(el);

  let name;
  if (dataName) {
    name = dataName;
  } else if (originalId && !originalId.startsWith('svga-')) {
    name = originalId;
  } else {
    name = tag.charAt(0).toUpperCase() + tag.slice(1);
  }


  const existing = state.elements.get(id);

  state.elements.set(id, {
    el,
    name,
    type: tag === 'g' ? 'group' : tag,
    parentId,
    locked: existing ? existing.locked : false,
    visible: existing ? existing.visible : true,
    depth,
  });

  for (const child of el.children) {
    walkSVG(child, id, depth + 1);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────
export function getElementName(id) {
  const info = state.elements.get(id);
  return info ? info.name : id;
}

export function getDefaultValue(property) {
  switch (property) {
    case 'position': return { x: 0, y: 0 };
    case 'origin':   return { x: 0, y: 0 };
    case 'scale':    return { x: 1, y: 1 };
    case 'skew':     return { x: 0, y: 0 };
    case 'rotate':   return 0;
    case 'opacity':  return 100;
    case 'fill':     return '#000000';
    case 'morph':    return '';
    default:         return null;
  }
}

/** Read a property value from the SVG element itself (for initial keyframe values). */
export function readElementProperty(elId, property) {
  const info = state.elements.get(elId);
  if (!info) return getDefaultValue(property);
  const el = info.el;

  switch (property) {
    case 'position': {
      // Position track stores RELATIVE offset from element's natural position.
      // Always start at {x:0, y:0} so translate doesn't duplicate SVG attribute coords.
      return { x: 0, y: 0 };
    }
    case 'origin': {
      const bbox = el.getBBox ? el.getBBox() : { x: 0, y: 0, width: 0, height: 0 };
      return { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
    }
    case 'scale':   return { x: 1, y: 1 };
    case 'skew':    return { x: 0, y: 0 };
    case 'rotate':  {
      const t = el.getAttribute('transform') || '';
      const m = t.match(/rotate\(\s*([\-\d.]+)/);
      return m ? parseFloat(m[1]) : 0;
    }
    case 'opacity':  {
      const o = el.getAttribute('opacity') ?? el.style.opacity;
      return o !== '' && o !== null && o !== undefined ? parseFloat(o) * 100 : 100;
    }
    case 'fill': {
      let f = el.getAttribute('fill') || el.style.fill || '#000000';
      // Convert rgb() to hex if needed
      if (f.startsWith('rgb')) {
        const m = f.match(/(\d+)/g);
        if (m && m.length >= 3) {
          f = '#' + m.slice(0, 3).map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
        }
      }
      if (!f.startsWith('#')) f = '#000000';
      return f;
    }
    case 'morph': {
      return el.getAttribute('d') || '';
    }
    default: return getDefaultValue(property);
  }
}

// ─── Animation Data Helpers ──────────────────────────────────────
export function getElementTracks(elementId) {
  if (!state.animations.has(elementId)) {
    state.animations.set(elementId, new Map());
  }
  return state.animations.get(elementId);
}

export function addTrack(elementId, property) {
  const tracks = getElementTracks(elementId);
  if (tracks.has(property)) return; // already exists
  pushUndo();
  const initialValue = readElementProperty(elementId, property);
  tracks.set(property, [{ time: 0, value: initialValue, easing: 'linear' }]);
  bus.emit('tracks:changed', { elementId });
  bus.emit('keyframe:added', { elementId, property, index: 0 });
}


export function removeTrack(elementId, property) {
  pushUndo();
  const tracks = getElementTracks(elementId);
  tracks.delete(property);
  if (tracks.size === 0) state.animations.delete(elementId);
  bus.emit('tracks:changed', { elementId });
}


export function addKeyframe(elementId, property, time, value) {
  const tracks = getElementTracks(elementId);
  if (!tracks.has(property)) return;
  const kfs = tracks.get(property);
  // Update existing keyframe at same time (no undo push — morph editor handles it)
  const existing = kfs.findIndex(k => Math.abs(k.time - time) < 0.01);
  if (existing >= 0) {
    kfs[existing].value = value;
    bus.emit('keyframe:updated', { elementId, property, index: existing });
    return existing;
  }
  // Insert in sorted order
  const kf = { time, value, easing: 'linear' };
  let idx = kfs.findIndex(k => k.time > time);
  if (idx === -1) idx = kfs.length;
  kfs.splice(idx, 0, kf);
  bus.emit('keyframe:added', { elementId, property, index: idx });
  return idx;
}

export function deleteKeyframe(elementId, property, index) {
  pushUndo();
  const tracks = getElementTracks(elementId);
  if (!tracks.has(property)) return;
  const kfs = tracks.get(property);
  if (index >= 0 && index < kfs.length) {
    kfs.splice(index, 1);
    if (kfs.length === 0) {
      removeTrack(elementId, property);
    }
    bus.emit('keyframe:deleted', { elementId, property });
  }
}

export function moveKeyframe(elementId, property, index, newTime) {
  pushUndo();
  const tracks = getElementTracks(elementId);
  if (!tracks.has(property)) return;
  const kfs = tracks.get(property);
  if (index < 0 || index >= kfs.length) return;
  newTime = Math.max(0, Math.min(state.duration, newTime));
  const kf = kfs.splice(index, 1)[0];
  kf.time = newTime;
  let newIdx = kfs.findIndex(k => k.time > newTime);
  if (newIdx === -1) newIdx = kfs.length;
  kfs.splice(newIdx, 0, kf);
  bus.emit('keyframe:moved', { elementId, property, oldIndex: index, newIndex: newIdx });
  return newIdx;
}


// ─── Interpolation ───────────────────────────────────────────────
export function interpolateAtTime(keyframes, time) {
  if (!keyframes || keyframes.length === 0) return null;
  if (keyframes.length === 1) return structuredClone(keyframes[0].value);

  // Find surrounding keyframes
  let prev = null, next = null;
  for (let i = 0; i < keyframes.length; i++) {
    if (keyframes[i].time <= time) prev = keyframes[i];
    if (keyframes[i].time >= time && !next) next = keyframes[i];
  }

  if (!prev && next) return structuredClone(next.value);
  if (prev && !next) return structuredClone(prev.value);
  if (!prev && !next) return null;
  if (prev === next) return structuredClone(prev.value);

  const t = (time - prev.time) / (next.time - prev.time);
  return lerpValue(prev.value, next.value, t);
}

function lerpValue(a, b, t) {
  if (typeof a === 'number' && typeof b === 'number') {
    return a + (b - a) * t;
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const result = {};
    for (const key of Object.keys(a)) {
      result[key] = (typeof a[key] === 'number') ? a[key] + (b[key] - a[key]) * t : (t < 0.5 ? a[key] : b[key]);
    }
    return result;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    if (a.startsWith('#') && b.startsWith('#')) return lerpColor(a, b, t);
    // Path / generic string: interpolate all numeric values in-place
    return lerpPathString(a, b, t);
  }
  return t < 0.5 ? a : b;
}

/** Interpolate two SVG path strings by matching up their numeric tokens. */
function lerpPathString(a, b, t) {
  const re = /([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
  const numsA = [...a.matchAll(re)].map(m => parseFloat(m[1]));
  const numsB = [...b.matchAll(re)].map(m => parseFloat(m[1]));
  if (numsA.length !== numsB.length) return t < 0.5 ? a : b;
  let idx = 0;
  return a.replace(re, () => {
    const v = numsA[idx] + (numsB[idx] - numsA[idx]) * t;
    idx++;
    return Math.round(v * 1000) / 1000;
  });
}


function lerpColor(a, b, t) {
  const parse = c => [parseInt(c.slice(1,3),16), parseInt(c.slice(3,5),16), parseInt(c.slice(5,7),16)];
  const [ar,ag,ab] = parse(a.length >= 7 ? a : a + '000000'.slice(a.length - 1));
  const [br,bg,bb] = parse(b.length >= 7 ? b : b + '000000'.slice(b.length - 1));
  const r = Math.round(ar + (br-ar)*t);
  const g = Math.round(ag + (bg-ag)*t);
  const bl = Math.round(ab + (bb-ab)*t);
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${bl.toString(16).padStart(2,'0')}`;
}

// ─── Apply Animation State at Time ──────────────────────────────
export function applyAnimationAtTime(time) {
  for (const [elementId, tracks] of state.animations) {
    const info = state.elements.get(elementId);
    if (!info) continue;
    const el = info.el;

    let tx = 0, ty = 0, sx = 1, sy = 1, rot = 0, skx = 0, sky = 0;
    let ox = null, oy = null;
    let opacity = null, fill = null, morphD = null;
    let hasPosition = false, hasScale = false, hasRotate = false, hasSkew = false;

    for (const [prop, kfs] of tracks) {
      const val = interpolateAtTime(kfs, time);
      if (val === null) continue;
      switch (prop) {
        case 'position': tx = val.x; ty = val.y; hasPosition = true; break;
        case 'scale':    sx = val.x; sy = val.y; hasScale = true; break;
        case 'rotate':   rot = val; hasRotate = true; break;
        case 'skew':     skx = val.x; sky = val.y; hasSkew = true; break;
        case 'origin':   ox = val.x; oy = val.y; break;
        case 'opacity':  opacity = val; break;
        case 'fill':     fill = val; break;
        case 'morph':    morphD = val; break;
      }
    }

    const hasTransform = hasPosition || hasScale || hasRotate || hasSkew;

    if (hasTransform) {
      // Build CSS transform string.
      // Order: translate → rotate → scale → skew
      // (translate is always relative offset; scale/rotate/skew use transform-origin)
      const parts = [];
      if (hasPosition) parts.push(`translate(${tx}px, ${ty}px)`);
      if (hasRotate)   parts.push(`rotate(${rot}deg)`);
      if (hasScale)    parts.push(`scale(${sx}, ${sy})`);
      if (hasSkew)     parts.push(`skewX(${skx}deg) skewY(${sky}deg)`);

      el.style.transform = parts.join(' ');

      // Transform-origin: prefer user-set origin track, otherwise use bbox center
      // so scale/rotate/skew happen around the element's own center.
      if (ox !== null && oy !== null) {
        el.style.transformOrigin = `${ox}px ${oy}px`;
      } else if (hasScale || hasRotate || hasSkew) {
        try {
          const bbox = el.getBBox();
          el.style.transformOrigin = `${bbox.x + bbox.width / 2}px ${bbox.y + bbox.height / 2}px`;
        } catch (_) {
          el.style.transformOrigin = 'center center';
        }
      } else {
        el.style.transformOrigin = '';
      }
    } else {
      el.style.transform = '';
      el.style.transformOrigin = '';
    }

    if (opacity !== null) el.style.opacity = opacity / 100;
    if (fill !== null) el.style.fill = fill;
    if (morphD !== null && el.tagName?.toLowerCase() === 'path') {
      el.setAttribute('d', morphD);
    }
  }
}

// ─── Clear Animation Styles ─────────────────────────────────────
export function clearAnimationStyles() {
  for (const [, info] of state.elements) {
    const el = info.el;
    el.style.transform = '';
    el.style.transformOrigin = '';
    el.style.opacity = '';
    el.style.fill = '';
  }
}

// ─── File I/O ────────────────────────────────────────────────────

function handleFileSelect(e) {

  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    loadSVGString(ev.target.result);
  };
  reader.readAsText(file);
}

export function loadSVGString(svgString) {
  // Reset state
  state.elements.clear();
  state.animations.clear();
  state.selectedId = null;
  state.selectedIds.clear();
  state.selectedKeyframe = null;
  state.selectedTrack = null;
  state.currentTime = 0;
  state.isPlaying = false;
  state.nextId = 1;

  // Parse SVG
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, 'image/svg+xml');
  const svg = doc.querySelector('svg');
  if (!svg) { alert('Invalid SVG file'); return; }

  state.svgSource = svgString;
  state.svgElement = svg;

  // Walk and register all elements
  for (const child of svg.children) {
    walkSVG(child);
  }

  bus.emit('svg:loaded', svg);
}

function saveFile() {
  if (!state.svgElement) { alert('No SVG loaded'); return; }
  const svgString = exportAnimatedSVG();
  const blob = new Blob([svgString], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'animated.svg';
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Project Save / Load ─────────────────────────────────────────

/**
 * Serialize the entire editor state (SVG source + all animations)
 * into a .svgaproj JSON file and trigger download.
 */
function saveProject() {
  if (!state.svgElement) { alert('No SVG loaded'); return; }

  // Serialize animations: Map → plain array
  const animations = [];
  for (const [elementId, tracks] of state.animations) {
    const trackList = [];
    for (const [property, keyframes] of tracks) {
      trackList.push({
        property,
        keyframes: keyframes.map(kf => ({
          time:   kf.time,
          value:  structuredClone(kf.value),
          easing: kf.easing ?? 'linear',
        })),
      });
    }
    if (trackList.length > 0) animations.push({ elementId, tracks: trackList });
  }

  // Temporarily reset animations to base state to avoid baking them into the SVG
  const currentTime = state.currentTime;
  applyAnimationAtTime(0);

  // Clone SVG and strip editor-specific UI (outlines, cursors)
  const clone = state.svgElement.cloneNode(true);
  clone.querySelectorAll('*').forEach(el => {
    el.style.cursor = '';
    el.style.outline = '';
    el.style.outlineOffset = '';
    if (el.getAttribute('style') === '') el.removeAttribute('style');
  });
  
  const currentSvgSource = clone.outerHTML;

  // Restore timeline
  applyAnimationAtTime(currentTime);

  const project = {
    version:    1,
    duration:   state.duration,
    svgSource:  currentSvgSource,
    animations,
  };

  const json = JSON.stringify(project, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'project.svgaproj';
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Restore editor state from a parsed .svgaproj project object.
 * loadSVGString() re-assigns the same element IDs deterministically,
 * so the animation data matches after reload.
 */
function loadProject(project) {
  if (!project?.svgSource) { alert('Invalid project file'); return; }
  if (project.version !== 1) {
    if (!confirm(`Project version ${project.version} may be incompatible. Try anyway?`)) return;
  }

  // 1. Load the SVG — resets state and assigns element IDs
  loadSVGString(project.svgSource);

  // 2. Restore duration
  const dur = Math.max(1, Math.min(120, project.duration || 10));
  state.duration = dur;
  const durInput = document.getElementById('duration-input');
  if (durInput) durInput.value = dur;
  bus.emit('duration:changed');

  // 3. Restore animations (must happen AFTER loadSVGString registers elements)
  state.animations.clear();
  for (const { elementId, tracks } of (project.animations || [])) {
    if (!state.elements.has(elementId)) {
      console.warn(`[loadProject] Element "${elementId}" not found in SVG — skipping track`);
      continue;
    }
    const trackMap = new Map();
    for (const { property, keyframes } of tracks) {
      // Ensure keyframes are sorted by time
      const sorted = [...keyframes].sort((a, b) => a.time - b.time);
      trackMap.set(property, sorted);
    }
    if (trackMap.size > 0) state.animations.set(elementId, trackMap);
  }

  // 4. Refresh UI
  bus.emit('tracks:changed', null);
  applyAnimationAtTime(0);
}

function handleProjectSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = ''; // reset so same file can be re-opened
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const project = JSON.parse(ev.target.result);
      loadProject(project);
    } catch (err) {
      alert('Failed to parse project file: ' + err.message);
    }
  };
  reader.readAsText(file);
}


// ─── Initialization ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // File I/O — SVG
  document.getElementById('btn-open').addEventListener('click', () => {
    const input = document.getElementById('file-input');
    input.value = ''; input.click();
  });
  document.getElementById('file-input').addEventListener('change', handleFileSelect);
  document.getElementById('btn-save').addEventListener('click', saveFile);

  // File I/O — Project
  document.getElementById('btn-save-project').addEventListener('click', saveProject);
  document.getElementById('btn-open-project').addEventListener('click', () => {
    const input = document.getElementById('project-input');
    input.value = ''; input.click();
  });
  document.getElementById('project-input').addEventListener('change', handleProjectSelect);


  // Duration
  const durInput = document.getElementById('duration-input');
  durInput.addEventListener('change', () => {
    state.duration = Math.max(1, Math.min(120, parseInt(durInput.value) || 10));
    durInput.value = state.duration;
    bus.emit('duration:changed');
  });

  // Init modules
  initLayers();
  initCanvas();
  initTimeline();
  initProperties();
  initMorphEditor();

  // Undo/Redo UI Buttons
  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('btn-redo').addEventListener('click', redo);

  // ── Global Ctrl+Z / Ctrl+Y undo/redo ──────────────────────────

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.ctrlKey || e.metaKey) {
      if (e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.code === 'KeyY') {
        e.preventDefault();
        redo();
      } else if (e.code === 'KeyD') {
        e.preventDefault();
        duplicateSelected();
      } else if (e.code === 'KeyG') {
        e.preventDefault();
        if (e.shiftKey) {
          ungroupSelected();
        } else {
          groupSelected();
        }
      }
    } else {
      if (e.code === 'Delete' || e.code === 'Backspace') {
        if (state.selectedIds && state.selectedIds.size > 0) {
          e.preventDefault();
          deleteSelected();
        }
      }
    }
  });



  // Close context menu on outside click
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('context-menu');
    if (!menu.hidden && !menu.contains(e.target)) {
      menu.hidden = true;
    }
  });
  document.addEventListener('contextmenu', (e) => {
    const menu = document.getElementById('context-menu');
    if (!menu.hidden && !menu.contains(e.target)) {
      menu.hidden = true;
    }
  });
});

