import {
  svg, seed, shuffleArr, trimHex, pulseNode, appendPanelEntry,
  nodePos, animatePacket, buildCanvas, buildLegend, BUSS_LEGEND,
  showShareLabel, hideShareLabel, showSendLabel, hideSendLabel,
  showBadge, hideBadge, showOwnerSubLabel, hideOwnerSubLabel, CX, CY, H,
} from './canvas-helpers.js';

// Blockchain B node — bottom-centre, below ring-node zone ([88, H-88])
const BX = CX;
const BY = H - 40;

// ── WASM loader ───────────────────────────────────────────────────────────────

let wasm = null;

export async function loadBussWasm() {
  try {
    const mod = await import('./pkg/arc_pleiades_wasm.js');
    await mod.default();
    wasm = mod;
    document.querySelectorAll('.wasm-notice').forEach(el => el.style.display = 'none');
    updateBussButtons();
  } catch {
    // WASM not built yet — buttons stay disabled
  }
}

// ── Demo state ────────────────────────────────────────────────────────────────

const bstate = {
  secret: 0,
  secretSet: false,
  phi: [],           // y-only hex, for display (both modes)
  phiXY: [],          // {x,y} pairs, for traceable-mode wasm calls
  coefficients: [],
  guardianSks: [],
  sigmas: [],
  shares: [],         // {x,y} pairs, traceable mode only
  vk: [],             // tracing/verification key, traceable mode only
  t: 0,
  n: 1,
  networkSize: 10,
  guardianRingIndices: [],
  corruptRingIndices: [],
  corrupt: [],
  corruptCount: 0,
  mode: 'buss',
  phase: 'idle',
  prevRingNodes: undefined,
  constIdx: undefined,
};


// ── Node state ────────────────────────────────────────────────────────────────

function setBussNodeState(i, st) {
  const el = document.getElementById(`b-node-${i}`);
  if (!el) return;
  const circle = el.querySelector('.node-circle');
  circle.classList.remove('node-corrupt', 'node-caught', 'node-active');
  if (st !== 'idle') circle.classList.add(`node-${st}`);
}

// ── Status bar ────────────────────────────────────────────────────────────────

function setBussStatus(text, type) {
  const el = document.getElementById('buss-demo-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'demo-status ' + (type || '');
}

// ── Lagrange interpolation display ────────────────────────────────────────────

function lagrangeExpansionHtml(xs) {
  function gcd(a, b) {
    a = a < 0n ? -a : a; b = b < 0n ? -b : b;
    while (b) { [a, b] = [b, a % b]; }
    return a || 1n;
  }
  const coeffs = xs.map((xi, i) => {
    const nf = [], df = [];
    for (let j = 0; j < xs.length; j++) {
      if (j === i) continue;
      nf.push(-xs[j]);
      df.push(xi - xs[j]);
    }
    const rn = nf.reduce((a, b) => a * b, 1n);
    const rd = df.reduce((a, b) => a * b, 1n);
    const g = gcd(rn < 0n ? -rn : rn, rd < 0n ? -rd : rd);
    let sn = rn / g, sd = rd / g;
    if (sd < 0n) { sn = -sn; sd = -sd; }
    return { nf, df, sn, sd };
  });
  const fX    = x => x < 0n ? `−${-x}` : `${x}`;
  const fFacs = facs => `(${facs.join('·')})`;
  const fSim  = (n, d) => d === 1n ? `${n}` : `${n}/${d}`;

  const sym = xs.map((x, i) => `${i > 0 ? ' + ' : ''}λ<sub>${i+1}</sub>(0)·f(${fX(x)})`).join('');
  let html = `<div class="dv-header" style="margin-top:0.55rem">Lagrange interpolation — f(0)</div>
    <div class="dv-formula">f(0) = ${sym}</div>
    <div class="dv-note" style="margin-top:0.3rem;margin-bottom:0.15rem">With lambdas:</div>`;
  coeffs.forEach(({ nf, df, sn, sd }, i) => {
    html += `<div class="dv-formula" style="margin:0.04rem 0">λ<sub>${i+1}</sub>(0) = ${fFacs(nf)}/${fFacs(df)} = ${fSim(sn, sd)}</div>`;
  });
  return html;
}

// ── Values panel ──────────────────────────────────────────────────────────────

function updateBussValuesPanel(mode, data) {
  const el = document.getElementById('buss-values-panel');
  if (!el) return;

  if (mode === 'idle') {
    el.innerHTML = '<div data-placeholder="1" style="padding:0.4rem 0;color:var(--dim);font-size:0.7rem">— Click Backup to see guardian σ values and published φ —</div>';
    return;
  }

  const placeholder = el.querySelector('[data-placeholder]');
  if (placeholder) placeholder.remove();

  if (mode === 'backup') {
    const { sigmas, phi, corrupt, numGuardians } = data;
    const corruptSet = new Set(corrupt);
    let html = `<div class="dv-section">
      <div class="dv-header">Backup — σⱼ = H(owner_id ‖ skⱼ) for each guardian</div>
      <div class="dv-note">Stateless derivation — each guardian computes from their own key, nothing extra stored</div>
      <div class="dv-header" style="margin-top:0.55rem">Guardian evaluations f(j) = σⱼ received by owner</div>`;
    for (let i = 0; i < numGuardians; i++) {
      const isCorrupt = corruptSet.has(i);
      const sigShort = sigmas[i] ? sigmas[i].slice(0, 14) + '…' + sigmas[i].slice(-10) : '—';
      html += `<div class="dv-row">
        <span class="dv-key">f(${i + 1})</span>
        <span class="dv-val"${isCorrupt ? ' style="color:#ff4444"' : ''}>${sigShort}</span>
        <span class="dv-badge ${isCorrupt ? 'dv-corrupt' : 'dv-stored'}">${isCorrupt ? 'corrupt' : 'honest'}</span>
      </div>`;
    }
    const phiLen = phi.length;
    const deg = bstate.n - 1;
    const polyTerms = ['s', ...Array.from({ length: deg }, (_, k) =>
      k === 0 ? `a<sub>1</sub>·x` : `a<sub>${k + 1}</sub>·x<sup>${k + 1}</sup>`)].join(' + ');
    html += `<div class="dv-header" style="margin-top:0.55rem">Secret polynomial — degree n−1 = ${deg}</div>
      <div class="dv-formula">f(x) = ${polyTerms}</div>
      <div class="dv-note">f(0) = s = ${bstate.secret} &nbsp;·&nbsp; a<sub>1</sub>…a<sub>${deg}</sub> from Lagrange interpolation through all (j, σⱼ)</div>`;
    if (bstate.coefficients.length > 0) {
      for (let k = 0; k < bstate.coefficients.length; k++) {
        const cShort = bstate.coefficients[k].slice(0, 14) + '…' + bstate.coefficients[k].slice(-10);
        html += `<div class="dv-row"><span class="dv-key">a<sub>${k + 1}</sub></span><span class="dv-val">${cShort}</span></div>`;
      }
    }
    const phiExpected = Math.max(0, bstate.n - bstate.t - 1);
    const guardiansNeeded = bstate.t + 1;
    html += `<div class="dv-header" style="margin-top:0.55rem">Published φ — n−t−1 = ${phiExpected} evaluation${phiExpected !== 1 ? 's' : ''} at negative indices</div>
      <div class="dv-note">φₖ = f(−k) — degree-(n−1) polynomial at x = −1, −2, … &nbsp;·&nbsp; recovery needs t+1 = ${guardiansNeeded} guardian${guardiansNeeded !== 1 ? 's' : ''}: (n−t−1) + (t+1) = n evaluations total</div>`;
    for (let k = 0; k < phiLen; k++) {
      const fShort = phi[k] ? phi[k].slice(0, 14) + '…' + phi[k].slice(-10) : '—';
      html += `<div class="dv-row"><span class="dv-key">φ<sub>${k + 1}</sub> = f(−${k + 1})</span><span class="dv-val">${fShort}</span></div>`;
    }
    if (corruptSet.size > 0) {
      html += `<div class="dv-note" style="color:#ff4444;margin-top:0.4rem">
        ${corruptSet.size} corrupt guardian(s) present — during recovery they will recompute wrong σ and poison interpolation.
      </div>`;
    } else {
      html += `<div class="dv-note" style="margin-top:0.4rem;color:#36d399">
        φ published. Any ${guardiansNeeded} guardian${guardiansNeeded !== 1 ? 's' : ''} + the ${bstate.phi.length} public φ value${bstate.phi.length !== 1 ? 's' : ''} = n evaluations → recover s.
      </div>`;
    }
    html += `</div>`;
    appendPanelEntry(el, html);
    return;
  }

  if (mode === 'recover') {
    const { selectedIndices, corruptSet, phi, ok, recovered } = data;
    const numPhi = phi.length;
    const totalPoints = selectedIndices.length + numPhi;
    let html = `<div class="dv-section">
      <div class="dv-header">Recovery — Lagrange with ${selectedIndices.length} guardian${selectedIndices.length !== 1 ? 's' : ''} + ${numPhi} φ points = ${totalPoints}/${bstate.n} evaluations of degree-(n−1) f</div>
      <div class="dv-note">Guardians recompute σ on demand (same H(owner_id ‖ skⱼ) call, zero stored state)</div>
      <div class="dv-header" style="margin-top:0.55rem">Guardian evaluation</div>`;
    for (const gi of selectedIndices) {
      const isCorrupt = corruptSet && corruptSet.has(gi);
      const sigShort = bstate.sigmas[gi] ? bstate.sigmas[gi].slice(0, 14) + '…' + bstate.sigmas[gi].slice(-10) : '—';
      html += `<div class="dv-row">
        <span class="dv-key">f(${gi + 1})</span>
        <span class="dv-val"${isCorrupt ? ' style="color:#ff4444"' : ''}>${isCorrupt ? '?? (wrong)' : sigShort}</span>
        ${isCorrupt ? '<span class="dv-badge dv-corrupt">corrupt</span>' : '<span class="dv-badge dv-stored">honest</span>'}
      </div>`;
    }
    html += `<div class="dv-header" style="margin-top:0.55rem">Public φ points</div>`;
    for (let k = 0; k < numPhi; k++) {
      const fShort = phi[k] ? phi[k].slice(0, 14) + '…' + phi[k].slice(-10) : '—';
      html += `<div class="dv-row"><span class="dv-key">φ<sub>${k + 1}</sub> = f(−${k + 1})</span><span class="dv-val">${fShort}</span></div>`;
    }
    const lagXs = [
      ...selectedIndices.map(gi => BigInt(gi + 1)),
      ...phi.map((_, k) => BigInt(-(k + 1))),
    ];
    html += lagrangeExpansionHtml(lagXs);
    if (!ok && corruptSet && corruptSet.size > 0) {
      html += `<div class="dv-result" style="color:#ff4444">→ f(0) = ${recovered} ✗</div>
      <div class="dv-note" style="color:#ff4444">${corruptSet.size} corrupt σ value(s) poisoned interpolation.</div>`;
    } else {
      html += `<div class="dv-result">→ f(0) = ${recovered} ${ok ? '✓' : '✗'}</div>`;
    }
    html += `</div>`;
    appendPanelEntry(el, html);
    return;
  }

  if (mode === 'rotate') {
    const { gi, oldSigma, newSigma, oldPhi, newPhi } = data;
    let html = `<div class="dv-section">
      <div class="dv-header">Key rotation — G${gi + 1} updates key; owner applies δ to φ without knowing s</div>
      <div class="dv-note">δ = H(owner_id ‖ sk') − H(owner_id ‖ sk) — owner only sees the difference</div>
      <div class="dv-header" style="margin-top:0.55rem">G${gi + 1} σ update</div>
      <div class="dv-row">
        <span class="dv-key">old σ</span>
        <span class="dv-val" style="opacity:0.45">${oldSigma ? oldSigma.slice(0, 14) + '…' + oldSigma.slice(-10) : '—'}</span>
      </div>
      <div class="dv-row">
        <span class="dv-key">new σ'</span>
        <span class="dv-val" style="color:#ffba36">${newSigma ? newSigma.slice(0, 14) + '…' + newSigma.slice(-10) : '—'}</span>
        <span class="dv-badge" style="background:rgba(255,186,54,0.15);color:#ffba36">rotated</span>
      </div>
      <div class="dv-header" style="margin-top:0.55rem">φ updated (${newPhi.length} entries)</div>`;
    for (let k = 0; k < newPhi.length; k++) {
      const oldShort = oldPhi[k] ? oldPhi[k].slice(0, 10) + '…' : '—';
      const newShort = newPhi[k] ? newPhi[k].slice(0, 10) + '…' : '—';
      html += `<div class="dv-row">
        <span class="dv-key">φ<sub>${k + 1}</sub></span>
        <span class="dv-val" style="opacity:0.4">${oldShort}</span>
        <span class="dv-val" style="color:#ffba36;margin-left:0.3rem">→ ${newShort}</span>
      </div>`;
    }
    html += `<div class="dv-note" style="color:#36d399;margin-top:0.4rem">Recovery still works — G${gi + 1} uses their new key going forward.</div>
    </div>`;
    appendPanelEntry(el, html);
    return;
  }

  if (mode === 'trace') {
    const { accused, numGuardians } = data;
    const accusedSet = new Set(accused);
    let html = `<div class="dv-section">
      <div class="dv-header">Trace — Guruswami-Sudan list decoding</div>
      <div class="dv-note">Reconstruction queries probe with fresh synthetic shares and a δ-shifted point to distinguish corrupt from honest guardians.</div>
      <div class="dv-header" style="margin-top:0.55rem">Guardian verdicts</div>`;
    for (let i = 0; i < numGuardians; i++) {
      const caught = accusedSet.has(i + 1);
      html += `<div class="dv-row">
        <span class="dv-key">G${i + 1}</span>
        <span class="dv-val" style="color:${caught ? '#ffba36' : '#36d399'}">${caught ? 'corrupt — identified' : 'honest'}</span>
        <span class="dv-badge ${caught ? 'dv-corrupt' : 'dv-stored'}">${caught ? 'caught' : 'clear'}</span>
      </div>`;
    }
    html += `<div class="dv-result" style="color:#ffba36;margin-top:0.4rem">
      → ${accused.length} corrupt guardian(s) identified: ${accused.map(i => `G${i}`).join(', ')}
    </div></div>`;
    appendPanelEntry(el, html);
    return;
  }
}

// ── Blockchain B node ─────────────────────────────────────────────────────────

function addBlockchainNode(s) {
  // Dashed channel line from bottom of owner circle to top of board
  const lineEl = svg('line', {
    x1: CX, y1: CY + 17, x2: BX, y2: BY - 16,
    stroke: '#FFBA36', 'stroke-width': '1', 'stroke-dasharray': '5 4', opacity: '0.3',
  });
  const nodesG = s.querySelector('#b-nodes');
  if (nodesG) s.insertBefore(lineEl, nodesG); else s.appendChild(lineEl);

  const g = svg('g', { id: 'b-node-blockchain', transform: `translate(${BX}, ${BY})` });

  // Board background
  g.appendChild(svg('rect', { x: -28, y: -16, width: 56, height: 32, rx: 3,
    class: 'b-board-rect', fill: 'rgba(255,186,54,0.05)', stroke: '#FFBA36', 'stroke-width': '1.5' }));
  // Header strip (two rects to get flat bottom edge)
  g.appendChild(svg('rect', { x: -28, y: -16, width: 56, height: 9, rx: 3, fill: 'rgba(255,186,54,0.2)', stroke: 'none' }));
  g.appendChild(svg('rect', { x: -28, y: -11, width: 56, height: 4,        fill: 'rgba(255,186,54,0.2)', stroke: 'none' }));
  // Pin dots
  g.appendChild(svg('circle', { cx: -18, cy: -12, r: 2.5, fill: '#FFBA36', opacity: '0.7' }));
  g.appendChild(svg('circle', { cx:  18, cy: -12, r: 2.5, fill: '#FFBA36', opacity: '0.7' }));
  // "B" label
  const lbl = svg('text', { x: 0, y: 8, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
    fill: '#FFBA36', 'font-size': '13', 'font-family': 'var(--mono)', 'font-weight': '700' });
  lbl.textContent = 'B';
  g.appendChild(lbl);
  // Sub-label below board
  const sub = svg('text', { x: 0, y: 25, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
    fill: '#FFBA36', opacity: '0.5', 'font-size': '8', 'font-family': 'var(--mono)' });
  sub.textContent = 'blockchain';
  g.appendChild(sub);

  s.appendChild(g);
}

function pulseBNode() {
  const board = document.querySelector('#b-node-blockchain .b-board-rect');
  if (!board) return;
  board.style.fill = 'rgba(255,186,54,0.28)';
  setTimeout(() => { board.style.transition = 'fill 0.5s'; board.style.fill = 'rgba(255,186,54,0.05)'; }, 160);
}

function animatePublishToB() {
  return new Promise(resolve => {
    animatePacket('b-packets', CX, CY, BX, BY, 500, '#FFBA36', () => { pulseBNode(); resolve(); });
  });
}

function animateFetchFromB() {
  return new Promise(resolve => {
    animatePacket('b-packets', BX, BY, CX, CY, 400, '#FFBA36', resolve);
  });
}

// ── Bulletin board display ────────────────────────────────────────────────────

function updateBulletin(phi) {
  const el = document.getElementById('buss-bulletin-content');
  if (!el) return;
  if (!phi || phi.length === 0) {
    el.innerHTML = '<em>nothing published yet</em>';
    return;
  }
  el.innerHTML = phi.map((p, k) =>
    `<span>φ<sub>${k + 1}</sub> = ${p.slice(0, 12)}…${p.slice(-8)}</span>`
  ).join('<span class="buss-bulletin-sep">·</span>');
}

// ── Animations (packets travel guardian → owner — inverted vs SSS split) ──────

async function animateBackup(sigmas, corrupt) {
  const numGuardians = bstate.n - 1;
  const ringNodes = Math.max(bstate.networkSize - 1, numGuardians);
  return new Promise(resolve => {
    let done = 0;
    for (let i = 0; i < numGuardians; i++) {
      const pos = nodePos(bstate, bstate.guardianRingIndices[i], ringNodes);
      const isCorrupt = corrupt.includes(i);
      const packetColor = isCorrupt ? '#ff4444' : 'var(--electric-blue)';
      setTimeout(() => {
        animatePacket('b-packets', pos.x, pos.y, CX, CY, 500, packetColor, () => {
          pulseNode('b-node-owner');
          showShareLabel('b-', i, trimHex(sigmas[i]), isCorrupt ? '#ff4444' : '#36d399');
          done++;
          if (done === numGuardians) resolve();
        });
      }, i * 120);
    }
    if (numGuardians === 0) resolve();
  });
}

async function animateRecover(selectedIndices, corruptSet) {
  const ringNodes = Math.max(bstate.networkSize - 1, bstate.n - 1);
  return new Promise(resolve => {
    let done = 0;
    for (let i = 0; i < selectedIndices.length; i++) {
      const gi = selectedIndices[i];
      const pos = nodePos(bstate, bstate.guardianRingIndices[gi], ringNodes);
      const isCorrupt = corruptSet && corruptSet.has(gi);
      const packetColor = isCorrupt ? '#ff4444' : '#36d399';
      setTimeout(() => {
        showSendLabel('b-', gi, isCorrupt ? '?? sent' : 'share sent', isCorrupt ? '#ff8800' : '#36d399');
        animatePacket('b-packets', pos.x, pos.y, CX, CY, 500, packetColor, () => {
          done++;
          if (done === selectedIndices.length) { pulseNode('b-node-owner'); resolve(); }
        });
      }, i * 120);
    }
    if (selectedIndices.length === 0) resolve();
  });
}

async function animateRotate(gi) {
  const ringNodes = Math.max(bstate.networkSize - 1, bstate.n - 1);
  const pos = nodePos(bstate, bstate.guardianRingIndices[gi], ringNodes);
  return new Promise(resolve => {
    showSendLabel('b-', gi, 'σ\' new', '#ffba36');
    animatePacket('b-packets', pos.x, pos.y, CX, CY, 500, '#ffba36', () => {
      pulseNode('b-node-owner');
      resolve();
    });
  });
}

async function animateBussTrace(accused1based) {
  const numGuardians = bstate.n - 1;
  const ringNodes = Math.max(bstate.networkSize - 1, numGuardians);
  const probeColor = '#ffba36';
  for (let q = 0; q < 6; q++) {
    const gi = Math.floor(Math.random() * numGuardians);
    const pos = nodePos(bstate, bstate.guardianRingIndices[gi], ringNodes);
    await new Promise(r => {
      setTimeout(() => {
        animatePacket('b-packets', CX, CY, pos.x, pos.y, 300, probeColor, () =>
          animatePacket('b-packets', pos.x, pos.y, CX, CY, 300, probeColor, r));
      }, q * 200);
    });
  }
  for (const idx of accused1based) {
    setBussNodeState(idx - 1, 'caught');
    pulseNode(`b-node-${idx - 1}`);
  }
}

// ── Main actions ──────────────────────────────────────────────────────────────

function doBussGenerateSecret() {
  bstate.secret = Math.floor(Math.random() * 900000) + 100000;
  bstate.secretSet = true;

  if (bstate.phase !== 'idle') {
    const numGuardians = bstate.n - 1;
    for (let i = 0; i < numGuardians; i++) {
      hideShareLabel('b-', i);
      hideSendLabel('b-', i);
      hideBadge('b-', i);
      setBussNodeState(i, 'idle');
    }
    bstate.phi = [];
    bstate.phiXY = [];
    bstate.guardianSks = [];
    bstate.sigmas = [];
    bstate.shares = [];
    bstate.vk = [];
    bstate.phase = 'idle';
    updateBussValuesPanel('idle', null);
    updateBulletin([]);
  }

  showOwnerSubLabel('b-', `key: ${bstate.secret}`);
  setBussStatus(nextBussStepHint());

  const el = document.getElementById('buss-values-panel');
  if (el) {
    const placeholder = el.querySelector('[data-placeholder]');
    if (placeholder) placeholder.remove();
    appendPanelEntry(el, `<div class="dv-section">
      <div class="dv-header">Generate key</div>
      <div class="dv-formula">s = ${bstate.secret}</div>
      <div class="dv-note">Secret chosen. Click Backup — guardians compute σ and owner publishes φ.</div>
    </div>`);
  }

  updateBussButtons();
}

async function doBussBackup() {
  if (!wasm) return;
  if (bstate.phase !== 'idle' && bstate.phase !== 'done') return;

  const numGuardians = bstate.n - 1;
  for (let i = 0; i < numGuardians; i++) {
    setBussNodeState(i, 'idle');
    hideShareLabel('b-', i);
    hideSendLabel('b-', i);
    hideBadge('b-', i);
  }
  hideOwnerSubLabel('b-');

  if (!bstate.secretSet) bstate.secret = Math.floor(Math.random() * 900000) + 100000;
  bstate.secretSet = false;
  showOwnerSubLabel('b-', `key: ${bstate.secret}`);
  setBussStatus('Guardians computing σ = H(owner_id ‖ skⱼ) and sending to owner…');

  const corrupt = bstate.corrupt || [];

  let result;
  try {
    if (bstate.mode === 'buss') {
      result = await wasm.buss_setup(BigInt(bstate.secret), bstate.t, bstate.n, seed());
    } else {
      result = await wasm.tbuss_split(BigInt(bstate.secret), bstate.t, bstate.n, seed());
    }
  } catch (e) {
    setBussStatus(`Backup failed: ${e.message}`, 'error');
    return;
  }

  bstate.coefficients = Array.from(result.coefficients || []);
  bstate.guardianSks  = Array.from(result.guardian_sks);

  if (bstate.mode === 'buss') {
    bstate.phi    = Array.from(result.phi);
    bstate.sigmas = Array.from(result.sigmas);
    bstate.phiXY  = [];
    bstate.shares = [];
    bstate.vk     = [];
  } else {
    bstate.shares = Array.from(result.shares);
    bstate.phiXY  = Array.from(result.phi);
    bstate.phi    = bstate.phiXY.map(p => p.y);
    bstate.sigmas = bstate.shares.map(s => s.y);
    bstate.vk     = Array.from(result.vk);
  }

  await animateBackup(bstate.sigmas, corrupt);

  setBussStatus('Publishing φ to blockchain…');
  await animatePublishToB();
  updateBulletin(bstate.phi);

  showOwnerSubLabel('b-', `φ published`);
  updateBussValuesPanel('backup', { sigmas: bstate.sigmas, phi: bstate.phi, corrupt, numGuardians });

  const msg = corrupt.length > 0
    ? `φ published to blockchain. ${corrupt.length} guardian(s) are corrupt — they will send wrong σ during recovery.`
    : `φ published to blockchain (${bstate.phi.length} field element${bstate.phi.length !== 1 ? 's' : ''}). Click Recover to restore the key.`;
  setBussStatus(msg);

  bstate.phase = 'ready';
  updateBussButtons();
}

async function doBussRecover() {
  if (!wasm || (bstate.phase !== 'ready' && bstate.phase !== 'done')) return;
  bstate.phase = 'recover';
  setBussStatus('Guardians recomputing σ on demand…');

  const numGuardians = bstate.n - 1;
  const corruptSet = new Set(bstate.corrupt || []);
  // degree-(n-1) polynomial: φ provides n-t-1 points, t+1 guardian evaluations make up n total.
  const all = Array.from({ length: numGuardians }, (_, i) => i);
  const selected = shuffleArr(all).slice(0, bstate.t + 1);
  const corruptInSelected = selected.filter(i => corruptSet.has(i));

  for (let i = 0; i < numGuardians; i++) hideSendLabel('b-', i);

  await Promise.all([animateFetchFromB(), animateRecover(selected, corruptSet)]);

  if (corruptInSelected.length > 0) {
    let fakeResult = bstate.secret;
    while (fakeResult === bstate.secret) fakeResult = Math.floor(Math.random() * 900000) + 100000;
    showOwnerSubLabel('b-', `key: ${fakeResult} ✗`);
    const honestAvail = numGuardians - corruptSet.size;
    setBussStatus(
      `Recovery failed — ${corruptInSelected.length} of the selected ${selected.length} guardian${selected.length !== 1 ? 's' : ''} is corrupt. Got ${fakeResult} instead of ${bstate.secret}. ` +
      `(${honestAvail} honest guardian${honestAvail !== 1 ? 's' : ''} available — try again.)`,
      'error',
    );
    updateBussValuesPanel('recover', { selectedIndices: selected, corruptSet, phi: bstate.phi, ok: false, recovered: fakeResult });
    bstate.phase = 'done';
    updateBussButtons();
    return;
  }

  let recovered;
  try {
    if (bstate.mode === 'buss') {
      const selectedJson = JSON.stringify(selected.map(gi => ({ index: gi + 1, sk: bstate.guardianSks[gi] })));
      recovered = await wasm.buss_reconstruct(JSON.stringify(bstate.phi), selectedJson, bstate.t, bstate.n);
    } else {
      const selectedJson = JSON.stringify(selected.map(gi => bstate.shares[gi]));
      recovered = await wasm.tbuss_reconstruct(JSON.stringify(bstate.phiXY), selectedJson, bstate.t, bstate.n);
    }
  } catch (e) {
    setBussStatus(`Recovery failed: ${e.message}`, 'error');
    bstate.phase = 'ready';
    updateBussButtons();
    return;
  }

  const ok = Number(recovered) === bstate.secret;
  showOwnerSubLabel('b-', `key: ${recovered} ${ok ? '✓' : '✗'}`);
  setBussStatus(
    ok ? `Secret ${recovered} recovered — guardians recomputed σ on demand, nothing was ever stored.`
       : `Mismatch — got ${recovered}, expected ${bstate.secret}.`,
    ok ? 'ok' : 'error',
  );
  updateBussValuesPanel('recover', { selectedIndices: selected, corruptSet: new Set(), phi: bstate.phi, ok, recovered: Number(recovered) });
  bstate.phase = 'done';
  updateBussButtons();
}

async function doBussRotate() {
  if (!wasm || bstate.mode !== 'buss') return;
  if (bstate.phase !== 'ready' && bstate.phase !== 'done') return;
  if (bstate.n < 2) return;

  const gi = 0;
  const oldSk    = bstate.guardianSks[gi];
  const oldSigma = bstate.sigmas[gi];
  const oldPhi   = [...bstate.phi];

  setBussStatus(`G${gi + 1} rotating key — owner updates φ without knowing s…`);

  let result;
  try {
    result = await wasm.buss_rotate(JSON.stringify(bstate.phi), gi + 1, bstate.n, oldSk, seed());
  } catch (e) {
    setBussStatus(`Rotation failed: ${e.message}`, 'error');
    bstate.phase = 'ready';
    updateBussButtons();
    return;
  }

  await animateRotate(gi);

  bstate.phi           = Array.from(result.phi);
  bstate.guardianSks[gi] = result.new_sk;
  bstate.sigmas[gi]    = result.new_sigma;

  setBussStatus('Updating φ on blockchain…');
  await animatePublishToB();
  updateBulletin(bstate.phi);

  showBadge('b-', gi, 'rotated', false);
  showOwnerSubLabel('b-', 'φ updated');
  setBussStatus(`G${gi + 1} key rotated. φ updated on blockchain without revealing s. Recovery still works.`, 'ok');

  updateBussValuesPanel('rotate', { gi, oldSigma, newSigma: result.new_sigma, oldPhi, newPhi: bstate.phi });
  bstate.phase = 'done';
  updateBussButtons();
}

async function doBussTrace() {
  if (!wasm || bstate.mode !== 'traceable') return;
  if (bstate.phase !== 'ready' && bstate.phase !== 'done') return;
  if (!bstate.corrupt?.length) { setBussStatus('No corrupt guardians to trace.'); return; }

  bstate.phase = 'trace';
  setBussStatus('Running Guruswami-Sudan oracle queries…');

  let result;
  try {
    result = await wasm.tbuss_trace(
      JSON.stringify(bstate.shares), JSON.stringify(bstate.phiXY), JSON.stringify(bstate.vk),
      JSON.stringify(bstate.corrupt), bstate.t, bstate.n, seed(),
    );
  } catch (e) {
    setBussStatus(`Tracing failed: ${e.message}`, 'error');
    bstate.phase = 'done';
    updateBussButtons();
    return;
  }

  await animateBussTrace(result.accused);
  const names = result.accused.map(i => `G${i}`).join(', ');
  setBussStatus(`Identified ${result.accused.length} corrupt guardian(s): ${names}. Proof verified.`, 'ok');
  updateBussValuesPanel('trace', { accused: result.accused, numGuardians: bstate.n - 1 });
  bstate.phase = 'traced';
  updateBussButtons();
}

// ── UI wiring ─────────────────────────────────────────────────────────────────

function updateBussButtons() {
  const hasGuardians = bstate.n > 1;
  const canBackup  = hasGuardians && bstate.secretSet && (bstate.phase === 'idle' || bstate.phase === 'done');
  const canRecover = hasGuardians && (bstate.phase === 'ready' || bstate.phase === 'done');
  const canRotate  = hasGuardians && (bstate.phase === 'ready' || bstate.phase === 'done') && bstate.mode === 'buss';
  const canTrace   = hasGuardians && (bstate.phase === 'ready' || bstate.phase === 'done')
    && bstate.mode === 'traceable' && bstate.corrupt?.length > 0;

  const btnBackup  = document.getElementById('buss-btn-backup');
  const btnRecover = document.getElementById('buss-btn-recover');
  const btnRotate  = document.getElementById('buss-btn-rotate');
  const btnTrace   = document.getElementById('buss-btn-trace');

  if (btnBackup)  btnBackup.disabled  = !canBackup  || !wasm;
  if (btnRecover) btnRecover.disabled = !canRecover || !wasm;
  if (btnRotate) {
    btnRotate.disabled     = !canRotate || !wasm;
    btnRotate.style.display = bstate.mode === 'buss' ? '' : 'none';
  }
  if (btnTrace) {
    btnTrace.disabled     = !canTrace || !wasm;
    btnTrace.style.display = bstate.mode === 'traceable' ? '' : 'none';
  }
}

function nextBussStepHint() {
  const numGuardians = bstate.n - 1;
  if (numGuardians < 2)  return 'Step 1: add at least 2 guardians using the slider.';
  if (!bstate.secretSet) return 'Step 2: generate a key, then click Backup.';
  return `Key ${bstate.secret} ready — click Backup to compute φ (threshold ${bstate.t + 1}-of-${numGuardians}).`;
}

function rebuildBussDemo() {
  const container = document.getElementById('buss-svg-container');
  if (container) {
    const s = buildCanvas(container, bstate, { prefix: 'b-' });
    if (s) addBlockchainNode(s);
  }
  bstate.phase = 'idle';
  bstate.phi = [];
  bstate.phiXY = [];
  bstate.coefficients = [];
  bstate.guardianSks = [];
  bstate.sigmas = [];
  bstate.shares = [];
  bstate.vk = [];
  if (bstate.secretSet) showOwnerSubLabel('b-', `key: ${bstate.secret}`);
  else hideOwnerSubLabel('b-');
  updateBulletin([]);
  updateBussValuesPanel('idle', null);
  setBussStatus(nextBussStepHint());
  updateBussButtons();
}

export function initBussDemo() {
  const sliderNet     = document.getElementById('buss-demo-net');
  const sliderN       = document.getElementById('buss-demo-n');
  const sliderT       = document.getElementById('buss-demo-t');
  const sliderCorrupt = document.getElementById('buss-demo-corrupt');
  const labelNet      = document.getElementById('buss-label-net');
  const labelN        = document.getElementById('buss-label-n');
  const labelT        = document.getElementById('buss-label-t');
  const labelCorrupt  = document.getElementById('buss-label-corrupt');
  const modeSelect    = document.getElementById('buss-demo-mode');

  const DEFAULTS = { net: 10, corrupt: 0, n: 0, t: 1 };

  function syncBussSliders() {
    bstate.networkSize  = parseInt(sliderNet?.value    || DEFAULTS.net);
    const numGuardians  = parseInt(sliderN?.value      || DEFAULTS.n);
    bstate.t            = parseInt(sliderT?.value      || DEFAULTS.t);
    bstate.corruptCount = parseInt(sliderCorrupt?.value || DEFAULTS.corrupt);

    const maxGuardians = Math.max(0, bstate.networkSize - 1);
    const clampedG = Math.min(Math.max(0, numGuardians), maxGuardians);
    if (sliderN && sliderN.max !== String(maxGuardians)) sliderN.max = maxGuardians;
    if (sliderN && parseInt(sliderN.value) !== clampedG) sliderN.value = clampedG;
    bstate.n = clampedG + 1;

    if (clampedG < 2) {
      if (sliderT) { sliderT.disabled = true; sliderT.max = 0; }
      bstate.t = 0;
    } else {
      if (sliderT) { sliderT.disabled = false; sliderT.max = clampedG - 1; }
      bstate.t = Math.max(1, Math.min(bstate.t, clampedG - 1));
    }
    if (sliderT) sliderT.value = bstate.t;

    if (sliderCorrupt) {
      const maxCorrupt = Math.max(0, bstate.networkSize - 1);
      sliderCorrupt.max = maxCorrupt;
      bstate.corruptCount = Math.min(parseInt(sliderCorrupt.value || '0'), maxCorrupt);
      sliderCorrupt.value = bstate.corruptCount;
    }

    const ringNodes = Math.max(bstate.networkSize - 1, clampedG);
    if (labelNet)     labelNet.textContent     = `${ringNodes + 1} nodes`;
    if (labelCorrupt) labelCorrupt.textContent = bstate.corruptCount === 0 ? '0 corrupt' : `${bstate.corruptCount} corrupt`;
    if (labelN)       labelN.textContent       = `${clampedG} guardian${clampedG === 1 ? '' : 's'}`;
    if (clampedG >= 2) {
      if (labelT) labelT.textContent = `threshold ${bstate.t + 1}-of-${clampedG}`;
    } else {
      if (labelT) labelT.textContent = clampedG === 1 ? 'need ≥ 2 guardians' : 'no guardians';
    }
    rebuildBussDemo();
  }

  function doBussReset() {
    if (sliderNet)     sliderNet.value     = DEFAULTS.net;
    if (sliderCorrupt) sliderCorrupt.value = DEFAULTS.corrupt;
    if (sliderN)       sliderN.value       = DEFAULTS.n;
    if (sliderT)       sliderT.value       = DEFAULTS.t;
    if (modeSelect)    modeSelect.value    = 'buss';
    bstate.mode                = 'buss';
    bstate.guardianRingIndices = [];
    bstate.corruptRingIndices  = [];
    bstate.secretSet           = false;
    bstate.secret              = 0;
    bstate.prevRingNodes       = undefined;
    syncBussSliders();
  }

  sliderNet?.addEventListener('input',     syncBussSliders);
  sliderN?.addEventListener('input',       syncBussSliders);
  sliderT?.addEventListener('input',       syncBussSliders);
  sliderCorrupt?.addEventListener('input', syncBussSliders);

  modeSelect?.addEventListener('change', () => { bstate.mode = modeSelect.value; rebuildBussDemo(); });

  document.getElementById('buss-btn-gen-secret')?.addEventListener('click', doBussGenerateSecret);
  document.getElementById('buss-btn-backup')?.addEventListener('click',     doBussBackup);
  document.getElementById('buss-btn-recover')?.addEventListener('click',    doBussRecover);
  document.getElementById('buss-btn-rotate')?.addEventListener('click',     doBussRotate);
  document.getElementById('buss-btn-trace')?.addEventListener('click',      doBussTrace);
  document.getElementById('buss-btn-reset')?.addEventListener('click',      doBussReset);

  const legendEl = document.getElementById('buss-legend');
  if (legendEl) buildLegend(legendEl, BUSS_LEGEND);

  syncBussSliders();
}
