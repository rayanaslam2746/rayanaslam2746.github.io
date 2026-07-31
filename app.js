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
 * incoming rotate or panelIn (nothing to transition in from — name and
 * hint are already fully visible at progress=0, on load, not something
 * you have to scroll to reveal) and the very last face has no outgoing
 * panelOut (nothing to transition to) — those segments are simply
 * omitted at the open ends of the timeline.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const gsap = window.gsap;

// Chosen once at load; the same 768px breakpoint used in style.css. Desktop
// and mobile share one scene/camera/renderer/GLB/preloader and diverge only
// at the fork hooks marked IS_MOBILE below.
const IS_MOBILE = window.matchMedia('(max-width: 768px)').matches;

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
const NAV_RAD_PER_MS = (Math.PI / 2) / 450; // constant angular speed for nav-click turns: a 90° hop takes ~900ms, further hops scale proportionally
const NAV_PANEL_MS   = 220;                 // fixed fade duration bookending a nav-click turn (departure/arrival panel only)

// Mobile-only tunables (see initMobile below).
const MOBILE_CUBE_Y      = 1.6;   // world-units up: centers cube in the top half. Tune on device.
const MOBILE_CUBE_SCALE  = 0.8;   // cube size on mobile. Tune on device so it fills the top half with margin.
const MOBILE_ROT_SPEED   = 0.008; // radians of cube rotation per px of finger drag
const MOBILE_SNAP_MS     = 420;   // ease-to-nearest-face duration on release
const MOBILE_DRAG_THRESH = 6;     // px of movement before a touch counts as a drag (below this = a tap, ignored)

// The browser restoring a previous scroll position on refresh would fight
// "always start on Home" below — take manual control of that immediately.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

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
      // Every face but the first has something to transition in from.
      // Face 0 has no predecessor — it's just already there at progress=0,
      // name and hint fully visible on load, not something you have to
      // scroll to reveal.
      segs.push({ type: 'rotate',  faceIdx: i, from: facePose(i - 1), to: pose, weight: W_ROTATE });
      segs.push({ type: 'panelIn', faceIdx: i, pose, weight: W_PANEL_IN });
    }
    // Home (face 0) has no incoming rotate/panelIn to hold before — giving it
    // a normal dead-scroll hold would make the very first bit of scroll do
    // nothing (a "lock") before the transition away finally kicks in. Zero
    // it out so leaving Home animates the instant the user scrolls, while
    // still keeping a (zero-width) hold segment so nav-click-to-Home has
    // something to target.
    segs.push({ type: 'hold',    faceIdx: i, pose, weight: i === 0 ? 0 : W_HOLD });
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
  if (IS_MOBILE) { spacer.style.height = '0px'; scrollRange = 1; return; }
  const height = window.innerHeight * SCROLL_LENGTH_MULTIPLIER * FACE_ROTATIONS.length;
  spacer.style.height = height + 'px';
  scrollSpacerTop = spacer.offsetTop;
  scrollRange = Math.max(height - window.innerHeight, 1);
}

function refreshTargetProgress() {
  targetProgress = Math.min(Math.max((window.scrollY - scrollSpacerTop) / scrollRange, 0), 1);
}

/* ══════════════════════════════════════════════════════════════
   RENDER LOOP
   ══════════════════════════════════════════════════════════════ */
function renderLoop() {
  requestAnimationFrame(renderLoop);

  renderedProgress += (targetProgress - renderedProgress) * LERP;
  if (Math.abs(targetProgress - renderedProgress) < 0.0006) renderedProgress = targetProgress;

  // A nav-click jump (see runNavJump) owns the cube/panel state while it's
  // in flight — the scroll-progress render() below sits out until it's done.
  // On mobile the cube pose is owned entirely by the mobile touch controller.
  if (!IS_MOBILE && cubeGroup && !navAnimating) render(renderedProgress);

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
let currentReveal    = 1; // last reveal value applied, so a nav-click jump can pick up from wherever the panel currently is

function applyContent(faceIdx, reveal) {
  if (faceIdx !== lastRenderedFace) {
    setActivePanel(faceIdx);
    lastRenderedFace = faceIdx;
    updateChrome(faceIdx);
  }
  currentReveal = reveal;

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
   NAV-CLICK JUMPS
   Wheel/touch/keyboard scroll is native and always scrubs through the full
   per-face SEGMENTS timeline — that's the "flip past every side" experience
   TIMELINE above describes. A nav-label click asks for something different:
   go straight to one face. Scrubbing scroll-position through the normal
   timeline can't do that without visiting every face in between, so this
   drives its own short time-based tween directly from the cube's current
   live pose to the target face's resting pose — one continuous turn that
   never stops at, or even visits, any face but the start and the end.
   Duration scales with how far the cube actually has to rotate
   (NAV_RAD_PER_MS), so a one-face hop and a five-face hop turn at the same
   angular speed instead of the same wall-clock time.
   ══════════════════════════════════════════════════════════════ */
let navAnimating = false;
let navToken     = 0;

function livePose() {
  return {
    euler: [cubeGroup.rotation.x, cubeGroup.rotation.y, 0],
    x: cubeGroup.position.x,
    y: cubeGroup.position.y,
    scale: cubeGroup.scale.x,
  };
}

function runNavJump(toIdx) {
  const fromIdx = lastRenderedFace;
  if (!cubeGroup || fromIdx === null || fromIdx === toIdx) return;

  const token = ++navToken;
  navAnimating = true;

  const fromPose     = livePose();
  const toPose       = facePose(toIdx);
  const startReveal  = currentReveal;
  const e0 = nearAngle(fromPose.euler[0], toPose.euler[0]);
  const e1 = nearAngle(fromPose.euler[1], toPose.euler[1]);
  const angularDist  = Math.hypot(e0 - fromPose.euler[0], e1 - fromPose.euler[1]);

  const outMs    = NAV_PANEL_MS * startReveal; // nothing to fade out if it isn't showing
  const rotateMs = Math.max(angularDist / NAV_RAD_PER_MS, 1);
  const inMs     = NAV_PANEL_MS;
  const totalMs  = outMs + rotateMs + inMs;
  const startAt  = performance.now();

  function step(now) {
    if (token !== navToken) return; // superseded by a newer click or a manual scroll
    const elapsed = now - startAt;

    if (elapsed < outMs) {
      applyCubePose(fromPose);
      applyContent(fromIdx, startReveal * (1 - smoothstep(elapsed / outMs)));
    } else if (elapsed < outMs + rotateMs) {
      const e = smoothstep((elapsed - outMs) / rotateMs);
      applyCubePose({
        euler: [
          fromPose.euler[0] + (e0 - fromPose.euler[0]) * e,
          fromPose.euler[1] + (e1 - fromPose.euler[1]) * e,
          0,
        ],
        x: fromPose.x + (toPose.x - fromPose.x) * e,
        y: fromPose.y + (toPose.y - fromPose.y) * e,
        scale: fromPose.scale + (toPose.scale - fromPose.scale) * e,
      });
      applyContent(toIdx, 0);
    } else if (elapsed < totalMs) {
      applyCubePose(toPose);
      applyContent(toIdx, smoothstep((elapsed - outMs - rotateMs) / inMs));
    } else {
      applyCubePose(toPose);
      applyContent(toIdx, 1);
      finishNavJump(toIdx);
      return;
    }

    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// Once the direct turn finishes, park the real scroll position at this
// face's hold segment so the very next wheel/touch/key scroll picks up
// smoothly from here instead of replaying the faces skipped over.
function finishNavJump(toIdx) {
  navAnimating = false;
  const holdSeg = SEGMENTS.find(s => s.faceIdx === toIdx && s.type === 'hold');
  if (holdSeg) {
    const midProgress = (holdSeg.start + holdSeg.end) / 2;
    window.scrollTo(0, scrollSpacerTop + midProgress * scrollRange);
  }
  refreshTargetProgress();
  renderedProgress = targetProgress;
}

function cancelNavJump() {
  navToken++;
  navAnimating = false;
}

/* ══════════════════════════════════════════════════════════════
   INPUT
   Nav-label clicks are the only custom input: they drive a direct nav-jump
   tween (see runNavJump above). That's not scroll hijacking — it never
   touches wheel/touch handling, and a real wheel/touch/keyboard scroll
   cancels it immediately (below), same as native smooth-scroll would.
   Everything else (wheel, trackpad, touch, scrollbar drag, Space/PageDown/
   arrow keys) is untouched, native browser scrolling.
   ══════════════════════════════════════════════════════════════ */
function initInput() {
  window.addEventListener('scroll', refreshTargetProgress, { passive: true });

  // Let the user reclaim scroll from an in-flight nav-click jump the
  // instant they scroll themselves.
  window.addEventListener('wheel', cancelNavJump, { passive: true });
  window.addEventListener('touchstart', cancelNavJump, { passive: true });
  window.addEventListener('keydown', e => {
    if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(e.key)) cancelNavJump();
  });

  document.querySelectorAll('.nav-label').forEach(dot => {
    dot.addEventListener('click', () => runNavJump(parseInt(dot.dataset.idx, 10)));
  });
}

/* ══════════════════════════════════════════════════════════════
   MOBILE CONTROLLER
   Cube pinned in the top half; the user drags it freely and on
   release it eases to the nearest of the 6 canonical FACE_ROTATIONS
   poses (the same upright resting poses desktop uses), landing on
   the matching content panel in the bottom half. This owns
   cubeGroup's rotation entirely on mobile — renderLoop() skips
   render(progress) via the IS_MOBILE guard above, so this never
   fights the scroll-driven path. Never touches targetProgress /
   renderedProgress / SEGMENTS.
   ══════════════════════════════════════════════════════════════ */
const FACE_QUATS = FACE_ROTATIONS.map(f => {
  const e = new THREE.Euler(f.euler[0], f.euler[1], f.euler[2] ?? 0, 'XYZ');
  return new THREE.Quaternion().setFromEuler(e);
});

// Local-frame outward normal of each face, at rest. Used at snap time to
// pick the face pointing most toward the camera regardless of roll about
// the view axis (see mobileSnap).
const CAMERA_DIR = new THREE.Vector3(0, 0, 1);
const FACE_NORMALS = FACE_QUATS.map(q =>
  CAMERA_DIR.clone().applyQuaternion(q.clone().invert())
);

// Each face has 4 valid "level" resting rolls (0/90/180/270 about the view
// axis) — a real cube face can come to rest with any of its four edges
// "up". FACE_QUATS only encodes one fixed roll per face, so snapping straight
// to FACE_QUATS[best] always forced the same edge up no matter how the user
// had rolled the cube (e.g. white always landing with green on the bottom).
// Rotating about CAMERA_DIR after FACE_QUATS[i] keeps the face's normal
// pointed exactly at the camera (still level) while sweeping through all 4.
const FACE_ROLL_QUATS = FACE_QUATS.map(q => [0, 1, 2, 3].map(k => {
  const roll = new THREE.Quaternion().setFromAxisAngle(CAMERA_DIR, k * Math.PI / 2);
  return new THREE.Quaternion().multiplyQuaternions(roll, q);
}));

let mobileFace       = 0;
let mobileDragging   = false;
let mobileDragMoved  = false;
let mobileLastX = 0, mobileLastY = 0;
let mobileSnapToken  = 0;
let mobileYaw = 0, mobilePitch = 0;   // net drag displacement for the current gesture
let mobileDragBaseQuat = null;        // cube's orientation when this gesture started

function initMobile() {
  cubeGroup.position.set(0, MOBILE_CUBE_Y, 0);
  cubeGroup.scale.setScalar(MOBILE_CUBE_SCALE);
  cubeGroup.quaternion.copy(FACE_QUATS[0]);

  mobileFace = 0;
  setActivePanel(0);
  updateChrome(0);
  showMobilePanelContent(0);
  gsap.set('#side-panel', { opacity: 1 });

  const canvas = document.getElementById('main-canvas');
  canvas.addEventListener('touchstart', onMobileTouchStart, { passive: false });
  canvas.addEventListener('touchmove',  onMobileTouchMove,  { passive: false });
  canvas.addEventListener('touchend',   onMobileTouchEnd,   { passive: false });
  canvas.addEventListener('touchcancel', onMobileTouchEnd,  { passive: false });
}

function onMobileTouchStart(e) {
  if (e.touches.length !== 1) return;
  mobileSnapToken++; // a new drag cancels any in-flight snap
  mobileDragging  = true;
  mobileDragMoved = false;
  mobileYaw = 0;
  mobilePitch = 0;
  mobileDragBaseQuat = cubeGroup.quaternion.clone();
  mobileLastX = e.touches[0].clientX;
  mobileLastY = e.touches[0].clientY;
}

function onMobileTouchMove(e) {
  if (!mobileDragging || e.touches.length !== 1) return;
  e.preventDefault();

  const x = e.touches[0].clientX;
  const y = e.touches[0].clientY;
  const dx = x - mobileLastX;
  const dy = y - mobileLastY;
  mobileLastX = x;
  mobileLastY = y;

  if (!mobileDragMoved && Math.hypot(dx, dy) >= MOBILE_DRAG_THRESH) {
    mobileDragMoved = true;
    gsap.to('#side-panel', { opacity: 0, duration: 0.15, ease: 'power1.out' });
  }
  if (!mobileDragMoved) return;

  // Accumulate NET yaw/pitch for this gesture and rebuild the orientation
  // fresh from the pre-drag pose every step, instead of composing many
  // small per-step rotations onto the live quaternion. Composing
  // incrementally is path-dependent — a curved finger drag (which real
  // drags always are) racks up roll around the view axis step by step,
  // which is what was showing up as an unwanted twist at rest and a big
  // "unnecessary" turn on snap. Rebuilding from the total displacement
  // makes the result depend only on where the drag ends up, not the
  // shape of the path it took to get there.
  mobileYaw   += dx * MOBILE_ROT_SPEED;
  mobilePitch += dy * MOBILE_ROT_SPEED;
  const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), mobilePitch);
  const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), mobileYaw);
  cubeGroup.quaternion.copy(mobileDragBaseQuat).premultiply(qy).premultiply(qx);
}

function onMobileTouchEnd() {
  if (!mobileDragging) return;
  mobileDragging = false;
  if (mobileDragMoved) mobileSnap(); // a tap (no real movement) does nothing
}

function mobileSnap() {
  const token = ++mobileSnapToken;
  const cur = cubeGroup.quaternion.clone();
  // Roll-invariant: pick whichever face's outward normal currently points
  // most toward the camera (+Z), not whichever upright pose is nearest in
  // full orientation — a face can be dead-on to the camera but spun about
  // the view axis, and angleTo() would wrongly favor a neighboring face.
  let best = 0, bestZ = -Infinity;
  for (let i = 0; i < FACE_NORMALS.length; i++) {
    const z = FACE_NORMALS[i].clone().applyQuaternion(cur).z;
    if (z > bestZ) { bestZ = z; best = i; }
  }
  // Among that face's 4 valid level rolls, snap to whichever is nearest to
  // the cube's current orientation — this is what lets the user's own roll
  // decide which edge ends up "up" instead of always forcing the same one.
  let to = FACE_ROLL_QUATS[best][0], bestAngle = Infinity;
  for (const cand of FACE_ROLL_QUATS[best]) {
    const a = cur.angleTo(cand);
    if (a < bestAngle) { bestAngle = a; to = cand; }
  }
  const from = cur;
  const start = performance.now();
  function step(now) {
    if (token !== mobileSnapToken) return; // superseded by a new drag
    const t = Math.min((now - start) / MOBILE_SNAP_MS, 1);
    const e = smoothstep(t);
    cubeGroup.quaternion.copy(from).slerp(to, e);
    if (t < 1) { requestAnimationFrame(step); return; }
    mobileFace = best;
    setActivePanel(best);
    updateChrome(best);
    showMobilePanelContent(best);
    gsap.to('#side-panel', { opacity: 1, duration: 0.25, ease: 'power2.out' });
  }
  requestAnimationFrame(step);
}

// setActivePanel() (reused from desktop) already resets every .panel-face —
// including #panel-0 — to opacity:0/pointer-events:none, then for faceIdx!==0
// reveals #panel-{idx} and records it as activeFaceEl. Desktop never activates
// faceIdx 0 (it shows #Home-overlay instead), so #panel-0 is what mobile uses
// for the Home face; this just layers that on top and, since applyContent()
// (the desktop reveal/pointer-events driver) never runs on mobile, makes the
// landed panel actually interactive (links, resume download, etc).
function showMobilePanelContent(idx) {
  const home = document.getElementById('panel-0');
  if (idx === 0) {
    if (home) { home.style.opacity = '1'; home.style.pointerEvents = 'auto'; }
  } else {
    if (home) { home.style.opacity = '0'; home.style.pointerEvents = 'none'; }
    if (activeFaceEl) activeFaceEl.style.pointerEvents = 'auto';
  }
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
  // Always start on Home, every load/refresh — never inherit a restored
  // or anchored scroll position (history.scrollRestoration='manual' above
  // handles the common case; this is the guaranteed fallback).
  window.scrollTo(0, 0);

  // Start loading Three.js + GLB immediately, in parallel with the preloader
  initThree();
  layoutScrollSpacer();

  runPreloader(() => {
    gsap.to('#scene', { opacity: 1, duration: 0.7, ease: 'power2.out' });

    if (IS_MOBILE) {
      initMobile();
    } else {
      window.scrollTo(0, 0);
      initInput();
      refreshTargetProgress();
      renderedProgress = targetProgress;
    }
  });
}

// Rotating the device or resizing across the 768px boundary re-picks the
// mode cleanly via a reload. Keyed on width only — mobile URL bars
// constantly change viewport height, and that alone must not reload.
window.addEventListener('resize', () => {
  const nowMobile = window.matchMedia('(max-width: 768px)').matches;
  if (nowMobile !== IS_MOBILE) location.reload();
});

boot();
