/**
 * CUBE PORTFOLIO — NATIVE-SCROLL TIMELINE
 *
 * Home:   cube centered, name above, hint below
 * Scroll: cube slides left, panel slides in from right
 * Next:   cube slides right, panel slides in from left
 * Pattern: cube alternates sides, content always on opposite side
 *
 * ARCHITECTURE
 * Scroll is 100% native. A tall spacer element (#scroll-spacer) gives the
 * document real height; #scene is `position:fixed`, so it stays pinned to
 * the viewport while the document scrolls behind it. We never call
 * preventDefault and never read/accumulate wheel deltaY — we only ever
 * read `window.scrollY`, which the browser (and its scrollbar, keyboard,
 * trackpad momentum, touch) manages entirely on its own.
 *
 * scrollY is mapped to a single scalar `targetProgress` ∈ [0,1]. A rAF loop
 * eases a `renderedProgress` value toward it (this is what turns discrete
 * mouse-wheel notches into fluid motion) and calls the one pure function,
 * render(progress), which derives cube pose + panel state entirely from
 * that number. Same progress in -> same visual state out, always. There is
 * no other path that mutates cube rotation, position, scale, or panel
 * opacity — no timers, no tween queues, no state that can drift out of
 * sync with scroll.
 *
 * TIMELINE
 * For each face we build four segments in order: rotate (turn from the
 * previous face into this one, scrubbed 1:1) -> panelIn (cube frozen,
 * panel slides in) -> hold (frozen, dead scroll) -> panelOut (frozen,
 * panel slides out) -> next face's rotate. The very first face has no
 * incoming rotate (nothing to rotate from) and the very last face has no
 * outgoing panelOut (nothing to transition to) — those two segments are
 * simply omitted at the open ends of the timeline.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const gsap = window.gsap;

/* ══════════════════════════════════════════════════════════════
   TUNABLE CONSTANTS
   ══════════════════════════════════════════════════════════════ */
const SCROLL_LENGTH_MULTIPLIER = 2.5;  // viewport-heights of scroll per face (overall pacing)
const W_ROTATE    = 1.4;               // relative weight of the rotate segment
const W_PANEL_IN  = 0.4;               // relative weight of the panel-in segment
const W_HOLD      = 0.6;               // relative weight of the hold (dead-scroll) segment
const W_PANEL_OUT = 0.4;               // relative weight of the panel-out segment
const LERP        = 0.14;              // 0..1 smoothing of rendered vs target progress; 1 = off (raw 1:1)
const HOME_SCALE  = 1.9;

/* ══════════════════════════════════════════════════════════════
   CONFIG
   ══════════════════════════════════════════════════════════════ */
const CONFIG = {
  faces: ['Home', 'About', 'Skills', 'Experience', 'Projects', 'Contact'],
};

const FACE_ACCENTS = [
  '#555555',  // 0 Home       — neutral
  '#2DBB6B',  // 1 About      — green
  '#F06B20',  // 2 Skills     — orange
  '#C49B00',  // 3 Experience — amber
  '#E8293A',  // 4 Projects   — red
  '#2979F2',  // 5 Contact    — blue
];

/* ══════════════════════════════════════════════════════════════
   FACE ROTATION MAP — unchanged rotation keyframes / visual path.
   Index 0 shows the white (+y) face toward camera.
   ══════════════════════════════════════════════════════════════ */
const FACE_ROTATIONS = [
  { euler: [ Math.PI / 2, 0, 0],  label: 'Home'       }, // +y (white)  → front
  { euler: [0, 0, 0],             label: 'About'      }, // +z (green)  → front
  { euler: [0,  Math.PI / 2, 0],  label: 'Skills'     }, // -x (red)    → front
  { euler: [-Math.PI / 2, 0, 0],  label: 'Experience' }, // -y (yellow) → front
  { euler: [0, -Math.PI / 2, 0],  label: 'Projects'   }, // +x (orange) → front
  { euler: [0, -Math.PI, 0],      label: 'Contact'    }, // -z (green)  → front
];

/* ══════════════════════════════════════════════════════════════
   POSITION HELPERS — unchanged
   ══════════════════════════════════════════════════════════════ */
function getCubeTargetX(faceIdx) {
  if (faceIdx === 0) return 0;
  return faceIdx % 2 === 1 ? -2.2 : 2.2;
}

function getCubeTargetY(faceIdx) {
  return faceIdx === 0 ? -2.4 : 0;
}

function getCubeTargetScale(faceIdx) {
  return faceIdx === 0 ? HOME_SCALE : 1;
}

function getPanelClass(faceIdx) {
  return faceIdx % 2 === 1 ? 'on-right' : 'on-left';
}

function nearAngle(from, to) {
  const d = ((to - from) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  return from + d;
}

function smoothstep(t) {
  t = Math.min(Math.max(t, 0), 1);
  return t * t * (3 - 2 * t);
}

function facePose(idx) {
  return {
    euler: FACE_ROTATIONS[idx].euler,
    x: getCubeTargetX(idx),
    y: getCubeTargetY(idx),
    scale: getCubeTargetScale(idx),
  };
}

/* ══════════════════════════════════════════════════════════════
   TIMELINE — ordered, weighted segments built once from the
   (unmodified) face keyframes above.
   ══════════════════════════════════════════════════════════════ */
function buildSegments() {
  const segs = [];
  for (let i = 0; i < FACE_ROTATIONS.length; i++) {
    const pose = facePose(i);
    if (i > 0) {
      segs.push({ type: 'rotate', faceIdx: i, from: facePose(i - 1), to: pose, weight: W_ROTATE });
    }
    segs.push({ type: 'panelIn', faceIdx: i, pose, weight: W_PANEL_IN });
    segs.push({ type: 'hold',    faceIdx: i, pose, weight: W_HOLD });
    if (i < FACE_ROTATIONS.length - 1) {
      segs.push({ type: 'panelOut', faceIdx: i, pose, weight: W_PANEL_OUT });
    }
  }
  const totalWeight = segs.reduce((sum, s) => sum + s.weight, 0);
  let acc = 0;
  for (const seg of segs) {
    seg.start = acc / totalWeight;
    acc += seg.weight;
    seg.end = acc / totalWeight;
  }
  return segs;
}

const SEGMENTS = buildSegments();

function locateSegment(p) {
  for (const seg of SEGMENTS) {
    if (p <= seg.end) {
      const span = seg.end - seg.start;
      const t = span > 0 ? (p - seg.start) / span : 1;
      return { segment: seg, t: Math.min(Math.max(t, 0), 1) };
    }
  }
  const last = SEGMENTS[SEGMENTS.length - 1];
  return { segment: last, t: 1 };
}

/* ══════════════════════════════════════════════════════════════
   THREE.JS GLOBALS
   ══════════════════════════════════════════════════════════════ */
let renderer, scene, camera;
let cubeGroup;

let glbReady = false;
let onGlbReady = null;

/* ══════════════════════════════════════════════════════════════
   SCENE SETUP
   ══════════════════════════════════════════════════════════════ */
function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xF7F6F2);

  camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, 9.5);
  camera.lookAt(0, 0, 0);

  const canvas = document.getElementById('main-canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  buildLights();
  loadGLB();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    layoutScrollSpacer();
    refreshTargetProgress();
  });

  renderLoop();
}

function buildLights() {
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(5, 7, 8);
  key.castShadow = true;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xffffff, 0.55);
  fill.position.set(-5, -2, 4);
  scene.add(fill);

  const top = new THREE.DirectionalLight(0xfff8f0, 0.4);
  top.position.set(0, 8, 2);
  scene.add(top);

  const ambient = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambient);
}

/* ══════════════════════════════════════════════════════════════
   GLB LOADER
   ══════════════════════════════════════════════════════════════ */
function loadGLB() {
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);

  const signalReady = () => {
    glbReady = true;
    const cb = onGlbReady;
    onGlbReady = null;
    cb?.();
  };

  loader.load('./assets/rubiks_cube.glb', gltf => {
    const model = gltf.scene;
    const box   = new THREE.Box3().setFromObject(model);
    const size  = box.getSize(new THREE.Vector3());
    const maxD  = Math.max(size.x, size.y, size.z);
    const scale = 3.0 / maxD;
    model.scale.setScalar(scale);
    model.position.sub(box.getCenter(new THREE.Vector3()).multiplyScalar(scale));

    model.traverse(c => {
      if (c.isMesh) {
        c.castShadow = true;
        c.receiveShadow = true;
        if (c.material) { c.material.metalness = 0.15; c.material.roughness = 0.4; }
      }
    });

    const newGroup = new THREE.Group();
    newGroup.add(model);
    newGroup.rotation.set(...FACE_ROTATIONS[0].euler);
    newGroup.position.set(0, getCubeTargetY(0), 0);
    newGroup.scale.setScalar(HOME_SCALE);
    scene.add(newGroup);
    cubeGroup = newGroup;

    signalReady();
  }, undefined, err => {
    console.warn('GLB failed to load:', err.message);
    signalReady();
  });
}

/* ══════════════════════════════════════════════════════════════
   NATIVE SCROLL → PROGRESS
   ══════════════════════════════════════════════════════════════ */
let scrollSpacerTop = 0;
let scrollRange      = 1; // containerHeight - viewportHeight, guarded against 0
let targetProgress   = 0;
let renderedProgress = 0;

function layoutScrollSpacer() {
  const spacer = document.getElementById('scroll-spacer');
  const height = window.innerHeight * SCROLL_LENGTH_MULTIPLIER * FACE_ROTATIONS.length;
  spacer.style.height = height + 'px';
  scrollSpacerTop = spacer.offsetTop;
  scrollRange = Math.max(height - window.innerHeight, 1);
}

function refreshTargetProgress() {
  targetProgress = Math.min(Math.max((window.scrollY - scrollSpacerTop) / scrollRange, 0), 1);
}

function scrollToFace(faceIdx) {
  const holdSeg = SEGMENTS.find(s => s.faceIdx === faceIdx && s.type === 'hold');
  if (!holdSeg) return;
  const midProgress = (holdSeg.start + holdSeg.end) / 2;
  window.scrollTo({ top: scrollSpacerTop + midProgress * scrollRange, behavior: 'smooth' });
}

/* ══════════════════════════════════════════════════════════════
   RENDER LOOP
   ══════════════════════════════════════════════════════════════ */
function renderLoop() {
  requestAnimationFrame(renderLoop);

  renderedProgress += (targetProgress - renderedProgress) * LERP;
  if (Math.abs(targetProgress - renderedProgress) < 0.0006) renderedProgress = targetProgress;

  if (cubeGroup) render(renderedProgress);

  renderer.render(scene, camera);
}

/* ══════════════════════════════════════════════════════════════
   THE PURE RENDER FUNCTION
   Given the same progress, always produces the same cube pose and
   panel state. Nothing else in this file writes to cube rotation,
   position, scale, or panel opacity.
   ══════════════════════════════════════════════════════════════ */
function render(p) {
  const { segment, t } = locateSegment(p);
  const e = smoothstep(t);

  let pose, faceIdx, reveal;

  if (segment.type === 'rotate') {
    const from = segment.from, to = segment.to;
    pose = {
      euler: [
        from.euler[0] + (nearAngle(from.euler[0], to.euler[0]) - from.euler[0]) * e,
        from.euler[1] + (nearAngle(from.euler[1], to.euler[1]) - from.euler[1]) * e,
        0,
      ],
      x: from.x + (to.x - from.x) * e,
      y: from.y + (to.y - from.y) * e,
      scale: from.scale + (to.scale - from.scale) * e,
    };
    faceIdx = segment.faceIdx; // the face being rotated INTO
    reveal  = 0;               // cube is turning — panel/overlay stays hidden
  } else {
    pose    = segment.pose;    // cube frozen at this face's resting pose
    faceIdx = segment.faceIdx;
    if (segment.type === 'panelIn')  reveal = e;
    if (segment.type === 'hold')     reveal = 1;
    if (segment.type === 'panelOut') reveal = 1 - e;
  }

  applyCubePose(pose);
  applyContent(faceIdx, reveal);
}

function applyCubePose(pose) {
  cubeGroup.rotation.set(pose.euler[0], pose.euler[1], 0);
  cubeGroup.position.set(pose.x, pose.y, 0);
  cubeGroup.scale.setScalar(pose.scale);
}

let lastRenderedFace = null;
let activeFaceEl     = null;
let activeAccentBar  = null;

function applyContent(faceIdx, reveal) {
  if (faceIdx !== lastRenderedFace) {
    setActivePanel(faceIdx);
    lastRenderedFace = faceIdx;
    updateChrome(faceIdx);
  }

  const homeEl  = document.getElementById('Home-overlay');
  const panelEl = document.getElementById('side-panel');
  const interactive = reveal > 0.5 ? 'auto' : 'none';

  if (faceIdx === 0) {
    gsap.set(homeEl, { opacity: reveal, y: (1 - reveal) * 16 });
    gsap.set(panelEl, { opacity: 0 });
    homeEl.style.pointerEvents  = interactive;
    panelEl.style.pointerEvents = 'none';
  } else {
    const dir = faceIdx % 2 === 1 ? 1 : -1;
    gsap.set(panelEl, { opacity: reveal, x: (1 - reveal) * 40 * dir });
    gsap.set(homeEl, { opacity: 0 });
    panelEl.style.pointerEvents = interactive;
    homeEl.style.pointerEvents  = 'none';
    if (activeFaceEl)    activeFaceEl.style.pointerEvents = interactive;
    if (activeAccentBar) gsap.set(activeAccentBar, { scaleX: reveal });
  }

  applyStickerGlow(reveal);
}

function applyStickerGlow(reveal) {
  const intensity = 0.04 + reveal * 0.16;
  cubeGroup.traverse(c => {
    if (c.isMesh && c.userData.isSticker && c.material) {
      c.material.emissiveIntensity = intensity;
    }
  });
}

function setActivePanel(faceIdx) {
  document.querySelectorAll('.panel-face').forEach(f => {
    f.style.opacity       = '0';
    f.style.pointerEvents = 'none';
  });
  activeAccentBar = null;
  activeFaceEl    = null;

  if (faceIdx !== 0) {
    document.getElementById('side-panel').className = getPanelClass(faceIdx);
    const face = document.getElementById(`panel-${faceIdx}`);
    if (face) {
      face.style.opacity = '1';
      activeFaceEl        = face;
      activeAccentBar      = face.querySelector('.panel-accent-bar');
    }
  }
}

/* ══════════════════════════════════════════════════════════════
   CHROME UPDATE
   ══════════════════════════════════════════════════════════════ */
function updateChrome(idx) {
  const faceText = document.getElementById('face-tag-text');
  const faceIdx  = document.getElementById('face-tag-idx');
  if (faceText) faceText.textContent = CONFIG.faces[idx];
  if (faceIdx)  faceIdx.textContent  = String(idx + 1).padStart(2, '0');

  document.querySelectorAll('.nav-label').forEach((d, i) => d.classList.toggle('active', i === idx));
  const pageName = document.getElementById('page-name');
  if (pageName) pageName.style.opacity = idx === 0 ? '0' : '1';

  document.documentElement.style.setProperty('--accent-global', FACE_ACCENTS[idx]);
}

/* ══════════════════════════════════════════════════════════════
   INPUT
   Nav-dot clicks are the only custom input: they call native
   window.scrollTo(), which is not scroll hijacking — it doesn't touch
   wheel/touch handling and the user can interrupt it by scrolling at
   any time. Everything else (wheel, trackpad, touch, scrollbar drag,
   Space/PageDown/arrow keys) is untouched, native browser scrolling.
   ══════════════════════════════════════════════════════════════ */
function initInput() {
  window.addEventListener('scroll', refreshTargetProgress, { passive: true });

  document.querySelectorAll('.nav-label').forEach(dot => {
    dot.addEventListener('click', () => scrollToFace(parseInt(dot.dataset.idx, 10)));
  });
}

/* ═════════════════════════════════════════════════════════════
   PRELOADER
   ═════════════════════════════════════════════════════════════ */
function runPreloader(onDone) {
  const canvas = document.getElementById('pre-canvas');
  canvas.width  = 100;
  canvas.height = 100;
  const ctx = canvas.getContext('2d');
  const bar = document.getElementById('pre-bar');
  const lbl = document.getElementById('pre-label');

  const dots = ['', '.', '..', '...'];
  let dotIdx = 0;
  const dotTimer = setInterval(() => {
    dotIdx = (dotIdx + 1) % 4;
    lbl.textContent = 'Loading' + dots[dotIdx];
  }, 380);

  let prog = 0, done = false;

  function drawCube(t) {
    ctx.clearRect(0, 0, 100, 100);
    const cx = 50, cy = 50;
    const s  = Math.min(t, 1);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * Math.PI * 1.4);
    ctx.scale(s * 0.88, s * 0.88);
    // Top face
    ctx.beginPath(); ctx.moveTo(0,-28); ctx.lineTo(24,-15); ctx.lineTo(0,-2); ctx.lineTo(-24,-15); ctx.closePath();
    ctx.fillStyle = '#1968D2'; ctx.fill();
    // Left face
    ctx.beginPath(); ctx.moveTo(-24,-15); ctx.lineTo(0,-2); ctx.lineTo(0,22); ctx.lineTo(-24,9); ctx.closePath();
    ctx.fillStyle = '#2B8A57'; ctx.fill();
    // Right face
    ctx.beginPath(); ctx.moveTo(0,-2); ctx.lineTo(24,-15); ctx.lineTo(24,9); ctx.lineTo(0,22); ctx.closePath();
    ctx.fillStyle = '#D93A2F'; ctx.fill();
    // Edges
    ctx.strokeStyle = 'rgba(0,0,0,0.1)'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(0,-28); ctx.lineTo(24,-15); ctx.lineTo(0,-2); ctx.lineTo(-24,-15); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,-2); ctx.lineTo(0,22); ctx.moveTo(-24,-15); ctx.lineTo(-24,9); ctx.moveTo(24,-15); ctx.lineTo(24,9); ctx.stroke();
    ctx.restore();
  }

  function fadeOut() {
    setTimeout(() => {
      gsap.to('#preloader', {
        opacity: 0, duration: 0.65, ease: 'power2.inOut',
        onComplete: () => {
          document.getElementById('preloader').style.display = 'none';
          onDone();
        }
      });
    }, 300);
  }

  function finish() {
    if (done) return;
    done = true;
    clearInterval(dotTimer);
    bar.style.width = '100%';
    lbl.textContent = 'Ready';
    if (glbReady) {
      fadeOut();
    } else {
      onGlbReady = fadeOut;
    }
  }

  const START = Date.now(), DUR = 2200;
  const timer = setInterval(() => {
    prog = Math.min((Date.now() - START) / DUR, 1);
    bar.style.width = (prog * 100) + '%';
    drawCube(prog);
    if (prog >= 1) { clearInterval(timer); finish(); }
  }, 16);

  // Safety: if GLB never loads, unblock after 12s
  setTimeout(() => {
    if (!glbReady) {
      glbReady = true;
      const cb = onGlbReady;
      onGlbReady = null;
      cb?.();
    }
    finish();
  }, 12000);

  canvas.parentElement.addEventListener('click', finish, { once: true });
  document.addEventListener('keydown', finish, { once: true });
}

/* ══════════════════════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════════════════════ */
function boot() {
  // Start loading Three.js + GLB immediately, in parallel with the preloader
  initThree();
  layoutScrollSpacer();

  runPreloader(() => {
    gsap.to('#scene', { opacity: 1, duration: 0.7, ease: 'power2.out' });

    initInput();
    // Sync immediately to whatever scrollY already is (e.g. a mid-scroll
    // refresh) — no animate-in-from-zero, just the correct pure state.
    refreshTargetProgress();
    renderedProgress = targetProgress;
  });
}

boot();
