'use strict';

// Whistle - main thread: UI, parameter plumbing and the 2D view.
// All physics and audio live in the AudioWorklet (see the inline source block
// in index.html); this file only sends parameters down and draws what comes back.

const SOUND_SPEED = 343;          // must match the worklet
const AIR_DB_PER_M_AT_1KHZ = 0.005;   // must match the worklet
const TRAIL_MAX = 2600;           // trail points kept (~7 s at the post rate)

// -3 dB point of the air-absorption low-pass for a path of the given length.
function airCutoff(distance) {
  const k = AIR_DB_PER_M_AT_1KHZ * params.airAbsorption;
  if (k <= 0) return Infinity;
  return 1000 * Math.sqrt(3 / (k * Math.max(distance, 0.01)));
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const GROUPS = [
  ['Domain', [
    { key: 'domain',       label: 'Domain size',      min: 1,    max: 1000, log: true, def: 120,
      fmt: v => (v < 10 ? v.toFixed(1) : v.toFixed(0)) + ' m' },
    { key: 'absorption',   label: 'Wall reflection',  min: 0,    max: 0.98, def: 0.55,
      fmt: v => v.toFixed(2) + (v < 0.05 ? ' (anechoic)' : v > 0.9 ? ' (hard walls)' : '') },
    { key: 'order',        label: 'Reflection order', min: 0,    max: 4, step: 1, def: 2,
      fmt: v => String(v) },
    { key: 'airAbsorption', label: 'Air absorption',  min: 0,    max: 4, def: 1,
      fmt: v => v === 0 ? 'off' : v.toFixed(2) + ' x' }
  ]],
  ['Pendulum', [
    { key: 'armSpan',      label: 'Arm span',         min: 0.05, max: 0.45, def: 0.40,
      fmt: v => (v * 100).toFixed(0) + '% of domain' },
    { key: 'timeScale',    label: 'Time scale',       min: 0.05, max: 20, log: true, def: 1,
      fmt: v => v.toFixed(2) + ' x' },
    { key: 'gravity',      label: 'Gravity',          min: 0.5,  max: 50, log: true, def: 9.81,
      fmt: v => v.toFixed(2) + ' m/s2' },
    { key: 'damping',      label: 'Damping',          min: 0,    max: 0.5, def: 0,
      fmt: v => v.toFixed(3) + ' 1/s' }
  ]],
  ['Whistle', [
    { key: 'baseFreq',     label: 'Base frequency',   min: 150,  max: 4000, log: true, def: 850,
      fmt: v => v.toFixed(0) + ' Hz' },
    { key: 'harmonics',    label: 'Harmonics',        min: 0,    max: 1, def: 0.55,
      fmt: v => v.toFixed(2) },
    { key: 'noiseMix',     label: 'Breath noise',     min: 0,    max: 1, def: 0.12,
      fmt: v => v.toFixed(2) },
    { key: 'warble',       label: 'Warble',           min: 0,    max: 1, def: 0.20,
      fmt: v => v.toFixed(2) },
    { key: 'speedToPitch', label: 'Speed to pitch',   min: 0,    max: 2, def: 0,
      fmt: v => v === 0 ? 'off' : v.toFixed(2) }
  ]],
  ['Output', [
    { key: 'gain',         label: 'Master gain',      min: 0,    max: 1, def: 0.2,
      fmt: v => v.toFixed(2) },
    { key: 'crossfeed',    label: 'Crossfeed',        min: 0,    max: 0.5, def: 0,
      fmt: v => v === 0 ? 'off (hard L/R)' : v.toFixed(2) }
  ]]
];

const params = {
  // Just outside the disc the whistle sweeps, so it swings close past each
  // microphone without ever sitting on top of it.
  micL: [0.25, 0.72],
  micR: [0.75, 0.72],
  running: true,
  muted: false
};
for (const [, specs] of GROUPS) for (const s of specs) params[s.key] = s.def;

// ---------------------------------------------------------------------------
// Local mirror of what the worklet reports, so the view has something to draw
// before the audio context exists.
// ---------------------------------------------------------------------------

const state = { th1: 2.40, th2: 2.55, jx: 0, jy: 0, tx: 0, ty: 0, speed: 0, freq: params.baseFreq };
const trail = [];
const waves = [];
let lastWaveAt = 0;

function poseFromAngles() {
  const arm = params.armSpan * 0.5;   // normalized: independent of domain size
  state.jx = 0.5 + arm * Math.sin(state.th1);
  state.jy = 0.5 + arm * Math.cos(state.th1);
  state.tx = state.jx + arm * Math.sin(state.th2);
  state.ty = state.jy + arm * Math.cos(state.th2);
}
poseFromAngles();

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

let ctx = null;
let node = null;

async function startAudio() {
  ctx = new AudioContext();
  const source = document.getElementById('worklet-source').textContent;
  const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } catch (err) {
    // Opaque-origin pages (file://) can reject blob module scripts; a data URL
    // carrying the same source is the fallback.
    const encoded = btoa(unescape(encodeURIComponent(source)));
    await ctx.audioWorklet.addModule('data:application/javascript;base64,' + encoded);
  } finally {
    URL.revokeObjectURL(url);
  }
  node = new AudioWorkletNode(ctx, 'whistle-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2]
  });
  node.port.onmessage = onWorkletState;
  node.connect(ctx.destination);
  send(params);
  await ctx.resume();
}

function send(patch) {
  if (node) node.port.postMessage({ type: 'params', params: patch });
}

function setParam(key, value) {
  params[key] = value;
  send({ [key]: value });
}

function onWorkletState(e) {
  const s = e.data;
  state.th1 = s.th1;
  state.th2 = s.th2;
  state.jx = s.jx; state.jy = s.jy;
  state.tx = s.tx; state.ty = s.ty;
  state.speed = s.speed;
  state.freq = s.freq;
  const t = s.trail;
  for (let i = 0; i < t.length; i += 2) trail.push(t[i], t[i + 1]);
  const overflow = trail.length - TRAIL_MAX * 2;
  if (overflow > 0) trail.splice(0, overflow);
}

// ---------------------------------------------------------------------------
// Control panel
// ---------------------------------------------------------------------------

function fromSlider(spec, raw) {
  if (spec.step) return raw;
  const t = raw / 1000;
  return spec.log
    ? spec.min * Math.pow(spec.max / spec.min, t)
    : spec.min + t * (spec.max - spec.min);
}

function toSlider(spec, v) {
  if (spec.step) return v;
  const t = spec.log
    ? Math.log(v / spec.min) / Math.log(spec.max / spec.min)
    : (v - spec.min) / (spec.max - spec.min);
  return Math.round(t * 1000);
}

function buildPanel() {
  const host = document.getElementById('groups');
  for (const [title, specs] of GROUPS) {
    const h = document.createElement('h2');
    h.textContent = title;
    host.appendChild(h);
    for (const spec of specs) {
      const label = document.createElement('label');
      label.className = 'ctl';
      const row = document.createElement('div');
      row.className = 'row';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = spec.label;
      const val = document.createElement('span');
      val.className = 'val';
      row.append(name, val);

      const input = document.createElement('input');
      input.type = 'range';
      if (spec.step) {
        input.min = spec.min; input.max = spec.max; input.step = spec.step;
      } else {
        input.min = 0; input.max = 1000; input.step = 1;
      }
      input.value = toSlider(spec, spec.def);
      val.textContent = spec.fmt(spec.def);

      input.addEventListener('input', () => {
        const v = fromSlider(spec, Number(input.value));
        val.textContent = spec.fmt(v);
        setParam(spec.key, v);
        if (spec.key === 'armSpan' && !params.running) poseFromAngles();
        if (spec.key === 'domain' || spec.key === 'armSpan') trail.length = 0;
      });

      label.append(row, input);
      host.appendChild(label);
    }
  }
}

function randomize() {
  state.th1 = (Math.random() * 2 - 1) * Math.PI;
  state.th2 = (Math.random() * 2 - 1) * Math.PI;
  trail.length = 0;
  waves.length = 0;
  poseFromAngles();
  if (node) node.port.postMessage({ type: 'state', th1: state.th1, th2: state.th2 });
}

function reset() {
  state.th1 = 2.40;
  state.th2 = 2.55;
  trail.length = 0;
  waves.length = 0;
  poseFromAngles();
  if (node) node.port.postMessage({ type: 'state', th1: state.th1, th2: state.th2 });
}

function wireButtons() {
  const audioBtn = document.getElementById('btn-audio');
  const pauseBtn = document.getElementById('btn-pause');

  audioBtn.addEventListener('click', async () => {
    if (!ctx) {
      audioBtn.disabled = true;
      try {
        await startAudio();
        audioBtn.textContent = 'Suspend audio';
        audioBtn.classList.add('on');
        document.getElementById('overlay').classList.add('hidden');
      } catch (err) {
        audioBtn.textContent = 'Audio failed';
        document.getElementById('overlay').textContent = 'Audio failed: ' + err.message;
        console.error(err);
      } finally {
        audioBtn.disabled = false;
      }
      return;
    }
    if (ctx.state === 'running') {
      await ctx.suspend();
      audioBtn.textContent = 'Resume audio';
      audioBtn.classList.remove('on');
    } else {
      await ctx.resume();
      audioBtn.textContent = 'Suspend audio';
      audioBtn.classList.add('on');
    }
  });

  pauseBtn.addEventListener('click', () => {
    params.running = !params.running;
    send({ running: params.running });
    pauseBtn.textContent = params.running ? 'Pause' : 'Resume';
    pauseBtn.classList.toggle('on', !params.running);
  });

  document.getElementById('btn-reset').addEventListener('click', reset);
  document.getElementById('btn-random').addEventListener('click', randomize);

  document.getElementById('chk-mute').addEventListener('change', (e) => {
    params.muted = e.target.checked;
    send({ muted: params.muted });
  });

  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); pauseBtn.click(); }
    else if (e.key === 'r' || e.key === 'R') randomize();
  });
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

const canvas = document.getElementById('view');
const g = canvas.getContext('2d');
let size = 600;

function resize() {
  const wrap = document.getElementById('canvas-wrap');
  const dpr = devicePixelRatio || 1;
  size = Math.max(160, Math.floor(Math.min(wrap.clientWidth, wrap.clientHeight)));
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  canvas.width = Math.floor(size * dpr);
  canvas.height = Math.floor(size * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function micHit(nx, ny) {
  const r = 16 / size;
  for (const key of ['micL', 'micR']) {
    const m = params[key];
    if (Math.hypot(m[0] - nx, m[1] - ny) < r) return key;
  }
  return null;
}

let dragging = null;

function wireCanvas() {
  const toNorm = (e) => {
    const b = canvas.getBoundingClientRect();
    return [(e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height];
  };

  canvas.addEventListener('pointerdown', (e) => {
    const [nx, ny] = toNorm(e);
    dragging = micHit(nx, ny);
    if (dragging) {
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const [nx, ny] = toNorm(e);
    if (!dragging) {
      canvas.style.cursor = micHit(nx, ny) ? 'grab' : 'crosshair';
      return;
    }
    const clamp = (v) => Math.max(0.01, Math.min(0.99, v));
    params[dragging] = [clamp(nx), clamp(ny)];
    send({ [dragging]: params[dragging] });
  });

  const end = (e) => {
    if (dragging) {
      canvas.releasePointerCapture(e.pointerId);
      dragging = null;
    }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

function drawMic(nx, ny, color, label) {
  const x = nx * size, y = ny * size;
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = 2;
  g.beginPath();
  g.arc(x, y, 7, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.arc(x, y, 2.5, 0, Math.PI * 2);
  g.fill();
  g.font = '600 11px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText(label, x, y - 12);
}

function draw() {
  requestAnimationFrame(draw);

  const S = params.domain;
  const now = performance.now() / 1000;

  // --- wavefronts: emitted in real time, expanding at the real speed of sound
  if (document.getElementById('chk-waves').checked && ctx && ctx.state === 'running') {
    const interval = Math.max(0.06, S / SOUND_SPEED / 8);
    if (now - lastWaveAt > interval) {
      lastWaveAt = now;
      waves.push({ x: state.tx, y: state.ty, t: now });
      if (waves.length > 64) waves.shift();
    }
  }
  while (waves.length && (now - waves[0].t) * SOUND_SPEED / S > 1.7) waves.shift();

  g.clearRect(0, 0, size, size);

  // --- domain
  g.fillStyle = '#11161c';
  g.fillRect(0, 0, size, size);
  const wallAlpha = 0.25 + 0.75 * params.absorption;
  g.strokeStyle = 'rgba(120, 200, 255, ' + wallAlpha.toFixed(3) + ')';
  g.lineWidth = 1 + 4 * params.absorption;
  g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, size - g.lineWidth, size - g.lineWidth);

  // --- wavefronts
  if (document.getElementById('chk-waves').checked) {
    g.lineWidth = 1;
    for (const wv of waves) {
      const rn = (now - wv.t) * SOUND_SPEED / S;   // radius, normalized
      if (rn <= 0) continue;
      const a = Math.max(0, 0.30 * (1 - rn / 1.7));
      g.strokeStyle = 'rgba(88, 200, 255, ' + a.toFixed(3) + ')';
      g.beginPath();
      g.arc(wv.x * size, wv.y * size, rn * size, 0, Math.PI * 2);
      g.stroke();
    }
  }

  // --- trail
  if (document.getElementById('chk-trail').checked && trail.length >= 4) {
    const stroke = (from, alpha, width) => {
      g.strokeStyle = 'rgba(255, 212, 94, ' + alpha + ')';
      g.lineWidth = width;
      g.beginPath();
      g.moveTo(trail[from] * size, trail[from + 1] * size);
      for (let i = from + 2; i < trail.length; i += 2) g.lineTo(trail[i] * size, trail[i + 1] * size);
      g.stroke();
    };
    stroke(0, 0.16, 1);
    stroke(Math.max(0, trail.length - 600), 0.5, 1.2);
  }

  // --- pendulum
  const ax = 0.5 * size, ay = 0.5 * size;
  const jx = state.jx * size, jy = state.jy * size;
  const tx = state.tx * size, ty = state.ty * size;

  g.strokeStyle = '#5b6b7d';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(ax, ay); g.lineTo(jx, jy); g.lineTo(tx, ty);
  g.stroke();

  g.fillStyle = '#5b6b7d';
  g.beginPath(); g.arc(ax, ay, 4, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#8fa2b6';
  g.beginPath(); g.arc(jx, jy, 4.5, 0, Math.PI * 2); g.fill();

  // whistle head, pulsing slightly so it reads as a sound source
  const pulse = params.muted ? 0 : 3 * (0.5 + 0.5 * Math.sin(now * 12));
  g.fillStyle = 'rgba(255, 212, 94, 0.18)';
  g.beginPath(); g.arc(tx, ty, 8 + pulse, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffd45e';
  g.beginPath(); g.arc(tx, ty, 5, 0, Math.PI * 2); g.fill();

  // --- sight lines to the microphones
  g.setLineDash([3, 4]);
  g.lineWidth = 1;
  g.strokeStyle = 'rgba(255, 138, 92, 0.4)';
  g.beginPath(); g.moveTo(tx, ty); g.lineTo(params.micL[0] * size, params.micL[1] * size); g.stroke();
  g.strokeStyle = 'rgba(126, 224, 129, 0.4)';
  g.beginPath(); g.moveTo(tx, ty); g.lineTo(params.micR[0] * size, params.micR[1] * size); g.stroke();
  g.setLineDash([]);

  drawMic(params.micL[0], params.micL[1], '#ff8a5c', 'L');
  drawMic(params.micR[0], params.micR[1], '#7ee081', 'R');

  updateReadout(S);
}

function updateReadout(S) {
  const dL = Math.hypot((params.micL[0] - state.tx) * S, (params.micL[1] - state.ty) * S);
  const dR = Math.hypot((params.micR[0] - state.tx) * S, (params.micR[1] - state.ty) * S);
  const tL = dL / SOUND_SPEED * 1000;
  const tR = dR / SOUND_SPEED * 1000;
  const n = Math.max(0, Math.min(4, Math.round(params.order)));

  const set = (id, text) => { document.getElementById(id).textContent = text; };
  set('ro-ld', dL.toFixed(dL < 10 ? 2 : 1) + ' m');
  set('ro-rd', dR.toFixed(dR < 10 ? 2 : 1) + ' m');
  set('ro-lt', tL.toFixed(2) + ' ms');
  set('ro-rt', tR.toFixed(2) + ' ms');
  set('ro-itd', (tL - tR >= 0 ? '+' : '') + (tL - tR).toFixed(2) + ' ms');
  set('ro-freq', state.freq.toFixed(0) + ' Hz');
  set('ro-speed', state.speed.toFixed(1) + ' m/s  (M ' + (state.speed / SOUND_SPEED).toFixed(2) + ')');
  const khz = (d) => (airCutoff(d) / 1000).toFixed(airCutoff(d) < 10000 ? 1 : 0);
  set('ro-air', isFinite(airCutoff(dL)) ? khz(dL) + ' / ' + khz(dR) + ' kHz' : 'off');
  set('ro-img', String(2 * n * n + 2 * n + 1));
}

// ---------------------------------------------------------------------------

buildPanel();
wireButtons();
wireCanvas();
new ResizeObserver(resize).observe(document.getElementById('canvas-wrap'));
resize();
draw();
