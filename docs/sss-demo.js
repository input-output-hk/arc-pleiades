import {
  seed, shuffleArr, trimHex, pulseNode, appendPanelEntry,
  nodePos, animatePacket, buildCanvas, buildLegend, SSS_LEGEND,
  showShareLabel, hideShareLabel, showSendLabel, hideSendLabel,
  showBadge, hideBadge, showOwnerSubLabel, hideOwnerSubLabel, CX, CY,
} from './canvas-helpers.js';

// ── WASM loader ───────────────────────────────────────────────────────────────

let wasm = null;

export async function loadWasm() {
  try {
    const mod = await import('./pkg/arc_pleiades_wasm.js');
    await mod.default();
    wasm = mod;
    document.querySelectorAll('.wasm-notice').forEach(el => el.style.display = 'none');
    updateButtons();
  } catch {
    // WASM not built yet — buttons stay disabled
  }
}

// ── Demo state ────────────────────────────────────────────────────────────────

const state = {
  secret: 0,
  secretSet: false,
  shares: [],
  coefficients: [],
  tk: [],
  vk: [],          // Feldman commitments (hex G1 points)
  verified: null,  // Feldman: per-guardian verify_share() results
  t: 0,
  n: 1,
  networkSize: 10,
  guardianRingIndices: [],
  corruptRingIndices: [],
  corrupt: [],
  corruptCount: 0,
  mode: 'shamir',
  phase: 'idle',
  prevRingNodes: undefined,
  constIdx: undefined,
};


// ── Node state ────────────────────────────────────────────────────────────────

function setNodeState(i, s) {
  const el = document.getElementById(`node-${i}`);
  if (!el) return;
  const circle = el.querySelector('.node-circle');
  circle.classList.remove('node-corrupt', 'node-caught', 'node-active');
  if (s !== 'idle') circle.classList.add(`node-${s}`);
}

// ── Status bar ────────────────────────────────────────────────────────────────

function setStatus(text, type) {
  const el = document.getElementById('demo-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'demo-status ' + (type || '');
}

// ── Lagrange math helpers ─────────────────────────────────────────────────────

function bigGcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) { const t = b; b = a % b; a = t; }
  return a;
}

function lagrangeAt0(xs) {
  return xs.map((xi, i) => {
    let num = 1n, den = 1n;
    for (let j = 0; j < xs.length; j++) {
      if (j === i) continue;
      num *= BigInt(-xs[j]);
      den *= BigInt(xi - xs[j]);
    }
    const g = bigGcd(num < 0n ? -num : num, den < 0n ? -den : den);
    num /= g; den /= g;
    if (den < 0n) { num = -num; den = -den; }
    return { num, den, x: xi };
  });
}

function formatLagrangeDerivation(xs) {
  const coeffs = lagrangeAt0(xs);
  const pad = '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;';

  const line1 = 'f(0) = ' +
    xs.map((x, i) => `λ<sub>${i + 1}</sub>(0)·f(${x})`).join(' + ');

  const line2 = `${pad}= ` + xs.map((xi, i) => {
    const others = xs.filter((_, j) => j !== i);
    const numStr = others.map(xj => { const v = -xj; return v < 0 ? `(−${-v})` : `(${v})`; }).join('');
    const denParts = others.map(xj => { const v = xi - xj; return v < 0 ? `(−${-v})` : `(${v})`; });
    const denStr = others.length > 1 ? `(${denParts.join('')})` : denParts[0];
    return `${numStr}/${denStr}·f(${xi})`;
  }).join(' + ');

  const line3 = `${pad}= ` + coeffs.map(({ num, den, x }, i) => {
    const neg = num < 0n;
    const a = neg ? -num : num;
    const coeff = den === 1n ? (a === 1n ? '' : `${a}·`) : `${a}/${den}·`;
    const term = `${coeff}f(${x})`;
    if (i === 0) return neg ? `−${term}` : term;
    return neg ? ` − ${term}` : ` + ${term}`;
  }).join('');

  return `${line1}<br>${line2}<br>${line3}`;
}

function polyDescription(t) {
  if (t === 0) return 'f(x) = s';
  const terms = ['s'];
  for (let k = 1; k <= t; k++) {
    terms.push(`a<sub>${k}</sub>·x${k > 1 ? `<sup>${k}</sup>` : ''}`);
  }
  return `f(x) = ${terms.join(' + ')}`;
}

// ── Values panel ──────────────────────────────────────────────────────────────

function updateSssValuesPanel(mode, data) {
  const el = document.getElementById('sss-values-panel');
  if (!el) return;

  if (mode === 'idle') {
    el.innerHTML = '<div data-placeholder="1" style="padding:0.4rem 0;color:var(--dim);font-size:0.7rem">— Click Split to see the polynomial and share values —</div>';
    return;
  }

  const placeholder = el.querySelector('[data-placeholder]');
  if (placeholder) placeholder.remove();

  if (mode === 'split') {
    const { shares, coefficients } = data;
    const corruptSet = new Set(state.corrupt || []);
    const poly = polyDescription(state.t);
    let html = `<div class="dv-section">
      <div class="dv-header">Split — degree-${state.t} polynomial over 𝔽<sub>p</sub></div>
      <div class="dv-formula">${poly}</div>
      <div class="dv-note">f(0) = ${state.secret} is the secret · a<sub>1</sub>, …, a<sub>${state.t}</sub> drawn at random</div>`;
    if (coefficients && coefficients.length > 0) {
      html += `<div class="dv-header" style="margin-top:0.55rem">Random coefficients</div>`;
      for (let k = 0; k < coefficients.length; k++) {
        const cShort = coefficients[k].slice(0, 14) + '…' + coefficients[k].slice(-10);
        html += `<div class="dv-row"><span class="dv-key">a<sub>${k + 1}</sub></span><span class="dv-val">${cShort}</span></div>`;
      }
    }
    html += `<div class="dv-header" style="margin-top:0.55rem">Evaluations — each guardian stores their share</div>`;
    for (let i = 0; i < shares.length; i++) {
      const isCorrupt = corruptSet.has(i);
      const yShort = shares[i].y.slice(0, 14) + '…' + shares[i].y.slice(-10);
      html += `<div class="dv-row">
        <span class="dv-key">f(${i + 1})</span>
        <span class="dv-val"${isCorrupt ? ' style="color:#ff4444"' : ''}>${isCorrupt ? '?? (will send wrong)' : yShort}</span>
        <span class="dv-badge ${isCorrupt ? 'dv-corrupt' : 'dv-stored'}">${isCorrupt ? 'corrupt' : 'stored'}</span>
      </div>`;
    }
    if (corruptSet.size > 0) {
      const honestAvail = shares.length - corruptSet.size;
      const needed = state.t + 1;
      const safe = honestAvail >= needed;
      const note = state.mode === 'feldman'
        ? `${corruptSet.size} guardian(s) received a tampered share from the dealer — click Verify to catch this before reconstructing.`
        : `${corruptSet.size} corrupt guardian(s) — will send wrong shares during reconstruction.
        ${safe
          ? `${honestAvail} honest ≥ ${needed} needed — reconstruction still possible using honest parties only.`
          : `Only ${honestAvail} honest &lt; ${needed} needed — reconstruction will fail.`}`;
      html += `<div class="dv-note" style="color:#ff4444;margin-top:0.4rem">${note}</div>`;
    }
    if (state.mode === 'feldman' && data.vk) {
      html += `<div class="dv-header" style="margin-top:0.55rem">Commitments C<sub>j</sub> = a<sub>j</sub>·G</div>`;
      for (let j = 0; j < data.vk.length; j++) {
        const cShort = data.vk[j].slice(0, 14) + '…' + data.vk[j].slice(-10);
        html += `<div class="dv-row"><span class="dv-key">C<sub>${j}</sub></span><span class="dv-val">${cShort}</span></div>`;
      }
    }
    html += `</div>`;
    appendPanelEntry(el, html);
    return;
  }

  if (mode === 'verify') {
    const { results, vk, numGuardians } = data;
    const bad = results.filter(v => !v).length;
    let html = `<div class="dv-section">
      <div class="dv-header">Verify — check gʸ = Σⱼ C<sub>j</sub>·x<sup>j</sup> for each guardian</div>
      <div class="dv-note">Each guardian checks their own share against the public commitments — no secret is revealed.</div>
      <div class="dv-header" style="margin-top:0.55rem">Guardian verdicts</div>`;
    for (let i = 0; i < numGuardians; i++) {
      const ok = results[i];
      html += `<div class="dv-row">
        <span class="dv-key">G${i + 1}</span>
        <span class="dv-val" style="color:${ok ? '#36d399' : '#ff4444'}">${ok ? 'valid share' : 'INVALID share'}</span>
        <span class="dv-badge ${ok ? 'dv-stored' : 'dv-corrupt'}">${ok ? 'verified' : 'failed'}</span>
      </div>`;
    }
    html += `<div class="dv-header" style="margin-top:0.55rem">Commitments C<sub>j</sub> = a<sub>j</sub>·G</div>`;
    for (let j = 0; j < vk.length; j++) {
      const cShort = vk[j].slice(0, 14) + '…' + vk[j].slice(-10);
      html += `<div class="dv-row"><span class="dv-key">C<sub>${j}</sub></span><span class="dv-val">${cShort}</span></div>`;
    }
    html += `<div class="dv-result" style="color:${bad === 0 ? '#36d399' : '#ff4444'};margin-top:0.4rem">
      → ${bad === 0 ? 'All shares verified — safe to reconstruct.' : `${bad} share(s) failed verification — do not use ${bad === 1 ? 'it' : 'them'}.`}
    </div></div>`;
    appendPanelEntry(el, html);
    return;
  }

  if (mode === 'reconstruct') {
    const { shares, selectedIndices, corruptSet, corruptInSelected, recovered, ok } = data;
    const xs = selectedIndices.map(i => i + 1);
    const derivation = formatLagrangeDerivation(xs);
    let html = `<div class="dv-section">
      <div class="dv-header">Reconstruct — Lagrange interpolation at x = 0</div>
      <div class="dv-formula">${derivation}</div>`;
    for (const i of selectedIndices) {
      const isCorrupt = corruptSet && corruptSet.has(i);
      const yShort = shares[i].y.slice(0, 14) + '…' + shares[i].y.slice(-10);
      html += `<div class="dv-row">
        <span class="dv-key">f(${i + 1})</span>
        <span class="dv-val"${isCorrupt ? ' style="color:#ff4444"' : ''}>${isCorrupt ? '?? (wrong)' : yShort}</span>
        ${isCorrupt ? '<span class="dv-badge dv-corrupt">wrong</span>' : ''}
      </div>`;
    }
    if (!ok && corruptInSelected?.length > 0) {
      html += `<div class="dv-result" style="color:#ff4444">→ f(0) = ${recovered} ✗</div>
      <div class="dv-note" style="color:#ff4444">${corruptInSelected.length} corrupt share(s) poisoned the interpolation.</div>`;
    } else {
      html += `<div class="dv-result">→ f(0) = ${recovered} ${ok ? '✓' : '✗'}</div>`;
    }
    html += `</div>`;
    appendPanelEntry(el, html);
    return;
  }

  if (mode === 'trace') {
    const { accused, numGuardians } = data;
    const accusedSet = new Set(accused);
    let html = `<div class="dv-section">
      <div class="dv-header">Trace — Guruswami-Sudan list decoding</div>
      <div class="dv-note">Oracle queries probe each guardian with random evaluation points to distinguish corrupt from honest shares.</div>
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

// ── Animations ────────────────────────────────────────────────────────────────

async function animateSplit(shares, corrupt) {
  const numGuardians = state.n - 1;
  const ringNodes = Math.max(state.networkSize - 1, numGuardians);
  return new Promise(resolve => {
    let done = 0;
    for (let i = 0; i < numGuardians; i++) {
      const pos = nodePos(state, state.guardianRingIndices[i], ringNodes);
      const isCorrupt = corrupt.includes(i);
      setTimeout(() => {
        animatePacket('packets', CX, CY, pos.x, pos.y, 500, 'var(--electric-blue)', () => {
          pulseNode(`node-${i}`);
          showShareLabel('', i, trimHex(shares[i].y));
          showBadge('', i, isCorrupt ? 'corrupt' : 'stored', isCorrupt);
          done++;
          if (done === numGuardians) resolve();
        });
      }, i * 120);
    }
  });
}

async function animateReconstruct(selectedIndices, corruptSet) {
  const numGuardians = state.n - 1;
  const ringNodes = Math.max(state.networkSize - 1, numGuardians);
  return new Promise(resolve => {
    let done = 0;
    for (let i = 0; i < selectedIndices.length; i++) {
      const gi = selectedIndices[i];
      const pos = nodePos(state, state.guardianRingIndices[gi], ringNodes);
      const isCorrupt = corruptSet && corruptSet.has(gi);
      const packetColor = isCorrupt ? '#ff4444' : '#36d399';
      setTimeout(() => {
        showSendLabel('', gi, isCorrupt ? '?? sent' : 'share sent', isCorrupt ? '#ff8800' : '#36d399');
        animatePacket('packets', pos.x, pos.y, CX, CY, 500, packetColor, () => {
          done++;
          if (done === selectedIndices.length) { pulseNode('node-owner'); resolve(); }
        });
      }, i * 120);
    }
  });
}

async function animateTrace(accused1based) {
  const numGuardians = state.n - 1;
  const ringNodes = Math.max(state.networkSize - 1, numGuardians);
  const probeColor = '#ffba36';
  for (let q = 0; q < 6; q++) {
    const gi = Math.floor(Math.random() * numGuardians);
    const pos = nodePos(state, state.guardianRingIndices[gi], ringNodes);
    await new Promise(r => {
      setTimeout(() => {
        animatePacket('packets', CX, CY, pos.x, pos.y, 300, probeColor, () =>
          animatePacket('packets', pos.x, pos.y, CX, CY, 300, probeColor, r));
      }, q * 200);
    });
  }
  for (const idx of accused1based) {
    setNodeState(idx - 1, 'caught');
    pulseNode(`node-${idx - 1}`);
  }
}

// ── Main actions ──────────────────────────────────────────────────────────────

function doGenerateSecret() {
  state.secret = Math.floor(Math.random() * 900000) + 100000;
  state.secretSet = true;

  if (state.phase !== 'idle') {
    const numGuardians = state.n - 1;
    for (let i = 0; i < numGuardians; i++) {
      hideShareLabel('', i);
      hideSendLabel('', i);
      hideBadge('', i);
      setNodeState(i, 'idle');
    }
    state.shares = [];
    state.coefficients = [];
    state.vk = [];
    state.verified = null;
    state.phase = 'idle';
    updateSssValuesPanel('idle', null);
  }

  showOwnerSubLabel('', `key: ${state.secret}`);
  setStatus(nextStepHint());

  const el = document.getElementById('sss-values-panel');
  if (el) {
    const placeholder = el.querySelector('[data-placeholder]');
    if (placeholder) placeholder.remove();
    appendPanelEntry(el, `<div class="dv-section">
      <div class="dv-header">Generate key</div>
      <div class="dv-formula">s = ${state.secret}</div>
      <div class="dv-note">Secret chosen. Split to distribute shares to guardians.</div>
    </div>`);
  }

  updateButtons();
}

async function doSplit() {
  if (!wasm) return;
  if (state.phase !== 'idle' && state.phase !== 'done' && state.phase !== 'traced' && state.phase !== 'verified') return;

  const numGuardians = state.n - 1;
  for (let i = 0; i < numGuardians; i++) {
    setNodeState(i, 'idle');
    hideShareLabel('', i);
    hideSendLabel('', i);
    hideBadge('', i);
  }
  hideOwnerSubLabel('');

  if (!state.secretSet) state.secret = Math.floor(Math.random() * 900000) + 100000;
  state.secretSet = false;
  showOwnerSubLabel('', `key: ${state.secret}`);
  setStatus(`Splitting key ${state.secret} with threshold ${state.t + 1}-of-${numGuardians}…`);

  const corrupt = state.corrupt || [];
  state.verified = null;

  let shares;
  try {
    if (state.mode === 'shamir') {
      const result = await wasm.shamir_split(BigInt(state.secret), state.t, state.n, seed());
      shares = Array.from(result.shares);
      state.coefficients = Array.from(result.coefficients);
      state.vk = [];
    } else if (state.mode === 'feldman') {
      const result = await wasm.feldman_split(BigInt(state.secret), state.t, state.n, seed());
      shares = Array.from(result.shares).map(s => ({ ...s }));
      state.vk = Array.from(result.vk);
      state.coefficients = [];
      // Simulate a malicious dealer: swap in a mismatched y for each corrupt
      // guardian (still a well-formed field element, just wrong for this x).
      for (const i of corrupt) {
        shares[i] = { x: shares[i].x, y: shares[(i + 1) % shares.length].y };
      }
    } else {
      const result = await wasm.ts_split(BigInt(state.secret), state.t, state.n, seed());
      shares = result.shares;
      state.tk = result.tk;
      state.coefficients = [];
      state.vk = [];
    }
  } catch (e) {
    setStatus(`Split failed: ${e.message}`, 'error');
    return;
  }

  state.shares = shares;
  state.phase = 'split';
  await animateSplit(shares, corrupt);
  state.phase = 'ready';

  updateSssValuesPanel('split', { shares, coefficients: state.coefficients, vk: state.vk });

  let msg;
  if (state.mode === 'feldman') {
    msg = corrupt.length > 0
      ? `${numGuardians} shares sent. ${corrupt.length} guardian(s) received a tampered share — click Verify to catch it.`
      : `${numGuardians} shares sent. Click Verify to check them against the commitments, then Reconstruct.`;
  } else {
    msg = corrupt.length > 0
      ? `${numGuardians} shares sent. ${corrupt.length} guardian(s) are corrupt — they will send wrong shares on reconstruct.`
      : `${numGuardians} shares sent. Click Reconstruct to recover.`;
  }
  setStatus(msg);
  updateButtons();
}

async function doVerify() {
  if (!wasm || state.mode !== 'feldman') return;
  if (state.phase !== 'ready' && state.phase !== 'done' && state.phase !== 'verified') return;

  state.phase = 'verify';
  setStatus('Each guardian checking gʸ = Σⱼ Cⱼ·xʲ against the public commitments…');

  const numGuardians = state.n - 1;
  const results = [];
  for (let i = 0; i < numGuardians; i++) {
    let ok;
    try {
      ok = await wasm.feldman_verify_share(JSON.stringify(state.shares[i]), JSON.stringify(state.vk), state.t, state.n);
    } catch {
      ok = false;
    }
    results.push(ok);
    setNodeState(i, ok ? 'idle' : 'corrupt');
    showBadge('', i, ok ? 'verified' : 'invalid', !ok);
  }
  state.verified = results;

  const bad = results.filter(v => !v).length;
  setStatus(
    bad === 0
      ? `All ${numGuardians} shares verified against the public commitments. Safe to reconstruct.`
      : `${bad} of ${numGuardians} share(s) FAILED verification — a malicious dealer was caught before reconstruction.`,
    bad === 0 ? 'ok' : 'error',
  );
  updateSssValuesPanel('verify', { results, vk: state.vk, numGuardians });
  state.phase = 'verified';
  updateButtons();
}

async function doReconstruct() {
  if (!wasm || (state.phase !== 'ready' && state.phase !== 'done' && state.phase !== 'verified')) return;
  state.phase = 'reconstruct';
  setStatus('Collecting shares from threshold guardians…');

  const numGuardians = state.n - 1;
  const corruptSet = new Set(state.corrupt || []);
  const all = Array.from({ length: numGuardians }, (_, i) => i);
  const selected = shuffleArr(all).slice(0, state.t + 1);
  const corruptInSelected = selected.filter(i => corruptSet.has(i));

  for (let i = 0; i < numGuardians; i++) hideSendLabel('', i);

  await animateReconstruct(selected, corruptSet);

  // Shamir/Traceable Shamir simulate corruption only at reconstruct time, so
  // fake the result rather than feeding wasm bogus data. Feldman's corrupt
  // shares were tampered for real back in doSplit() — let the real math run
  // so a skipped Verify step genuinely produces the wrong secret.
  if (state.mode !== 'feldman' && corruptInSelected.length > 0) {
    let fakeResult = state.secret;
    while (fakeResult === state.secret) fakeResult = Math.floor(Math.random() * 900000) + 100000;
    showOwnerSubLabel('', `key: ${fakeResult} ✗`);
    const honestAvail = numGuardians - corruptSet.size;
    setStatus(
      `Reconstruction corrupted — ${corruptInSelected.length} wrong share(s) used. Got ${fakeResult} instead of ${state.secret}. ` +
      `(Need ${state.t + 1} honest shares; only ${honestAvail} honest guardian(s) available.)`,
      'error',
    );
    updateSssValuesPanel('reconstruct', {
      shares: state.shares, selectedIndices: selected,
      corruptSet, corruptInSelected, recovered: fakeResult, ok: false,
    });
    state.phase = 'done';
    updateButtons();
    return;
  }

  const chosenShares = selected.map(i => state.shares[i]);
  let recovered;
  try {
    if (state.mode === 'shamir') {
      recovered = await wasm.shamir_reconstruct(JSON.stringify(chosenShares), state.t, state.n);
    } else if (state.mode === 'feldman') {
      recovered = await wasm.feldman_reconstruct(JSON.stringify(chosenShares), state.t, state.n);
    } else {
      recovered = await wasm.ts_reconstruct(JSON.stringify(chosenShares), state.t, state.n);
    }
  } catch (e) {
    setStatus(`Reconstruction failed: ${e.message}`, 'error');
    state.phase = 'ready';
    updateButtons();
    return;
  }

  const ok = Number(recovered) === state.secret;
  showOwnerSubLabel('', `key: ${recovered} ${ok ? '✓' : '✗'}`);
  setStatus(
    ok ? `Secret ${recovered} reconstructed correctly.`
       : corruptInSelected.length > 0
         ? `Mismatch — got ${recovered}, expected ${state.secret}. ${corruptInSelected.length} tampered share(s) were used without verifying first.`
         : `Mismatch — got ${recovered}, expected ${state.secret}.`,
    ok ? 'ok' : 'error',
  );
  updateSssValuesPanel('reconstruct', {
    shares: state.shares, selectedIndices: selected,
    corruptSet, corruptInSelected, recovered: Number(recovered), ok,
  });
  state.phase = 'done';
  updateButtons();
}

async function doTrace() {
  if (!wasm || state.mode !== 'traceable') return;
  if (state.phase !== 'ready' && state.phase !== 'done') return;
  if (!state.corrupt?.length) { setStatus('No corrupt parties to trace.'); return; }

  state.phase = 'trace';
  setStatus('Running Guruswami-Sudan oracle queries…');

  let result;
  try {
    result = await wasm.ts_trace(
      JSON.stringify(state.shares), JSON.stringify(state.tk),
      JSON.stringify(state.corrupt),
      state.t, state.n, seed(),
    );
  } catch (e) {
    setStatus(`Tracing failed: ${e.message}`, 'error');
    state.phase = 'done';
    updateButtons();
    return;
  }

  await animateTrace(result.accused);
  const names = result.accused.map(i => `G${i}`).join(', ');
  setStatus(`Identified ${result.accused.length} corrupt guardian(s): ${names}. Proof verified.`, 'ok');
  updateSssValuesPanel('trace', { accused: result.accused, numGuardians: state.n - 1 });
  state.phase = 'traced';
  updateButtons();
}

// ── UI wiring ─────────────────────────────────────────────────────────────────

function updateButtons() {
  const hasGuardians = state.n > 1;
  const readyPhases = state.phase === 'ready' || state.phase === 'done' || state.phase === 'verified';
  const canSplit       = state.secretSet && hasGuardians && state.phase === 'idle';
  const canReconstruct = hasGuardians && readyPhases;
  const canTrace       = hasGuardians && readyPhases && state.mode === 'traceable' && state.corrupt?.length > 0;
  const canVerify       = hasGuardians && readyPhases && state.mode === 'feldman';

  const btnSplit       = document.getElementById('btn-split');
  const btnReconstruct = document.getElementById('btn-reconstruct');
  const btnTrace       = document.getElementById('btn-trace');
  const btnVerify      = document.getElementById('btn-verify');

  if (btnSplit)       btnSplit.disabled       = !canSplit       || !wasm;
  if (btnReconstruct) btnReconstruct.disabled = !canReconstruct || !wasm;
  if (btnTrace) {
    btnTrace.disabled    = !canTrace || !wasm;
    btnTrace.style.display = state.mode === 'traceable' ? '' : 'none';
  }
  if (btnVerify) {
    btnVerify.disabled    = !canVerify || !wasm;
    btnVerify.style.display = state.mode === 'feldman' ? '' : 'none';
  }
}

function nextStepHint() {
  const numGuardians = state.n - 1;
  if (numGuardians < 2)  return 'Step 1: add at least 2 guardians using the slider.';
  if (!state.secretSet)  return 'Step 2: generate a key, then click Split.';
  return `Key ${state.secret} ready — click Split to distribute (${state.t + 1}-of-${numGuardians}).`;
}

function rebuildDemo() {
  const container = document.getElementById('demo-svg-container');
  if (container) buildCanvas(container, state, { prefix: '', addArrow: true });
  state.phase = 'idle';
  state.shares = [];
  state.coefficients = [];
  state.tk = [];
  state.vk = [];
  state.verified = null;
  if (state.secretSet) showOwnerSubLabel('', `key: ${state.secret}`);
  else hideOwnerSubLabel('');
  updateSssValuesPanel('idle', null);
  setStatus(nextStepHint());
  updateButtons();
}

export function initDemo() {
  const sliderNet    = document.getElementById('demo-net');
  const sliderN      = document.getElementById('demo-n');
  const sliderT      = document.getElementById('demo-t');
  const sliderCorrupt = document.getElementById('demo-corrupt');
  const labelNet     = document.getElementById('label-net');
  const labelN       = document.getElementById('label-n');
  const labelT       = document.getElementById('label-t');
  const labelCorrupt = document.getElementById('label-corrupt');
  const modeSelect   = document.getElementById('demo-mode');

  const DEFAULTS = { net: 10, corrupt: 0, n: 0, t: 1 };

  function syncSliders() {
    state.networkSize   = parseInt(sliderNet?.value    || DEFAULTS.net);
    const numGuardians  = parseInt(sliderN.value);
    state.t             = parseInt(sliderT.value);
    state.corruptCount  = parseInt(sliderCorrupt?.value || DEFAULTS.corrupt);

    const maxGuardians = Math.max(0, state.networkSize - 1);
    const clampedG = Math.min(Math.max(0, numGuardians), maxGuardians);
    if (sliderN.max !== String(maxGuardians)) sliderN.max = maxGuardians;
    if (parseInt(sliderN.value) !== clampedG) sliderN.value = clampedG;
    state.n = clampedG + 1;

    if (clampedG < 2) {
      sliderT.disabled = true; sliderT.max = 0; state.t = 0;
    } else {
      sliderT.disabled = false; sliderT.max = clampedG - 1;
      state.t = Math.max(1, Math.min(state.t, clampedG - 1));
    }
    sliderT.value = state.t;

    if (sliderCorrupt) {
      const maxCorrupt = Math.max(0, state.networkSize - 1);
      sliderCorrupt.max = maxCorrupt;
      state.corruptCount = Math.min(parseInt(sliderCorrupt.value || '0'), maxCorrupt);
      sliderCorrupt.value = state.corruptCount;
    }

    const ringNodes = Math.max(state.networkSize - 1, clampedG);
    if (labelNet)     labelNet.textContent     = `${ringNodes + 1} nodes`;
    if (labelCorrupt) labelCorrupt.textContent = state.corruptCount === 0 ? '0 corrupt' : `${state.corruptCount} corrupt`;
    if (labelN)       labelN.textContent       = `${clampedG} guardian${clampedG === 1 ? '' : 's'}`;
    if (clampedG >= 2) {
      if (labelT) labelT.textContent = `threshold ${state.t + 1}-of-${clampedG}`;
    } else {
      if (labelT) labelT.textContent = clampedG === 1 ? 'need ≥ 2 guardians' : 'no guardians';
    }
    rebuildDemo();
  }

  function doReset() {
    if (sliderNet)    sliderNet.value    = DEFAULTS.net;
    if (sliderCorrupt) sliderCorrupt.value = DEFAULTS.corrupt;
    if (sliderN)      sliderN.value      = DEFAULTS.n;
    if (sliderT)      sliderT.value      = DEFAULTS.t;
    if (modeSelect)   modeSelect.value   = 'shamir';
    state.mode              = 'shamir';
    state.guardianRingIndices = [];
    state.corruptRingIndices  = [];
    state.secretSet           = false;
    state.secret              = 0;
    state.prevRingNodes       = undefined;
    syncSliders();
  }

  sliderNet?.addEventListener('input',     syncSliders);
  sliderN?.addEventListener('input',       syncSliders);
  sliderT?.addEventListener('input',       syncSliders);
  sliderCorrupt?.addEventListener('input', syncSliders);

  modeSelect?.addEventListener('change', () => { state.mode = modeSelect.value; rebuildDemo(); });

  document.getElementById('btn-gen-secret')?.addEventListener('click',  doGenerateSecret);
  document.getElementById('btn-split')?.addEventListener('click',       doSplit);
  document.getElementById('btn-verify')?.addEventListener('click',      doVerify);
  document.getElementById('btn-reconstruct')?.addEventListener('click', doReconstruct);
  document.getElementById('btn-trace')?.addEventListener('click',       doTrace);
  document.getElementById('btn-reset')?.addEventListener('click',       doReset);

  const legendEl = document.getElementById('sss-legend');
  if (legendEl) buildLegend(legendEl, SSS_LEGEND);

  syncSliders();
}
