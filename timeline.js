/* ================================================================
   SVG ANIMATOR — Timeline Module
   Ruler, tracks, keyframes, playhead, playback engine
   ================================================================ */
import {
  state, bus, addKeyframe, deleteKeyframe, moveKeyframe,
  interpolateAtTime, applyAnimationAtTime, clearAnimationStyles,
  readElementProperty, addTrack
} from './app.js';

const PX_PER_SEC = 100; // Pixels per second on timeline
let rulerCanvas, tracksContainer, trackLabels, playheadEl, timeDisplay;
let scrollArea;
let animFrameId = null;
let lastTimestamp = null;
let draggingKeyframe = null;
let draggingPlayhead = false;

export function initTimeline() {
  rulerCanvas     = document.getElementById('timeline-ruler-canvas');
  tracksContainer = document.getElementById('tracks-container');
  trackLabels     = document.getElementById('track-labels');
  playheadEl      = document.getElementById('playhead');
  timeDisplay     = document.getElementById('time-display');
  scrollArea      = document.getElementById('timeline-scroll');

  // Transport buttons
  document.getElementById('btn-goto-start').addEventListener('click', gotoStart);
  document.getElementById('btn-play').addEventListener('click', togglePlay);
  document.getElementById('btn-add-keyframe').addEventListener('click', addKeyAtPlayhead);
  document.getElementById('btn-delete-keyframe').addEventListener('click', deleteSelectedKey);

  // Animate dropdown button
  const animateBtn = document.getElementById('btn-animate');
  const animateDropdown = document.getElementById('animate-dropdown');

  animateBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.selectedId) {
      alert('Select an element first');
      return;
    }
    // Toggle dropdown
    const isHidden = animateDropdown.hidden;
    animateDropdown.hidden = !isHidden;

    // Disable already-added types
    if (!isHidden) return;
    const tracks = state.animations.get(state.selectedId);
    animateDropdown.querySelectorAll('.animate-dropdown-item').forEach(item => {
      const type = item.dataset.type;
      const exists = tracks && tracks.has(type);
      item.classList.toggle('disabled', exists);
    });
  });

  animateDropdown.querySelectorAll('.animate-dropdown-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const type = item.dataset.type;
      if (state.selectedId && type) {
        addTrack(state.selectedId, type);
      }
      animateDropdown.hidden = true;
    });
  });

  // Close dropdown on outside click
  document.addEventListener('click', () => { animateDropdown.hidden = true; });

  // Playhead drag on ruler
  rulerCanvas.addEventListener('mousedown', onRulerMouseDown);

  // Playhead element drag
  playheadEl.querySelector('.playhead-head').addEventListener('mousedown', onPlayheadDragStart);

  // Events
  bus.on('svg:loaded', onSVGLoaded);
  bus.on('element:selected', renderTracks);
  bus.on('tracks:changed', renderTracks);
  bus.on('keyframe:added', renderTracks);
  bus.on('keyframe:deleted', renderTracks);
  bus.on('keyframe:moved', renderTracks);
  bus.on('keyframe:updated', renderTracks);
  bus.on('duration:changed', onDurationChanged);

  // Initial render
  renderRuler();
  updatePlayheadPosition();
  updateTimeDisplay();
}

// ─── SVG Loaded ──────────────────────────────────────────────────
function onSVGLoaded() {
  stopPlayback();
  state.currentTime = 0;
  renderRuler();
  renderTracks();
  updatePlayheadPosition();
  updateTimeDisplay();
}

function onDurationChanged() {
  renderRuler();
  renderTracks();
  updatePlayheadPosition();
}

// ─── Ruler ───────────────────────────────────────────────────────
function renderRuler() {
  const totalWidth = state.duration * PX_PER_SEC;
  rulerCanvas.width = Math.max(totalWidth + 60, scrollArea.clientWidth);
  rulerCanvas.height = 26;

  // Also size tracks container
  tracksContainer.style.width = `${rulerCanvas.width}px`;

  const ctx = rulerCanvas.getContext('2d');
  ctx.clearRect(0, 0, rulerCanvas.width, rulerCanvas.height);

  // Background
  ctx.fillStyle = '#1e1e32';
  ctx.fillRect(0, 0, rulerCanvas.width, rulerCanvas.height);

  // Ticks and labels
  const subStep = PX_PER_SEC / 10; // 0.1s subdivision

  for (let px = 0; px <= totalWidth; px += subStep) {
    const time = px / PX_PER_SEC;
    const x = px + 0.5;
    const isSecond = Math.abs(time - Math.round(time)) < 0.001;
    const isHalfSecond = Math.abs(time * 2 - Math.round(time * 2)) < 0.001;

    ctx.beginPath();
    ctx.moveTo(x, rulerCanvas.height);

    if (isSecond) {
      ctx.lineTo(x, 6);
      ctx.strokeStyle = '#555570';
      ctx.lineWidth = 1;

      // Label
      ctx.fillStyle = '#8888a0';
      ctx.font = '10px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.round(time)}s`, x, 13);
    } else if (isHalfSecond) {
      ctx.lineTo(x, 16);
      ctx.strokeStyle = '#3a3a55';
      ctx.lineWidth = 0.5;
    } else {
      ctx.lineTo(x, 20);
      ctx.strokeStyle = '#2a2a44';
      ctx.lineWidth = 0.5;
    }
    ctx.stroke();
  }

  // Bottom border
  ctx.beginPath();
  ctx.moveTo(0, rulerCanvas.height - 0.5);
  ctx.lineTo(rulerCanvas.width, rulerCanvas.height - 0.5);
  ctx.strokeStyle = '#262640';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ─── Tracks ──────────────────────────────────────────────────────
function renderTracks() {
  trackLabels.innerHTML = '';
  tracksContainer.innerHTML = '';

  if (!state.selectedId) {
    // Show all animated elements' tracks
    renderAllTracks();
    return;
  }

  // Show tracks for the selected element
  const tracks = state.animations.get(state.selectedId);
  if (!tracks || tracks.size === 0) {
    trackLabels.innerHTML = '<div class="no-selection-msg" style="padding-top:30px;">No animation tracks.<br>Right-click a layer to add.</div>';
    return;
  }

  for (const [property, keyframes] of tracks) {
    createTrackRow(state.selectedId, property, keyframes);
  }

  updatePlayheadPosition();
}

function renderAllTracks() {
  if (state.animations.size === 0) {
    trackLabels.innerHTML = '<div class="no-selection-msg" style="padding-top:30px;">No animations yet.<br>Select an element and add tracks.</div>';
    return;
  }

  for (const [elementId, tracks] of state.animations) {
    const info = state.elements.get(elementId);
    if (!info) continue;

    // Element header in labels
    const header = document.createElement('div');
    header.className = 'track-label';
    header.style.fontWeight = '700';
    header.style.color = '#e6e8ee';
    header.innerHTML = `<span class="track-label-name">${info.name}</span>`;
    header.style.cursor = 'pointer';
    header.addEventListener('click', () => {
      state.selectedId = elementId;
      bus.emit('element:selected', elementId);
    });
    trackLabels.appendChild(header);

    // Empty track row for header spacing
    const headerRow = document.createElement('div');
    headerRow.className = 'track-row';
    headerRow.style.background = 'rgba(74,158,255,0.05)';
    tracksContainer.appendChild(headerRow);

    for (const [property, keyframes] of tracks) {
      createTrackRow(elementId, property, keyframes);
    }
  }

  updatePlayheadPosition();
}

function createTrackRow(elementId, property, keyframes) {
  // Label
  const label = document.createElement('div');
  label.className = `track-label ${state.selectedTrack?.elementId === elementId && state.selectedTrack?.property === property ? 'selected' : ''}`;
  label.innerHTML = `
    <span class="track-label-dot ${property}"></span>
    <span class="track-label-name">${property.charAt(0).toUpperCase() + property.slice(1)}</span>
    <button class="track-label-remove" title="Remove track">✕</button>
  `;
  label.addEventListener('click', () => {
    state.selectedTrack = { elementId, property };
    renderTracks();
  });
  label.querySelector('.track-label-remove').addEventListener('click', (e) => {
    e.stopPropagation();
    import('./app.js').then(m => m.removeTrack(elementId, property));
  });
  trackLabels.appendChild(label);

  // Track row with keyframes
  const row = document.createElement('div');
  row.className = 'track-row';
  row.dataset.elementId = elementId;
  row.dataset.property = property;

  // Double-click to add keyframe
  row.addEventListener('dblclick', (e) => {
    const rect = row.getBoundingClientRect();
    const x = e.clientX - rect.left + scrollArea.scrollLeft;
    const time = Math.max(0, Math.min(state.duration, x / PX_PER_SEC));
    const value = interpolateAtTime(keyframes, time) ?? readElementProperty(elementId, property);
    addKeyframe(elementId, property, time, value);
  });

  // Render keyframe diamonds
  keyframes.forEach((kf, idx) => {
    const diamond = document.createElement('div');
    diamond.className = 'keyframe';
    diamond.style.left = `${kf.time * PX_PER_SEC}px`;
    diamond.dataset.index = idx;

    // Selected state
    if (state.selectedKeyframe &&
        state.selectedKeyframe.elementId === elementId &&
        state.selectedKeyframe.property === property &&
        state.selectedKeyframe.index === idx) {
      diamond.classList.add('selected');
    }

    // Click to select keyframe
    diamond.addEventListener('click', (e) => {
      e.stopPropagation();
      state.selectedKeyframe = { elementId, property, index: idx };
      state.currentTime = kf.time;
      updatePlayheadPosition();
      updateTimeDisplay();
      bus.emit('keyframe:selected', state.selectedKeyframe);
      renderTracks();
    });

    // Drag to move
    diamond.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      draggingKeyframe = { elementId, property, index: idx, startX: e.clientX, startTime: kf.time };
      diamond.classList.add('dragging');

      const onMove = (ev) => {
        const dx = ev.clientX - draggingKeyframe.startX;
        const newTime = Math.max(0, Math.min(state.duration, draggingKeyframe.startTime + dx / PX_PER_SEC));
        diamond.style.left = `${newTime * PX_PER_SEC}px`;
      };

      const onUp = (ev) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        diamond.classList.remove('dragging');

        const dx = ev.clientX - draggingKeyframe.startX;
        const newTime = Math.max(0, Math.min(state.duration, draggingKeyframe.startTime + dx / PX_PER_SEC));
        const newIdx = moveKeyframe(elementId, property, draggingKeyframe.index, newTime);
        state.selectedKeyframe = { elementId, property, index: newIdx };
        draggingKeyframe = null;
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    row.appendChild(diamond);
  });

  tracksContainer.appendChild(row);
}

// ─── Playhead ────────────────────────────────────────────────────
function updatePlayheadPosition() {
  const x = state.currentTime * PX_PER_SEC;
  playheadEl.style.left = `${x}px`;
}

function updateTimeDisplay() {
  const t = state.currentTime;
  const min = Math.floor(t / 60);
  const sec = Math.floor(t % 60);
  const ms = Math.floor((t % 1) * 100);
  timeDisplay.textContent = `${min}:${sec.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

function onRulerMouseDown(e) {
  const rect = rulerCanvas.getBoundingClientRect();
  const setTime = (ev) => {
    const x = ev.clientX - rect.left + scrollArea.scrollLeft;
    state.currentTime = Math.max(0, Math.min(state.duration, x / PX_PER_SEC));
    updatePlayheadPosition();
    updateTimeDisplay();
    applyAnimationAtTime(state.currentTime);
    bus.emit('time:changed', state.currentTime);
  };

  setTime(e);

  const onMove = (ev) => setTime(ev);
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function onPlayheadDragStart(e) {
  e.preventDefault();
  draggingPlayhead = true;
  const rulerRect = rulerCanvas.getBoundingClientRect();

  const onMove = (ev) => {
    const x = ev.clientX - rulerRect.left + scrollArea.scrollLeft;
    state.currentTime = Math.max(0, Math.min(state.duration, x / PX_PER_SEC));
    updatePlayheadPosition();
    updateTimeDisplay();
    applyAnimationAtTime(state.currentTime);
    bus.emit('time:changed', state.currentTime);
  };

  const onUp = () => {
    draggingPlayhead = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ─── Transport ───────────────────────────────────────────────────
function gotoStart() {
  state.currentTime = 0;
  updatePlayheadPosition();
  updateTimeDisplay();
  applyAnimationAtTime(0);
  bus.emit('time:changed', 0);
}

function togglePlay() {
  if (state.isPlaying) {
    stopPlayback();
  } else {
    startPlayback();
  }
}

function startPlayback() {
  if (state.animations.size === 0) return;
  state.isPlaying = true;
  lastTimestamp = performance.now();
  const btn = document.getElementById('btn-play');
  btn.textContent = '⏸';
  btn.classList.add('playing');
  animFrameId = requestAnimationFrame(tick);
}

function stopPlayback() {
  state.isPlaying = false;
  const btn = document.getElementById('btn-play');
  btn.textContent = '▶';
  btn.classList.remove('playing');
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
}

function tick(timestamp) {
  if (!state.isPlaying) return;

  const dt = (timestamp - lastTimestamp) / 1000;
  lastTimestamp = timestamp;

  state.currentTime += dt;
  if (state.currentTime >= state.duration) {
    state.currentTime = 0; // loop
  }

  applyAnimationAtTime(state.currentTime);
  updatePlayheadPosition();
  updateTimeDisplay();

  animFrameId = requestAnimationFrame(tick);
}

// ─── Add / Delete Keyframe at Playhead ───────────────────────────
function addKeyAtPlayhead() {
  if (!state.selectedId) {
    alert('Select an element first');
    return;
  }

  const tracks = state.animations.get(state.selectedId);
  if (!tracks || tracks.size === 0) {
    alert('Add an animation track first (right-click on layer)');
    return;
  }

  // Add keyframe to all tracks of selected element at current time
  for (const [property, keyframes] of tracks) {
    const value = interpolateAtTime(keyframes, state.currentTime) ?? readElementProperty(state.selectedId, property);
    addKeyframe(state.selectedId, property, state.currentTime, structuredClone(value));
  }
}

function deleteSelectedKey() {
  if (!state.selectedKeyframe) {
    alert('Select a keyframe first');
    return;
  }
  const { elementId, property, index } = state.selectedKeyframe;
  deleteKeyframe(elementId, property, index);
  state.selectedKeyframe = null;
}

// ─── Keyboard shortcuts ──────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      togglePlay();
      break;
    case 'Delete':
    case 'Backspace':
      if (state.selectedKeyframe) {
        deleteSelectedKey();
      }
      break;
    case 'Home':
      gotoStart();
      break;
  }
});
