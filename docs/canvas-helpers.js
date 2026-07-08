// Shared canvas/SVG utilities for sss-demo.js and buss-demo.js.
// Both demos use the same star-map canvas; they differ only in:
//   - which state object they carry (state vs bstate)
//   - the DOM ID prefix used for SVG elements ('' vs 'b-')
//   - the legend labels and WASM-specific logic (handled in each file)

import { CONSTELLATIONS } from './constellations.js';

export const SVG_NS = 'http://www.w3.org/2000/svg';
export const W = 1060, H = 800, CX = 530, CY = 400;

export function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

export function seed() {
  const s = new Uint8Array(32);
  crypto.getRandomValues(s);
  return s;
}

export function shuffleArr(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

export function trimHex(h) { return h.slice(0, 8) + '…' + h.slice(-6); }

export function nodeRadius(ringTotal, isGuardian) {
  const gr = ringTotal <= 9 ? 32 : ringTotal <= 14 ? 26 : 20;
  return isGuardian ? gr : Math.round(gr * 0.7);
}

export function pulseNode(id) {
  const el = document.querySelector(`#${id} .node-circle`);
  if (!el) return;
  el.classList.add('node-pulse');
  setTimeout(() => el.classList.remove('node-pulse'), 700);
}

export function appendPanelEntry(el, html) {
  if (el.innerHTML.trim() !== '') {
    el.insertAdjacentHTML('beforeend', '<div style="border-top:1px solid var(--sep);margin:0.55rem 0 0.6rem"></div>');
  }
  el.insertAdjacentHTML('beforeend', html);
  el.scrollTop = el.scrollHeight;
}

// ── Legend data & HTML builder ────────────────────────────────────────────────

export const SSS_LEGEND = [
  { label: 'Honest guardian',          stroke: '#06FF89', isCircle: true },
  { label: 'Corrupt guardian',       stroke: '#ff8800', isCircle: true },
  { label: 'Corrupt peer',   stroke: '#ff4444', isCircle: true, dim: true },
  { label: 'Honest peer',           stroke: '#888',    isCircle: true, dim: true },
  { label: 'Secure channel', stroke: '#16E9D8', isDouble: true },
  { label: 'Honest share (sent)',    stroke: '#36d399', isDot: true },
  { label: 'Corrupt share (sent)',   stroke: '#ff4444', isDot: true },
];

export const BUSS_LEGEND = [
  { label: 'Honest guardian',           stroke: '#06FF89', isCircle: true },
  { label: 'Corrupt guardian',        stroke: '#ff8800', isCircle: true },
  { label: 'Corrupt peer',    stroke: '#ff4444', isCircle: true, dim: true },
  { label: 'Honest peer',            stroke: '#888',    isCircle: true, dim: true },
  { label: 'Secure channel', stroke: '#16E9D8', isDouble: true },
  { label: 'Honest share (sent)',         stroke: '#36d399', isDot: true },
  { label: 'Corrupt share (sent)',        stroke: '#ff4444', isDot: true },
  { label: 'Blockchain',          stroke: '#FFBA36', isBoard: true },
];

export function buildLegend(container, items) {
  container.innerHTML = '<span class="demo-legend-title">Legend</span><span class="demo-legend-items">' + items.map(({ label, stroke, isCircle, isDouble, isDot, isBoard, dim }) => {
    let icon;
    if (isCircle) {
      icon = `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="${stroke}" stroke-width="1.5"${dim ? ' opacity="0.4"' : ''}/></svg>`;
    } else if (isDot) {
      icon = `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="${stroke}"/></svg>`;
    } else if (isBoard) {
      icon = `<svg width="20" height="14" viewBox="0 0 20 14"><rect x="0" y="0" width="20" height="14" rx="2" fill="none" stroke="${stroke}" stroke-width="1.2" opacity="0.9"/><rect x="0" y="0" width="20" height="5" rx="2" fill="${stroke}" opacity="0.25"/><rect x="0" y="3" width="20" height="2" fill="${stroke}" opacity="0.25"/><circle cx="4" cy="2.5" r="1.3" fill="${stroke}" opacity="0.7"/><circle cx="16" cy="2.5" r="1.3" fill="${stroke}" opacity="0.7"/></svg>`;
    } else {
      icon = `<svg width="24" height="10" viewBox="0 0 24 10"><line x1="0" y1="2.5" x2="24" y2="2.5" stroke="${stroke}" stroke-width="1" stroke-dasharray="5 4" opacity="0.7"/><line x1="0" y1="7.5" x2="24" y2="7.5" stroke="${stroke}" stroke-width="1" stroke-dasharray="5 4" opacity="0.7"/></svg>`;
    }
    return `<span class="demo-legend-item${dim ? ' demo-legend-dim' : ''}">${icon}${label}</span>`;
  }).join('') + '</span>';
}

// ── State-parameterised constellation helpers ─────────────────────────────────

export function pickConst(st, ringNodes) {
  const opts = CONSTELLATIONS[ringNodes] || CONSTELLATIONS[2];
  return opts[st.constIdx ?? 0] || opts[0];
}

const _normCache = new WeakMap();

function normalizedStars(c) {
  if (_normCache.has(c)) return _normCache.get(c);
  const xs = c.stars.map(s => s[0]);
  const ys = c.stars.map(s => s[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = 88;
  const scaleX = maxX > minX ? (W - 2 * pad) / (maxX - minX) : 1;
  const scaleY = maxY > minY ? (H - 2 * pad) / (maxY - minY) : 1;
  // Minimum clearance from the owner node at (CX, CY):
  // largest guardian radius (32) + owner radius (17) + 21px gap = 70px.
  const CLEAR = 70;
  const norm = c.stars.map(([x, y]) => {
    let nx = pad + (x - minX) * scaleX;
    let ny = pad + (y - minY) * scaleY;
    const dx = nx - CX, dy = ny - CY;
    const dist = Math.hypot(dx, dy);
    if (dist < CLEAR) {
      if (dist < 1) { nx = CX + CLEAR; ny = CY; }
      else { const s = CLEAR / dist; nx = CX + dx * s; ny = CY + dy * s; }
    }
    return [nx, ny];
  });
  _normCache.set(c, norm);
  return norm;
}

export function nodePos(st, ringIdx, total) {
  const c = pickConst(st, total);
  const stars = normalizedStars(c);
  const star = stars[ringIdx % stars.length];
  return { x: star[0], y: star[1] };
}

// ── Prefix-parameterised DOM helpers ─────────────────────────────────────────
// Each function takes `prefix` so both demos can share them:
// SSS uses prefix '', BUSS uses prefix 'b-'.

export function showShareLabel(prefix, i, text, fill) {
  const el = document.getElementById(`${prefix}share-label-${i}`);
  if (!el) return;
  el.textContent = text;
  if (fill) el.setAttribute('fill', fill);
  el.setAttribute('opacity', '0');
  el.style.transition = 'opacity 0.4s';
  requestAnimationFrame(() => el.setAttribute('opacity', '1'));
}

export function hideShareLabel(prefix, i) {
  const el = document.getElementById(`${prefix}share-label-${i}`);
  if (el) el.setAttribute('opacity', '0');
}

export function showSendLabel(prefix, i, text, fill) {
  const el = document.getElementById(`${prefix}send-label-${i}`);
  if (!el) return;
  el.textContent = text;
  el.setAttribute('fill', fill || 'currentColor');
  el.setAttribute('opacity', '0');
  el.style.transition = 'opacity 0.4s';
  requestAnimationFrame(() => el.setAttribute('opacity', '1'));
}

export function hideSendLabel(prefix, i) {
  const el = document.getElementById(`${prefix}send-label-${i}`);
  if (el) el.setAttribute('opacity', '0');
}

export function showBadge(prefix, i, text, isCorrupt) {
  const el = document.getElementById(`${prefix}badge-${i}`);
  if (!el) return;
  el.textContent = text;
  el.setAttribute('fill', isCorrupt ? '#ff4444' : '#36d399');
  el.setAttribute('opacity', '0');
  requestAnimationFrame(() => el.setAttribute('opacity', '0.9'));
}

export function hideBadge(prefix, i) {
  const el = document.getElementById(`${prefix}badge-${i}`);
  if (el) el.setAttribute('opacity', '0');
}

export function showOwnerSubLabel(prefix, text) {
  const el = document.getElementById(`${prefix}owner-label`);
  if (!el) return;
  el.textContent = text;
  el.setAttribute('opacity', '0');
  setTimeout(() => el.setAttribute('opacity', '0.7'), 50);
}

export function hideOwnerSubLabel(prefix) {
  const el = document.getElementById(`${prefix}owner-label`);
  if (el) el.setAttribute('opacity', '0');
}

// ── Packet animation ──────────────────────────────────────────────────────────

// Multiplies every packet's travel time — one dial to retune the whole
// demo's pacing without touching each animatePacket() call site.
const PACKET_SPEED_SCALE = 5.0;

export function animatePacket(layerId, fromX, fromY, toX, toY, duration, color, onDone) {
  const layer = document.getElementById(layerId);
  if (!layer) return;
  const dot = svg('circle', { r: 6, fill: color || 'var(--electric-blue)', opacity: '0.9' });
  layer.appendChild(dot);
  const scaledDuration = duration * PACKET_SPEED_SCALE;
  const start = performance.now();
  function frame(now) {
    const raw = Math.min((now - start) / scaledDuration, 1);
    const t = easeInOut(raw);
    dot.setAttribute('cx', fromX + (toX - fromX) * t);
    dot.setAttribute('cy', fromY + (toY - fromY) * t);
    if (raw < 1) { requestAnimationFrame(frame); }
    else { dot.remove(); onDone?.(); }
  }
  requestAnimationFrame(frame);
}

// ── Shared canvas builder ─────────────────────────────────────────────────────
// All SVG element IDs are prefixed with `prefix` so two demos can coexist
// on the same page without ID collisions.  legendItems controls the bottom-right
// legend; addArrow adds an SVG arrowhead marker (used by SSS only).

export function buildCanvas(container, st, { prefix = '', addArrow = false }) {
  container.innerHTML = '';
  const numGuardians = st.n - 1;
  const ringNodes = Math.max(st.networkSize - 1, numGuardians);

  if (st.prevRingNodes !== ringNodes) {
    st.prevRingNodes = ringNodes;
    const opts = CONSTELLATIONS[ringNodes] || CONSTELLATIONS[2];
    st.constIdx = Math.floor(Math.random() * opts.length);
  }

  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%' });

  const defs = svg('defs', {});
  if (addArrow) {
    const marker = svg('marker', {
      id: 'arrow', markerWidth: '8', markerHeight: '8',
      refX: '6', refY: '3', orient: 'auto',
    });
    marker.appendChild(svg('path', { d: 'M0,0 L0,6 L8,3 z', fill: 'var(--electric-blue)', opacity: '0.6' }));
    defs.appendChild(marker);
  }
  s.appendChild(defs);

  // Incremental guardian ring assignment — keep valid existing positions
  const available = new Set(Array.from({ length: ringNodes }, (_, i) => i));
  const stable = st.guardianRingIndices.filter(ri => ri < ringNodes);
  stable.forEach(ri => available.delete(ri));
  while (stable.length < numGuardians && available.size > 0) {
    const avArr = [...available];
    const pick = avArr[Math.floor(Math.random() * avArr.length)];
    stable.push(pick);
    available.delete(pick);
  }
  st.guardianRingIndices = stable.slice(0, numGuardians);
  const guardianRingSet = new Set(st.guardianRingIndices);

  // Corrupt ring assignment — independent of guardian assignment
  const corruptTarget = Math.min(st.corruptCount, ringNodes);
  const stableCorrupt = st.corruptRingIndices.filter(ri => ri < ringNodes);
  if (stableCorrupt.length > corruptTarget) {
    stableCorrupt.splice(corruptTarget);
  } else if (stableCorrupt.length < corruptTarget) {
    const used = new Set(stableCorrupt);
    const avail = shuffleArr(
      Array.from({ length: ringNodes }, (_, i) => i).filter(i => !used.has(i))
    );
    stableCorrupt.push(...avail.slice(0, corruptTarget - stableCorrupt.length));
  }
  st.corruptRingIndices = stableCorrupt;
  const corruptRingSet = new Set(stableCorrupt);
  st.corrupt = st.guardianRingIndices
    .map((ri, gi) => corruptRingSet.has(ri) ? gi : -1)
    .filter(gi => gi >= 0);

  // Constellation stick-figure lines — drawn behind everything
  const constDef = pickConst(st, ringNodes);
  if (constDef?.lines) {
    const gConst = svg('g', {
      id: `${prefix}constellation`, fill: 'none', 'stroke-linecap': 'round',
      stroke: '#888', 'stroke-width': '1.5', opacity: '0.6',
    });
    for (const [a, b] of constDef.lines) {
      const pa = nodePos(st, a, ringNodes);
      const pb = nodePos(st, b, ringNodes);
      const ra = nodeRadius(ringNodes, guardianRingSet.has(a));
      const rb = nodeRadius(ringNodes, guardianRingSet.has(b));
      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < ra + rb) continue;
      const ux = dx / len, uy = dy / len;
      gConst.appendChild(svg('line', {
        x1: pa.x + ux * ra, y1: pa.y + uy * ra,
        x2: pb.x - ux * rb, y2: pb.y - uy * rb,
      }));
    }
    s.appendChild(gConst);
  }

  // Channel lines — double lines for guardian secure channels
  const gLines = svg('g', { id: `${prefix}lines` });
  for (let ri = 0; ri < ringNodes; ri++) {
    const isGuardian = guardianRingSet.has(ri);
    const isCorrupt  = corruptRingSet.has(ri);
    const pos = nodePos(st, ri, ringNodes);
    const dx = pos.x - CX, dy = pos.y - CY;
    const len = Math.sqrt(dx * dx + dy * dy);
    const nx = -dy / len, ny = dx / len;
    if (isGuardian) {
      const o = 3.5;
      const chClass = isCorrupt ? 'guardian-channel corrupt-channel' : 'guardian-channel';
      gLines.appendChild(svg('line', { x1: CX + nx * o, y1: CY + ny * o, x2: pos.x + nx * o, y2: pos.y + ny * o, class: chClass }));
      gLines.appendChild(svg('line', { x1: CX - nx * o, y1: CY - ny * o, x2: pos.x - nx * o, y2: pos.y - ny * o, class: chClass }));
    } else {
      gLines.appendChild(svg('line', { x1: CX, y1: CY, x2: pos.x, y2: pos.y, class: 'network-channel' }));
    }
  }
  s.appendChild(gLines);
  s.appendChild(svg('g', { id: `${prefix}packets` }));

  const gNodes = svg('g', { id: `${prefix}nodes` });

  // Owner node
  const ownerG = svg('g', { id: `${prefix}node-owner`, class: 'demo-node owner-node', cursor: 'default' });
  ownerG.appendChild(svg('circle', { cx: CX, cy: CY, r: 17, class: 'node-circle owner-circle' }));
  const ownerLabel = svg('text', { x: CX, y: CY + 1, class: 'node-label', 'text-anchor': 'middle', 'dominant-baseline': 'middle', style: 'font-size:10px' });
  ownerLabel.textContent = 'You';
  ownerG.appendChild(ownerLabel);
  const ownerSub = svg('text', {
    id: `${prefix}owner-label`, x: CX, y: CY + 28, class: 'node-sub',
    'text-anchor': 'middle', 'dominant-baseline': 'middle', opacity: '0',
  });
  ownerG.appendChild(ownerSub);
  gNodes.appendChild(ownerG);

  // Network peer nodes — drawn before guardians so guardians render on top
  let peerIdx = 1;
  for (let ri = 0; ri < ringNodes; ri++) {
    if (guardianRingSet.has(ri)) continue;
    const pos = nodePos(st, ri, ringNodes);
    const r = nodeRadius(ringNodes, false);
    const isCorrupt = corruptRingSet.has(ri);
    const g = svg('g', { class: 'demo-node network-node', cursor: 'default' });
    g.appendChild(svg('circle', {
      cx: pos.x, cy: pos.y, r,
      class: `node-circle network-circle${isCorrupt ? ' corrupt-peer-circle' : ''}`,
    }));
    const lbl = svg('text', {
      x: pos.x, y: pos.y + 1, class: 'node-label',
      'text-anchor': 'middle', 'dominant-baseline': 'middle',
      style: `font-size: 10px; opacity: ${isCorrupt ? '0.8' : '0.5'};`,
    });
    lbl.textContent = `P${peerIdx++}`;
    g.appendChild(lbl);
    gNodes.appendChild(g);
  }

  // Guardian nodes
  st.guardianRingIndices.forEach((ri, gi) => {
    const pos = nodePos(st, ri, ringNodes);
    const r = nodeRadius(ringNodes, true);
    const isCorruptGuardian = corruptRingSet.has(ri);
    const g = svg('g', { id: `${prefix}node-${gi}`, class: 'demo-node guardian-node', cursor: 'default' });
    g.appendChild(svg('circle', {
      cx: pos.x, cy: pos.y, r,
      class: `node-circle guardian-circle${isCorruptGuardian ? ' corrupt-guardian-circle' : ''}`,
    }));

    const lbl = svg('text', {
      x: pos.x, y: pos.y + 1, class: 'node-label',
      'text-anchor': 'middle', 'dominant-baseline': 'middle',
      style: `font-size: ${ringNodes > 14 ? '10' : '14'}px`,
    });
    lbl.textContent = `G${gi + 1}`;
    g.appendChild(lbl);

    const badge = svg('text', {
      id: `${prefix}badge-${gi}`,
      x: pos.x, y: pos.y + Math.round(r * 0.55),
      class: 'share-label sss-stored-badge', 'text-anchor': 'middle', 'dominant-baseline': 'middle',
      fill: '#36d399', 'font-size': ringNodes > 14 ? '7.5' : '9.5', opacity: '0',
    });
    g.appendChild(badge);

    const slOffset = r + 6;
    const labelX = pos.x + (pos.x > CX ? slOffset : pos.x < CX - 5 ? -slOffset : 0);
    const labelY = pos.y + (pos.y > CY ? slOffset : -slOffset);
    const labelAnchor = pos.x > CX ? 'start' : pos.x < CX - 5 ? 'end' : 'middle';
    g.appendChild(svg('text', {
      id: `${prefix}share-label-${gi}`, x: labelX, y: labelY,
      class: 'share-label', 'text-anchor': labelAnchor, opacity: '0',
    }));
    g.appendChild(svg('text', {
      id: `${prefix}send-label-${gi}`, x: labelX, y: labelY + 11,
      class: 'share-label', 'text-anchor': labelAnchor, 'font-size': '8', opacity: '0',
    }));
    gNodes.appendChild(g);
  });

  s.appendChild(gNodes);
  s.appendChild(svg('g', { id: `${prefix}labels` }));

  // Constellation name — bottom-left
  const constName = pickConst(st, ringNodes)?.name;
  if (constName) {
    const nameEl = svg('text', {
      x: 12, y: H - 12, fill: '#ccc', opacity: '0.9', id: `${prefix}constellation-name`,
      style: 'font-size:13px; font-family: var(--mono); font-weight:500',
    });
    nameEl.textContent = `✦ ${constName}`;
    s.appendChild(nameEl);
  }

  container.appendChild(s);
  return s;
}
