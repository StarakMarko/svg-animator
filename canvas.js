/* ================================================================
   SVG ANIMATOR — Canvas Module
   SVG rendering, element selection, zoom/pan, rulers
   ================================================================ */
import { state, bus } from './app.js';

let viewport, content, rulerH, rulerV;

export function initCanvas() {
  viewport = document.getElementById('canvas-viewport');
  content  = document.getElementById('canvas-content');
  rulerH   = document.getElementById('ruler-h');
  rulerV   = document.getElementById('ruler-v');

  // Zoom with Ctrl+Scroll
  viewport.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      state.zoom = Math.max(0.1, Math.min(5, state.zoom * delta));
      applyZoom();
    }
  }, { passive: false });

  // Events
  bus.on('svg:loaded', renderSVG);
  bus.on('element:selected', updateCanvasSelection);
  bus.on('time:changed', () => {});
}

// ─── Render SVG ──────────────────────────────────────────────────
function renderSVG(svg) {
  content.innerHTML = '';
  state.zoom = 1;

  if (!svg) {
    content.innerHTML = `
      <div id="empty-state">
        <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
          <rect x="8" y="8" width="48" height="48" rx="8" stroke="#555" stroke-width="2" stroke-dasharray="6 4"/>
          <path d="M24 32h16M32 24v16" stroke="#555" stroke-width="2" stroke-linecap="round"/>
        </svg>
        <p>Open an SVG file to start animating</p>
      </div>`;
    return;
  }

  // Clone the SVG and inject into canvas
  const cloned = svg.cloneNode(true);

  // Actually use the original SVG element (so we can animate it in-place)
  content.appendChild(state.svgElement);

  // Make all SVG child elements clickable
  makeClickable(state.svgElement);

  // Render rulers
  renderRulers();
  applyZoom();
}

function getSelectableElement(el) {
  const parentGroup = el.closest('g');
  if (parentGroup && state.elements.has(parentGroup.id)) {
    return parentGroup;
  }
  return el;
}

// ─── Make SVG Elements Clickable ─────────────────────────────────
function makeClickable(svgEl) {
  svgEl.querySelectorAll('*').forEach(el => {
    if (!el.id || !state.elements.has(el.id)) return;
    el.style.cursor = 'pointer';

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetEl = getSelectableElement(el);
      const info = state.elements.get(targetEl.id);
      if (info?.locked) return;
      
      if (e.ctrlKey || e.metaKey) {
        if (state.selectedIds.has(targetEl.id)) {
          state.selectedIds.delete(targetEl.id);
          // If we removed the primary selected element, pick another one
          if (state.selectedId === targetEl.id) {
            state.selectedId = state.selectedIds.size > 0 ? Array.from(state.selectedIds).pop() : null;
          }
        } else {
          state.selectedIds.add(targetEl.id);
          state.selectedId = targetEl.id;
        }
      } else {
        state.selectedIds.clear();
        state.selectedIds.add(targetEl.id);
        state.selectedId = targetEl.id;
      }
      
      bus.emit('element:selected', state.selectedId);
    });

    el.addEventListener('mouseenter', () => {
      const targetEl = getSelectableElement(el);
      const info = state.elements.get(targetEl.id);
      if (info?.locked) return;
      if (!state.selectedIds.has(targetEl.id)) {
        targetEl.style.outline = '1px dashed rgba(74,158,255,0.4)';
        targetEl.style.outlineOffset = '1px';
      }
    });

    el.addEventListener('mouseleave', () => {
      const targetEl = getSelectableElement(el);
      if (!state.selectedIds.has(targetEl.id)) {
        targetEl.style.outline = '';
        targetEl.style.outlineOffset = '';
      }
    });
  });


  // Click on canvas background to deselect
  svgEl.addEventListener('click', (e) => {
    if (e.target === svgEl) {
      state.selectedIds.clear();
      state.selectedId = null;
      bus.emit('element:selected', null);
    }
  });
}

// ─── Canvas Selection Visual ─────────────────────────────────────
function updateCanvasSelection(selectedId) {
  // Clear old highlights
  if (state.svgElement) {
    state.svgElement.querySelectorAll('*').forEach(el => {
      el.style.outline = '';
      el.style.outlineOffset = '';
    });
  }

  // Apply new highlight
  for (const id of state.selectedIds) {
    const info = state.elements.get(id);
    if (info) {
      info.el.style.outline = '2px dashed #4a9eff';
      info.el.style.outlineOffset = '2px';
    }
  }
}

// ─── Zoom ────────────────────────────────────────────────────────
function applyZoom() {
  if (content) {
    content.style.transform = `scale(${state.zoom})`;
    content.style.transformOrigin = 'center center';
  }
  renderRulers();
}

// ─── Rulers ──────────────────────────────────────────────────────
function renderRulers() {
  if (!state.svgElement) return;

  const svgRect = state.svgElement.getBoundingClientRect();
  const viewRect = viewport.getBoundingClientRect();

  // Horizontal ruler
  rulerH.innerHTML = '';
  const hStart = 0;
  const hEnd = Math.max(viewRect.width, svgRect.width * state.zoom);
  const step = calculateRulerStep(state.zoom);

  for (let x = 0; x <= hEnd; x += step) {
    if (x % (step * 5) === 0) {
      // Major tick with label
      const tick = document.createElement('span');
      tick.className = 'ruler-tick';
      tick.style.left = `${x}px`;
      tick.textContent = Math.round(x / state.zoom);
      rulerH.appendChild(tick);

      const line = document.createElement('span');
      line.className = 'ruler-line';
      line.style.left = `${x}px`;
      line.style.height = '10px';
      rulerH.appendChild(line);
    } else {
      // Minor tick
      const line = document.createElement('span');
      line.className = 'ruler-line';
      line.style.left = `${x}px`;
      line.style.height = '5px';
      rulerH.appendChild(line);
    }
  }

  // Vertical ruler
  rulerV.innerHTML = '';
  const vEnd = Math.max(viewRect.height, svgRect.height * state.zoom);

  for (let y = 0; y <= vEnd; y += step) {
    if (y % (step * 5) === 0) {
      const tick = document.createElement('span');
      tick.className = 'ruler-tick';
      tick.style.top = `${y}px`;
      tick.textContent = Math.round(y / state.zoom);
      rulerV.appendChild(tick);

      const line = document.createElement('span');
      line.className = 'ruler-line';
      line.style.top = `${y}px`;
      line.style.width = '10px';
      rulerV.appendChild(line);
    } else {
      const line = document.createElement('span');
      line.className = 'ruler-line';
      line.style.top = `${y}px`;
      line.style.width = '5px';
      rulerV.appendChild(line);
    }
  }
}

function calculateRulerStep(zoom) {
  const base = 10;
  if (zoom >= 2) return base * 5;
  if (zoom >= 1) return base * 10;
  if (zoom >= 0.5) return base * 20;
  return base * 50;
}
