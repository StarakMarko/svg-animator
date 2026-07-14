/* ================================================================
   SVG ANIMATOR — Layers Panel
   Tree view, selection, group/ungroup, context menu
   ================================================================ */
import { state, bus, addTrack, removeTrack } from './app.js';

const ICONS = {
  group:    '📁',
  path:     '✦',
  rect:     '▬',
  circle:   '●',
  ellipse:  '◯',
  line:     '╱',
  polyline: '⌇',
  polygon:  '⬠',
  text:     'T',
  image:    '🖼',
  use:      '⊕',
  clipPath: '✂',
  mask:     '🎭',
  default:  '◇',
};

let treeContainer;
let contextMenuTarget = null;

export function initLayers() {
  treeContainer = document.getElementById('layer-tree');

  // Group / Ungroup buttons
  document.getElementById('btn-group').addEventListener('click', groupSelected);
  document.getElementById('btn-ungroup').addEventListener('click', ungroupSelected);

  // Context menu items
  const menu = document.getElementById('context-menu');
  menu.querySelectorAll('.context-menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const type = item.dataset.type;
      if (contextMenuTarget && type) {
        addTrack(contextMenuTarget, type);
      }
      menu.hidden = true;
    });
  });

  // Events
  bus.on('svg:loaded', buildTree);
  bus.on('element:selected', highlightSelected);
  bus.on('tracks:changed', () => buildTree());
}

// ─── Build Layer Tree ────────────────────────────────────────────
function buildTree() {
  treeContainer.innerHTML = '';
  if (!state.svgElement) return;

  // Build from svgElement children
  const fragment = document.createDocumentFragment();

  // Add a root "Canvas" node
  const rootItem = createLayerItem('__canvas__', 'Canvas', 'group', 0, true);
  fragment.appendChild(rootItem);

  // Build children
  for (const child of state.svgElement.children) {
    buildTreeNode(child, fragment, 1);
  }

  treeContainer.appendChild(fragment);
  highlightSelected();
}

function buildTreeNode(el, container, depth) {
  const tag = el.tagName?.toLowerCase();
  if (!tag) return;

  const id = el.id;
  const info = state.elements.get(id);
  if (!info) return;

  const isGroup = tag === 'g';
  const hasChildren = isGroup && el.children.length > 0;
  const hasTracks = state.animations.has(id) && state.animations.get(id).size > 0;

  const item = createLayerItem(id, info.name, info.type, depth, hasChildren);
  container.appendChild(item);

  // Show animation tracks under this element
  if (hasTracks) {
    const tracks = state.animations.get(id);
    for (const [prop] of tracks) {
      const trackItem = createTrackItem(id, prop, depth + 1);
      container.appendChild(trackItem);
    }
  }

  // Recurse into children
  if (isGroup) {
    for (const child of el.children) {
      buildTreeNode(child, container, depth + 1);
    }
  }
}

function createLayerItem(id, name, type, depth, hasChildren) {
  const div = document.createElement('div');
  div.className = 'layer-item';
  div.dataset.id = id;
  if (id === state.selectedId) div.classList.add('selected');

  // Indent
  const indent = document.createElement('span');
  indent.className = 'layer-indent';
  indent.style.width = `${depth * 16}px`;
  div.appendChild(indent);

  // Expand arrow
  const expand = document.createElement('span');
  expand.className = `layer-expand ${hasChildren ? 'expanded' : 'hidden'}`;
  expand.textContent = '▶';
  div.appendChild(expand);

  // Icon
  const icon = document.createElement('span');
  icon.className = `layer-icon ${type === 'group' ? 'group-icon' : ''}`;
  icon.textContent = ICONS[type] || ICONS.default;
  div.appendChild(icon);

  // Name
  const nameSpan = document.createElement('span');
  nameSpan.className = 'layer-name';
  nameSpan.textContent = name;
  div.appendChild(nameSpan);

  // Action buttons
  if (id !== '__canvas__') {
    const actions = document.createElement('div');
    actions.className = 'layer-actions';

    // Add animation button
    const addAnim = document.createElement('button');
    addAnim.className = 'layer-action-btn';
    addAnim.textContent = '+';
    addAnim.title = 'Add animation';
    addAnim.addEventListener('click', (e) => {
      e.stopPropagation();
      showContextMenu(e, id);
    });
    actions.appendChild(addAnim);

    // Lock button
    const info = state.elements.get(id);
    const lockBtn = document.createElement('button');
    lockBtn.className = `layer-action-btn ${info?.locked ? 'locked' : ''}`;
    lockBtn.textContent = info?.locked ? '🔒' : '🔓';
    lockBtn.title = 'Lock / Unlock';
    lockBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleLock(id);
    });
    actions.appendChild(lockBtn);

    // Visibility button
    const visBtn = document.createElement('button');
    visBtn.className = `layer-action-btn ${info?.visible === false ? 'hidden-vis' : 'active'}`;
    visBtn.textContent = info?.visible === false ? '👁‍🗨' : '👁';
    visBtn.title = 'Show / Hide';
    visBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleVisibility(id);
    });
    actions.appendChild(visBtn);

    div.appendChild(actions);
  }

  // Click to select
  div.addEventListener('click', (e) => {
    if (id === '__canvas__') {
      state.selectedId = null;
      bus.emit('element:selected', null);
    } else {
      state.selectedId = id;
      bus.emit('element:selected', id);
    }
  });

  // Right-click context menu
  div.addEventListener('contextmenu', (e) => {
    if (id === '__canvas__') return;
    e.preventDefault();
    showContextMenu(e, id);
  });

  return div;
}

function createTrackItem(elementId, property, depth) {
  const div = document.createElement('div');
  div.className = 'layer-item';
  div.style.opacity = '0.8';
  div.dataset.trackElement = elementId;
  div.dataset.trackProperty = property;

  // Indent
  const indent = document.createElement('span');
  indent.className = 'layer-indent';
  indent.style.width = `${depth * 16}px`;
  div.appendChild(indent);

  // No expand
  const expand = document.createElement('span');
  expand.className = 'layer-expand hidden';
  expand.textContent = '▶';
  div.appendChild(expand);

  // Colored dot
  const dot = document.createElement('span');
  dot.className = `layer-icon`;
  dot.innerHTML = `<span class="track-label-dot ${property}" style="display:inline-block;width:8px;height:8px;border-radius:50%;"></span>`;
  div.appendChild(dot);

  // Name
  const nameSpan = document.createElement('span');
  nameSpan.className = 'layer-name';
  nameSpan.textContent = property.charAt(0).toUpperCase() + property.slice(1);
  nameSpan.style.fontSize = '11px';
  nameSpan.style.fontStyle = 'italic';
  div.appendChild(nameSpan);

  // Remove button
  const actions = document.createElement('div');
  actions.className = 'layer-actions';
  const removeBtn = document.createElement('button');
  removeBtn.className = 'layer-action-btn';
  removeBtn.textContent = '✕';
  removeBtn.title = 'Remove animation track';
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeTrack(elementId, property);
  });
  actions.appendChild(removeBtn);
  div.appendChild(actions);

  // Click to select this track in timeline
  div.addEventListener('click', () => {
    state.selectedId = elementId;
    state.selectedTrack = { elementId, property };
    bus.emit('element:selected', elementId);
    bus.emit('track:selected', { elementId, property });
  });

  return div;
}

// ─── Context Menu ────────────────────────────────────────────────
function showContextMenu(e, elementId) {
  contextMenuTarget = elementId;
  const menu = document.getElementById('context-menu');

  // Disable already-added types
  const tracks = state.animations.get(elementId);
  menu.querySelectorAll('.context-menu-item').forEach(item => {
    const type = item.dataset.type;
    const exists = tracks && tracks.has(type);
    item.style.opacity = exists ? '0.3' : '1';
    item.style.pointerEvents = exists ? 'none' : 'auto';
  });

  menu.hidden = false;
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;

  // Keep menu in viewport
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;
  });
}

// ─── Highlight Selected ─────────────────────────────────────────
function highlightSelected() {
  treeContainer.querySelectorAll('.layer-item').forEach(item => {
    item.classList.toggle('selected', item.dataset.id === state.selectedId);
  });
}

// ─── Lock / Visibility ──────────────────────────────────────────
function toggleLock(id) {
  const info = state.elements.get(id);
  if (!info) return;
  info.locked = !info.locked;
  buildTree();
}

function toggleVisibility(id) {
  const info = state.elements.get(id);
  if (!info) return;
  info.visible = !info.visible;
  info.el.style.display = info.visible ? '' : 'none';
  buildTree();
}

// ─── Group / Ungroup ─────────────────────────────────────────────
function groupSelected() {
  if (!state.selectedId || !state.svgElement) return;
  const info = state.elements.get(state.selectedId);
  if (!info) return;

  const el = info.el;
  const parent = el.parentElement;

  // Create new <g> and wrap the element
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  parent.insertBefore(g, el);
  g.appendChild(el);

  // Re-walk the SVG
  state.elements.clear();
  state.nextId = 1;
  for (const child of state.svgElement.children) {
    import('./app.js').then(m => m.walkSVG(child));
  }

  // Small delay for async import, then rebuild
  setTimeout(() => {
    bus.emit('svg:loaded', state.svgElement);
  }, 50);
}

function ungroupSelected() {
  if (!state.selectedId || !state.svgElement) return;
  const info = state.elements.get(state.selectedId);
  if (!info || info.type !== 'group') return;

  const g = info.el;
  const parent = g.parentElement;

  // Move all children out of the group
  while (g.firstChild) {
    parent.insertBefore(g.firstChild, g);
  }
  parent.removeChild(g);

  // Remove any animations on the group
  state.animations.delete(state.selectedId);
  state.selectedId = null;

  // Re-walk
  state.elements.clear();
  state.nextId = 1;
  for (const child of state.svgElement.children) {
    import('./app.js').then(m => m.walkSVG(child));
  }

  setTimeout(() => {
    bus.emit('svg:loaded', state.svgElement);
  }, 50);
}
