/* ================================================================
   SVG ANIMATOR — Properties Panel
   Property display & editing at selected keyframe / current time
   ================================================================ */
import {
  state, bus, interpolateAtTime, addKeyframe, readElementProperty,
  applyAnimationAtTime, pushUndo
} from './app.js';

// DOM refs
let posX, posY, originX, originY, scaleX, scaleY, skewX, skewY;
let rotateTurns, rotateDeg, opacitySlider, opacityVal;
let fillColor, fillHex, lockScaleBtn;

// Undo tracking
let _isEditingProp = false;


export function initProperties() {
  posX         = document.getElementById('prop-pos-x');
  posY         = document.getElementById('prop-pos-y');
  originX      = document.getElementById('prop-origin-x');
  originY      = document.getElementById('prop-origin-y');
  scaleX       = document.getElementById('prop-scale-x');
  scaleY       = document.getElementById('prop-scale-y');
  skewX        = document.getElementById('prop-skew-x');
  skewY        = document.getElementById('prop-skew-y');
  rotateTurns  = document.getElementById('prop-rotate-turns');
  rotateDeg    = document.getElementById('prop-rotate-deg');
  opacitySlider= document.getElementById('prop-opacity-slider');
  opacityVal   = document.getElementById('prop-opacity-val');
  fillColor    = document.getElementById('prop-fill-color');
  fillHex      = document.getElementById('prop-fill-hex');
  lockScaleBtn = document.getElementById('btn-lock-scale');

  // Bind input handlers
  bindPairInputs(posX, posY, 'position', (x, y) => ({ x, y }));
  bindPairInputs(originX, originY, 'origin', (x, y) => ({ x, y }));
  bindPairInputs(skewX, skewY, 'skew', (x, y) => ({ x, y }));

  // Scale with lock
  const onScaleChange = () => {
    const x = parseFloat(scaleX.value) || 1;
    const y = parseFloat(scaleY.value) || 1;
    if (state.scaleLocked) {
      if (document.activeElement === scaleX) scaleY.value = x;
      if (document.activeElement === scaleY) scaleX.value = y;
    }
    updateProperty('scale', {
      x: parseFloat(scaleX.value) || 1,
      y: parseFloat(scaleY.value) || 1
    });
  };
  scaleX.addEventListener('input', onScaleChange);
  scaleY.addEventListener('input', onScaleChange);

  lockScaleBtn.addEventListener('click', () => {
    state.scaleLocked = !state.scaleLocked;
    lockScaleBtn.classList.toggle('active', state.scaleLocked);
    lockScaleBtn.textContent = state.scaleLocked ? '🔗' : '⛓️‍💥';
  });

  // Rotate
  const onRotateChange = () => {
    const turns = parseInt(rotateTurns.value) || 0;
    const deg = parseFloat(rotateDeg.value) || 0;
    updateProperty('rotate', turns * 360 + deg);
  };
  rotateTurns.addEventListener('input', onRotateChange);
  rotateDeg.addEventListener('input', onRotateChange);

  // Opacity
  opacitySlider.addEventListener('input', () => {
    opacityVal.value = opacitySlider.value;
    updateProperty('opacity', parseFloat(opacitySlider.value));
  });
  opacityVal.addEventListener('input', () => {
    opacitySlider.value = opacityVal.value;
    updateProperty('opacity', parseFloat(opacityVal.value));
  });

  // Fill
  fillColor.addEventListener('input', () => {
    fillHex.value = fillColor.value.slice(1);
    updateProperty('fill', fillColor.value);
  });
  fillHex.addEventListener('input', () => {
    let hex = fillHex.value.replace(/[^0-9a-fA-F]/g, '');
    if (hex.length === 6) {
      fillColor.value = `#${hex}`;
      updateProperty('fill', `#${hex}`);
    }
  });

  // Events
  bus.on('element:selected', refreshProperties);
  bus.on('keyframe:selected', refreshProperties);
  bus.on('time:changed', refreshProperties);
  bus.on('tracks:changed', refreshProperties);

  // Undo Tracking for Inputs
  const panel = document.getElementById('properties-panel');
  panel.addEventListener('mousedown', trackEditStart, true);
  panel.addEventListener('focus', trackEditStart, true);
  panel.addEventListener('change', trackEditEnd, true);
  panel.addEventListener('blur', trackEditEnd, true);
}

function trackEditStart(e) {
  if (e.target.tagName !== 'INPUT') return;
  if (!_isEditingProp) {
    pushUndo();
    _isEditingProp = true;
  }
}

function trackEditEnd(e) {
  if (e.target.tagName !== 'INPUT') return;
  _isEditingProp = false;
}


// ─── Bind Pair Inputs (x, y) ─────────────────────────────────────
function bindPairInputs(inputX, inputY, property, valueFn) {
  const handler = () => {
    const x = parseFloat(inputX.value) || 0;
    const y = parseFloat(inputY.value) || 0;
    updateProperty(property, valueFn(x, y));
  };
  inputX.addEventListener('input', handler);
  inputY.addEventListener('input', handler);
}

// ─── Update Property ─────────────────────────────────────────────
function updateProperty(property, value) {
  if (!state.selectedId) return;

  const tracks = state.animations.get(state.selectedId);
  if (!tracks || !tracks.has(property)) return;

  // Update or create keyframe at current time
  addKeyframe(state.selectedId, property, state.currentTime, structuredClone(value));

  // Apply immediately on canvas
  applyAnimationAtTime(state.currentTime);
}

// ─── Refresh Properties Display ──────────────────────────────────
function refreshProperties() {
  if (!state.selectedId) {
    clearInputs();
    return;
  }

  const tracks = state.animations.get(state.selectedId);

  // Position
  const pos = getValueAtTime(tracks, 'position', state.currentTime) ||
              readElementProperty(state.selectedId, 'position');
  if (pos && typeof pos === 'object') {
    posX.value = round(pos.x);
    posY.value = round(pos.y);
  }

  // Origin
  const origin = getValueAtTime(tracks, 'origin', state.currentTime) ||
                 readElementProperty(state.selectedId, 'origin');
  if (origin && typeof origin === 'object') {
    originX.value = round(origin.x);
    originY.value = round(origin.y);
  }

  // Scale
  const scale = getValueAtTime(tracks, 'scale', state.currentTime) ||
                readElementProperty(state.selectedId, 'scale');
  if (scale && typeof scale === 'object') {
    scaleX.value = round(scale.x);
    scaleY.value = round(scale.y);
  }

  // Skew
  const skew = getValueAtTime(tracks, 'skew', state.currentTime) ||
               readElementProperty(state.selectedId, 'skew');
  if (skew && typeof skew === 'object') {
    skewX.value = round(skew.x);
    skewY.value = round(skew.y);
  }

  // Rotate
  const rot = getValueAtTime(tracks, 'rotate', state.currentTime) ??
              readElementProperty(state.selectedId, 'rotate');
  if (typeof rot === 'number') {
    rotateTurns.value = Math.floor(rot / 360);
    rotateDeg.value = round(rot % 360);
  }

  // Opacity
  const opa = getValueAtTime(tracks, 'opacity', state.currentTime) ??
              readElementProperty(state.selectedId, 'opacity');
  if (typeof opa === 'number') {
    opacitySlider.value = round(opa);
    opacityVal.value = round(opa);
  }

  // Fill
  const fill = getValueAtTime(tracks, 'fill', state.currentTime) ||
               readElementProperty(state.selectedId, 'fill');
  if (typeof fill === 'string' && fill.startsWith('#')) {
    fillColor.value = fill.length >= 7 ? fill : fill + '000000'.slice(fill.length - 1);
    fillHex.value = fill.slice(1);
  }
}

function getValueAtTime(tracks, property, time) {
  if (!tracks || !tracks.has(property)) return null;
  return interpolateAtTime(tracks.get(property), time);
}

function clearInputs() {
  posX.value = ''; posY.value = '';
  originX.value = ''; originY.value = '';
  scaleX.value = 1; scaleY.value = 1;
  skewX.value = 0; skewY.value = 0;
  rotateTurns.value = 0; rotateDeg.value = 0;
  opacitySlider.value = 100; opacityVal.value = 100;
  fillColor.value = '#000000'; fillHex.value = '000000';
}

function round(n) {
  return Math.round(n * 100) / 100;
}
