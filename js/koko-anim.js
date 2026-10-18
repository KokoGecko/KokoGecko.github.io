// koko-anim.js — brings the voxel Koko to life.
//
// How it works, in one breath:
//   * buildKoko() (koko-model.js) gives us a "rig": Groups for the body, head, eyes, lids, tongue, tail, legs and
//     bow. A Group's position is its PIVOT, the hinge it turns around. We only ever change position, rotation and
//     scale of those Groups (never colours or materials), so the animation is cheap for the GPU.
//   * Every frame we fill in one "pose sheet": an object of plain numbers such as headPitch or tongue. Layers add
//     their small offsets to it, in order: current action -> idle loop -> walk -> sleep -> look-follow springs.
//     Then we write the sheet onto the rig, relative to the rest pose the model was built in.
//   * Nothing is created inside update() (no `new`, no arrays), so the garbage collector never makes Koko stutter.
//
// Motion rules: every movement is a reaction (hop, look, flinch) or a sign of life (breathing, blinking).
// Big moves get anticipation (a squash before the jump), squash and stretch on landing, and a little overshoot on
// the bow. Idle stays small and calm so the page is not busy.
//
// ---------- 0. Timing table (seconds; the lead quotes this) ----------
// | Motion            | Length         | Easing / spring                                            | Beats / events                              |
// |-------------------|----------------|------------------------------------------------------------|---------------------------------------------|
// | Idle loop         | 4.0 (loops)    | sine waves; every period divides 4.0, so it loops seamlessly| breath 2.0 (body ±2.5 %), blink @2.60 (0.15),|
// |                   |                |                                                            | tail sway 4.0, bow wobble 2.0, loop flutter  |
// |                   |                |                                                            | 1.0, cloud bob 4.0 (±0.3), drip cycle 2.0    |
// | Look-follow       | ~0.3 / ~0.5    | critically damped springs: pupils k 320, head k 70,        | pupils lead, head follows, body turns last  |
// |                   |                | body k 24 (c = 2*sqrt(k))                                  | (head ±0.8/0.45 yaw, -0.35..0.5 pitch)       |
// | Tongue flick      | 0.35           | out 0.12 easeOutCubic, hold 0.05, back 0.18 easeInOutSine  | "tongue-hit" @0.12                          |
// | Walk cycle        | 3.5 vox/cycle  | sine; cycles/s = speed / 3.5, clamped 0.4..2.5             | fl+br vs fr+bl, body bob 2x/cycle, tail      |
// |                   |                |                                                            | counter-sway, spine S-curve                  |
// | Hop               | 0.70           | squash 0-0.12 easeOutCubic; air 0.12-0.46 parabola (4 vox);| "landed" @0.46                              |
// |                   |                | land squash 0.46-0.50; recover 0.50-0.70 easeOutBack       |                                             |
// | Bow bounce        | ~1.2 to settle | underdamped spring k 170, c 5 (damping ratio ≈ 0.19)       | kicked by take-off and landing              |
// | Rain reaction     | 1.6            | look up 0-0.25 easeInOutSine; cloud puff x1.28 easeOutBack | shiver (shake-off) 1.0-1.6                  |
// |                   |                | 0-0.35; drips x5 0.05-1.3                                  |                                             |
// | Collect           | 1.0            | look at target 0-0.08; mini hop 0.16-0.46 (1.6 vox);       | "landed" @0.46                              |
// |                   |                | recover easeOutBack 0.50-0.68; happy wiggle 0.46-1.0        |                                             |
// | Shake-off         | 0.6            | 7 Hz wave, eased in 0.07, dies out (1-u)^2                 | "shake" @0                                  |
// | Sleep             | after 20 s     | eyes close 0.8 easeInOutSine; breath slows to 4.0 (±3.5 %) | "sleep"; z's: 3 voxel z's, 3.0 rise, 1.0 apart|
// | Wake              | 0.7            | eyes open 0.25; head shake 5 Hz 0.2-0.65; blink @0.45      | "wake"                                      |
// | Intro "wake" (A)  | 6.0            | drop 0-0.50 easeInQuad (gravity, 18 vox); land squash 0.72;| "landed" @0.50, "tongue-hit" @4.19,          |
// |                   |                | stretch 1.15-2.30; blinks @2.40 @2.70; petal 2.90; flick   | "intro-done" @6.0                           |
// |                   |                | 4.07; turn to visitor 4.85-5.45; hand over to look 5.45-6.0 |                                             |
// | Intro "monsoon"(B)| 6.5            | look up + cloud swells 0-0.6 easeOutBack; drips x6;        | "rain-start" @0.30, onShelter() @0.85,       |
// |  (THE intro)      |                | turn 0.85-1.10, scurry 1.10-2.10 (up to 14 vox), face the  | "shelter" @2.10, "rain-stop" @3.60,          |
// |                   |                | visitor's side 2.05-2.30, crouch 2.1-4.2, shake-off        | "shake" @4.25, "intro-done" @6.5             |
// |                   |                | 4.25-4.85, turn 4.85-5.10, trot home 5.10-6.00, turn back  |                                             |
// |                   |                | 5.95-6.20, settle 6.15-6.5 (travel/turns: easeInOutSine)   |                                             |
// | Cloud follow      | ~0.8 lag       | critically damped spring k 14                              | the cloud trails Koko's hops and walks      |
//
// Why these easings (for a learner): easeOut* starts fast and lands softly — good for reactions, because the
// response is instant. easeInOutSine starts and stops gently — good for things already on screen that move or
// turn. easeOutBack overshoots a little and settles — the "snap" of a game character landing. easeInQuad speeds
// up like gravity — used only for falling.

import * as THREE from "three";

// ---------- 1. Timing you can sync with (scenes listen for events, or read these numbers) ----------
export const KOKO_TIMING = {
    idleLoop: 4.0,
    sleepAfter: 20,
    hop: { duration: 0.7, takeoffAt: 0.12, landAt: 0.46, height: 4 },
    tongue: { duration: 0.35, hitAt: 0.12 },
    rain: { duration: 1.6 },
    collect: { duration: 1.0, landAt: 0.46, height: 1.6 },
    shake: { duration: 0.6 },
    wake: { duration: 0.7 },
    introWake: { duration: 6.0, dropHeight: 18, landAt: 0.5, petalAt: 2.9, flickAt: 4.07, hitAt: 4.19, handover: 5.45 },
    introMonsoon: {
        duration: 6.5, rainStart: 0.3, rainFull: 0.6, shelterAt: 0.85, goAt: 1.1, arriveAt: 2.1,
        rainStop: 3.6, rainGone: 4.1, shakeAt: 4.25, homeAt: 5.1, backAt: 6.0, maxTravel: 14
    }
};

// ---------- 2. Small maths helpers ----------
const TAU = Math.PI * 2;

function clamp(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x;
}

function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

// Fractional part, always 0..1 (also for negative numbers).
function frac(x) {
    return x - Math.floor(x);
}

// Progress (0..1) of time t through the segment [a, b].
function seg(t, a, b) {
    return clamp01((t - a) / (b - a));
}

function easeOutCubic(x) {
    const u = 1 - x;
    return 1 - u * u * u;
}

function easeInOutSine(x) {
    return 0.5 - 0.5 * Math.cos(Math.PI * x);
}

function easeOutBack(x) {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    const u = x - 1;
    return 1 + c3 * u * u * u + c1 * u * u;
}

// A bump: rises 0 -> 1 over [a, b], holds, falls 1 -> 0 over [c, d]. Sine-eased both ways.
function bump(t, a, b, c, d) {
    if (t <= a || t >= d) return 0;
    if (t < b) return easeInOutSine((t - a) / (b - a));
    if (t <= c) return 1;
    return 1 - easeInOutSine((t - c) / (d - c));
}

// A quick blink starting at `start`: lids shut in 60 ms, stay 20 ms, open in 70 ms (150 ms in total).
function blink(t, start) {
    return bump(t, start, start + 0.06, start + 0.08, start + 0.15);
}

// The tongue's shape over time (0 hidden .. 1 fully out). Shot out fast, held a beat, pulled back.
function tongueShape(t) {
    if (t <= 0 || t >= 0.35) return 0;
    if (t < 0.12) return easeOutCubic(t / 0.12);
    if (t < 0.17) return 1;
    return 1 - easeInOutSine((t - 0.17) / 0.18);
}

// ---------- 3. Springs ----------
// A spring pulls a value x toward a target, like a ball on a rubber band.
//   stiffness k: how hard the band pulls. Bigger k = faster.
//   damping c:   friction that eats the speed v. Without it the ball would wobble forever.
// The special value c = 2 * sqrt(k) is called "critically damped": the fastest way to arrive with NO overshoot.
// We use it for the head and eyes, so a look never wobbles. A smaller c is "underdamped": it overshoots and
// bounces a few times before settling. We use that for the bow, so it boings after a landing.
// (Damping ratio = c / (2 * sqrt(k)): 1 = critical, below 1 = bouncy, above 1 = sluggish.)
// Each step: acceleration = -k * (x - target) - c * v;  v += acceleration * dt;  x += v * dt.
// A long frame is cut into small steps (at most 1/120 s) so the maths stays stable.
const SPRING_STEP = 1 / 120;

function makeSpring(x = 0) {
    return { x, v: 0 };
}

function stepSpring(s, target, k, c, dt) {
    let left = dt;
    while (left > 1e-6) {
        const h = left < SPRING_STEP ? left : SPRING_STEP;
        const accel = -k * (s.x - target) - c * s.v;
        s.v += accel * h;
        s.x += s.v * h;
        left -= h;
    }
}

function critical(k) {
    return 2 * Math.sqrt(k);
}

// Pick the version of angle `to` (plus or minus whole turns) that Koko turns to from `from`. Small turns take the
// short way; big turns go round via the visitor's side (yaw -PI/2 = nose toward +Z), so we see his face, never
// just his back.
function turnVia(from, to) {
    let best = to;
    let bestLen = Infinity;
    for (let k = -2; k <= 2; k++) {
        const cand = to + k * TAU;
        const len = Math.abs(cand - from);
        if (len < 1e-6) return cand;
        const lo = Math.min(from, cand);
        const hi = Math.max(from, cand);
        const visitor = -Math.PI / 2 + Math.ceil((lo + Math.PI / 2) / TAU) * TAU;   // first "face the visitor" yaw >= lo
        if ((len <= Math.PI / 2 || visitor <= hi) && len < bestLen) {
            best = cand;
            bestLen = len;
        }
    }
    return best;
}

function resetSpring(s, x = 0) {
    s.x = x;
    s.v = 0;
}

// ---------- 4. The pose sheet ----------
// One flat object of numbers. Layers ADD to most entries; a few MULTIPLY (scales, weights); lids take the MAX
// (if anything wants the eyes shut, they are shut). It is cleared at the start of every frame.
const ADD_KEYS = [
    "rootX", "rootY", "rootZ", "rootYaw",
    "bodyY", "bodyPitch", "bodyRoll", "bodyYaw", "breath",
    "headPitch", "headYaw", "headRoll", "pupilX", "pupilY", "tongue",
    "tailSway0", "tailSway1", "tailSway2", "tailCurl0", "tailCurl1", "tailCurl2",
    "legFL", "legFR", "legBL", "legBR", "splay",
    "bowPitch", "bowRoll", "loopFlap",
    "cloudBobX", "cloudBobY", "cloudRoll", "zzz"
];
const MUL_KEYS = ["squash", "cloudPuff", "dripRate", "lookW", "plant", "idleBlink"];

function makePoseSheet() {
    const sheet = { lid: 0, focusW: 0, focus: new THREE.Vector3() };
    clearPoseSheet(sheet);
    return sheet;
}

function clearPoseSheet(sheet) {
    for (let i = 0; i < ADD_KEYS.length; i++) sheet[ADD_KEYS[i]] = 0;
    for (let i = 0; i < MUL_KEYS.length; i++) sheet[MUL_KEYS[i]] = 1;
    sheet.lid = 0;
    sheet.focusW = 0;
}

// Blend sheet `from` into sheet `into` with weight w (0..1).
function mergePoseSheet(into, from, w) {
    for (let i = 0; i < ADD_KEYS.length; i++) into[ADD_KEYS[i]] += from[ADD_KEYS[i]] * w;
    for (let i = 0; i < MUL_KEYS.length; i++) into[MUL_KEYS[i]] *= 1 + (from[MUL_KEYS[i]] - 1) * w;
    into.lid = Math.max(into.lid, from.lid * w);
    if (from.focusW * w > into.focusW) {
        into.focusW = from.focusW * w;
        into.focus.copy(from.focus);
    }
}

// ---------- 5. Little voxel props the animator owns (sleepy z's, the intro petal) ----------
// Several boxes merged into ONE geometry, so each prop is a single draw call.
function mergeBoxes(list) {
    const positions = [];
    const normals = [];
    const indices = [];
    let offset = 0;
    for (const [w, h, d, x, y, z] of list) {
        const g = new THREE.BoxGeometry(w, h, d);
        g.translate(x, y, z);
        positions.push(...g.attributes.position.array);
        normals.push(...g.attributes.normal.array);
        for (const i of g.index.array) indices.push(i + offset);
        offset += g.attributes.position.count;
        g.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geo.setIndex(indices);
    return geo;
}

// A "Z" drawn on a 4x4 voxel grid:  ####  /  ..#.  /  .#..  /  ####   (v = voxel size, centred on 0,0)
function buildZGeometry(v) {
    return mergeBoxes([
        [4 * v, v, v, 0, 1.5 * v, 0],
        [v, v, v, 0.5 * v, 0.5 * v, 0],
        [v, v, v, -0.5 * v, -0.5 * v, 0],
        [4 * v, v, v, 0, -1.5 * v, 0]
    ]);
}

// A cherry petal: a thin voxel slab with a narrower tip.
function buildPetalGeometry() {
    return mergeBoxes([
        [0.9, 0.16, 0.7, 0, 0, 0],
        [0.45, 0.16, 0.45, 0.6, 0, 0]
    ]);
}

const Z_COLOUR = "#5aa9ff";        // the rain-drop blue: sleepy z's belong to the cloud family
const PETAL_COLOUR = "#f6a3bf";    // concept A blossom

// ---------- 6. Tunables ----------
const WALK_SWING = 0.45;           // radians each leg swings forward/back while walking
const STRIDE = 3.5;                // voxels travelled per full walk cycle (4 * legLength * sin(swing) ≈ 3.5)
const LOOK = {
    yawMin: -0.8, yawMax: 0.45,    // negative yaw turns the face toward the visitor (+Z); asymmetric on purpose
    pitchMin: -0.35, pitchMax: 0.5,
    bodyShare: 0.3,                // the body turns this share of a look (not while walking)
    kHead: 70, kBody: 24, kPupil: 320
};
const BOW_K = 170;                 // bow spring stiffness
const BOW_C = 5;                   // bow spring damping (underdamped on purpose: it bounces)
const CLOUD_K = 14;                // cloud follow spring (critically damped, so it trails without wobbling)
const DRIP_PERIOD = 2.0;           // seconds per drop cycle at rest (2 per idle loop)
const DROP_FALL = 3.5;             // voxels a drop falls before it fades
const Z_PERIOD = 3.0;              // seconds one z takes to float up
const FADE_TIME = 0.15;            // cross-fade when one action interrupts another

// ---------- 7. The animator ----------
export function createKokoAnimator(koko, { reducedMotion = false } = {}) {
    const rig = koko.rig;
    const root = koko.root;
    const cloud = koko.cloud || null;
    const anchors = koko.anchors;

    // ---------- 7.1 Remember the rest pose of every part ----------
    // Everything we animate is written as "rest + offset", so the modeler can place pivots freely.
    function remember(obj) {
        return { obj, p: obj.position.clone(), r: obj.rotation.clone(), s: obj.scale.clone() };
    }

    function setPos(rec, x, y, z) {
        rec.obj.position.set(rec.p.x + x, rec.p.y + y, rec.p.z + z);
    }

    function setRot(rec, x, y, z) {
        rec.obj.rotation.set(rec.r.x + x, rec.r.y + y, rec.r.z + z);
    }

    function setScale(rec, x, y, z) {
        rec.obj.scale.set(rec.s.x * x, rec.s.y * y, rec.s.z * z);
    }

    const restRoot = remember(root);
    const restBody = remember(rig.body);
    const restHead = remember(rig.head);
    const restTongue = remember(rig.tongue);
    const restTail = rig.tail.slice(0, 3).map(remember);
    const restLegs = {
        fl: remember(rig.legs.fl), fr: remember(rig.legs.fr),
        bl: remember(rig.legs.bl), br: remember(rig.legs.br)
    };
    const restBow = rig.bow ? remember(rig.bow) : null;
    const restLoops = rig.bowLoops ? [remember(rig.bowLoops.l), remember(rig.bowLoops.r)] : [];
    const lids = [rig.lids.l, rig.lids.r];
    const restPupils = [rig.eyes.l, rig.eyes.r]
        .map((eye) => (eye && eye.userData.pupil ? remember(eye.userData.pupil) : null))
        .filter(Boolean);

    // ---------- 7.2 Measure the model once (construction time only) ----------
    // Root-rest space = Koko's own space in the rest pose. 1 unit = 1 voxel, ground at y = 0, nose toward +X.
    const restRootQuat = new THREE.Quaternion().setFromEuler(restRoot.r);
    const rootRestInv = new THREE.Matrix4().compose(restRoot.p, restRootQuat, restRoot.s).invert();

    root.updateMatrixWorld(true);
    const rootWorldInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const toRootSpace = (obj) => obj.getWorldPosition(new THREE.Vector3()).applyMatrix4(rootWorldInv);

    const neck = toRootSpace(rig.head);
    // Leg length = hip height (the feet touch y = 0). Used to keep the feet planted when legs swing or splay.
    const hipHeights = Object.values(rig.legs).map((leg) => toRootSpace(leg).y);
    let legLen = hipHeights.reduce((a, b) => a + b, 0) / hipHeights.length;
    if (!(legLen > 0.5)) legLen = 2;
    const bodyPivotY = Math.max(0, toRootSpace(rig.body).y);

    // Tongue tip, in head space, when the tongue is fully out (scale.x = 1).
    const tipInHead = (() => {
        const t = rig.tongue;
        const oldScale = t.scale.x;
        t.scale.x = 1;
        t.updateMatrixWorld(true);
        const inv = new THREE.Matrix4().copy(t.matrixWorld).invert();
        const box = new THREE.Box3();
        const part = new THREE.Box3();
        t.traverse((o) => {
            if (o.isMesh && o.geometry) {
                if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
                part.copy(o.geometry.boundingBox).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
                box.union(part);
            }
        });
        const len = box.isEmpty() ? 3 : Math.max(0.5, box.max.x);
        t.updateMatrix();
        const tip = new THREE.Vector3(len, 0, 0).applyMatrix4(t.matrix);
        t.scale.x = oldScale;
        t.updateMatrix();
        return tip;
    })();

    // Which way does each bow loop stick out from the knot? That decides which axis "flaps" it upward.
    const loopFlapAxis = restLoops.map((rec) => {
        const box = new THREE.Box3().setFromObject(rec.obj);
        const centre = box.getCenter(new THREE.Vector3());
        rig.bow.worldToLocal(centre);
        const along = centre.clone().sub(rec.p);
        // Sticking out along X: rotation.z lifts it (sign of x). Along Z: rotation.x lifts it (minus sign of z).
        if (Math.abs(along.x) >= Math.abs(along.z)) return { axis: "z", sign: along.x >= 0 ? 1 : -1 };
        return { axis: "x", sign: along.z >= 0 ? -1 : 1 };
    });

    // ---------- 7.3 Props we add: three sleepy z's and the intro petal ----------
    const zGeo = buildZGeometry(0.3);
    const zMat = new THREE.MeshStandardMaterial({ color: Z_COLOUR, roughness: 0.6 });
    const zs = [0, 1, 2].map((i) => {
        const g = new THREE.Group();
        g.name = "koko-z" + i;
        g.add(new THREE.Mesh(zGeo, zMat));
        g.visible = false;
        root.add(g);
        return g;
    });
    const zStart = new THREE.Vector3().copy(anchors.headTop).add(new THREE.Vector3(0.8, 1.0, 0.6));

    const petalGeo = buildPetalGeometry();
    const petalMat = new THREE.MeshStandardMaterial({ color: PETAL_COLOUR, roughness: 0.6 });
    const petal = new THREE.Group();
    petal.name = "koko-intro-petal";
    petal.add(new THREE.Mesh(petalGeo, petalMat));
    petal.visible = false;
    root.add(petal);
    const tipRest = tipInHead.clone().applyMatrix4(rig.head.matrixWorld).applyMatrix4(rootWorldInv);
    const petalStart = tipRest.clone().add(new THREE.Vector3(3, 9, 1));

    // ---------- 7.4 Cloud parts ----------
    const restCloud = cloud ? remember(cloud.root) : null;
    const restCloudQuat = cloud ? new THREE.Quaternion().setFromEuler(restCloud.r) : null;
    const restPuff = cloud && cloud.puff ? remember(cloud.puff) : null;
    const restDrops = cloud ? cloud.drops.map(remember) : [];
    const dropTopY = restDrops.reduce((top, rec) => Math.max(top, rec.p.y), -Infinity);

    // ---------- 7.5 State ----------
    const P = makePoseSheet();     // the final pose for this frame
    const S = makePoseSheet();     // scratch sheet each action writes into before it is blended in
    const clock = { idle: 0, drops: 0, quiet: 0, z: 0 };
    const walk = { speed: 0, w: 0, phase: 0, freq: 1 };
    const sleep = { k: 0, target: 0 };
    const look = {
        active: false,
        world: new THREE.Vector3(),
        yaw: makeSpring(), pitch: makeSpring(), body: makeSpring(),
        px: makeSpring(), py: makeSpring()
    };
    const bowSpring = makeSpring();
    const cloudSpring = { x: makeSpring(), y: makeSpring(), z: makeSpring(), snapped: false };
    let reduced = !!reducedMotion;
    let still = null;               // a named still pose from pose(): "hero"
    const rm = { name: null, t: 0, dur: 0, yaw: 0, pitch: 0 };   // reduced-motion held pose
    const queued = { name: null, opts: null };
    let lastState = "idle";
    let walkE = 0;
    let voxelWorld = 1;             // how big one voxel is in world units (from the parent's scale)

    // scratch objects (reused every frame)
    const tmpA = new THREE.Vector3();
    const tmpB = new THREE.Vector3();
    const parentInv = new THREE.Matrix4();
    const cloudInv = new THREE.Matrix4();
    const posK = new THREE.Vector3();
    const posC = new THREE.Vector3();
    const quatK = new THREE.Quaternion();
    const quatC = new THREE.Quaternion();
    const scaleK = new THREE.Vector3(1, 1, 1);
    const scaleC = new THREE.Vector3(1, 1, 1);
    const tmpQ = new THREE.Quaternion();
    const Z_AXIS = new THREE.Vector3(0, 0, 1);
    const aimLook = { yaw: 0, pitch: 0, rawYaw: 0, rawPitch: 0 };
    const aimFocus = { yaw: 0, pitch: 0, rawYaw: 0, rawPitch: 0 };
    const pupilAimOut = { x: 0, y: 0 };
    const petalPos = new THREE.Vector3().copy(petalStart);

    // ---------- 7.6 Events ----------
    const listeners = {};

    function on(name, cb) {
        (listeners[name] || (listeners[name] = [])).push(cb);
        return () => {
            const list = listeners[name];
            const i = list.indexOf(cb);
            if (i >= 0) list.splice(i, 1);
        };
    }

    function emit(name) {
        const list = listeners[name];
        if (!list) return;
        for (let i = 0; i < list.length; i++) {
            try {
                list[i](name);
            } catch (err) {
                console.error("koko-anim listener failed:", err);
            }
        }
    }

    // ---------- 7.7 Space helpers ----------
    // Called once per frame: inverse of Koko's parent, so a world point can be turned into root-rest space.
    function refreshParentInverse() {
        const parent = root.parent;
        if (parent) {
            parent.updateWorldMatrix(true, false);
            parentInv.copy(parent.matrixWorld).invert();
            voxelWorld = parent.matrixWorld.getMaxScaleOnAxis() * restRoot.s.x;
        } else {
            parentInv.identity();
            voxelWorld = restRoot.s.x;
        }
    }

    function worldToRest(world, out) {
        return out.copy(world).applyMatrix4(parentInv).applyMatrix4(rootRestInv);
    }

    // Angles from Koko's neck to point p (root-rest space). yaw: + turns the nose away from the visitor (-Z),
    // - toward the visitor (+Z). pitch: + nose up. raw* are honest angles (for the pupils), yaw/pitch are clamped
    // to what a gecko neck can do.
    function aimAt(p, out) {
        const dx = p.x - (neck.x + P.rootX);
        const dy = p.y - (neck.y + P.rootY);
        const dz = p.z - (neck.z + P.rootZ);
        out.rawYaw = Math.atan2(-dz, dx);
        out.rawPitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz) + 1e-6);
        // Behind Koko? Turn toward the visitor instead of whipping round (never looks broken).
        const yaw = Math.abs(out.rawYaw) > Math.PI / 2 ? LOOK.yawMin : out.rawYaw;
        out.yaw = clamp(yaw, LOOK.yawMin, LOOK.yawMax);
        out.pitch = clamp(out.rawPitch, LOOK.pitchMin, LOOK.pitchMax);
        return out;
    }

    // Where the pupils should sit (eye space, ±0.3) for a target, given where the head points right now.
    // x = toward the nose, y = up. A target straight at the visitor leaves them centred.
    function pupilAim(aim, headYaw, headPitch, out) {
        const r = aim.rawYaw - headYaw;
        const q = aim.rawPitch - headPitch;
        out.x = clamp(0.3 * Math.cos(q) * Math.cos(r), -0.3, 0.3);
        out.y = clamp(0.5 * Math.sin(q), -0.3, 0.3);
        return out;
    }

    // ---------- 7.8 Idle loop (exactly 4.0 s; every period divides 4.0) ----------
    function addIdle(t, sleepE) {
        // breathing: two calm breaths per loop awake, one slow deep breath asleep
        const awake = Math.sin(TAU * t / 2.0) * 0.025;
        const asleep = Math.sin(TAU * t / 4.0) * 0.035;
        P.breath += lerp(awake, asleep, sleepE);
        // the head floats with the breath, a quarter second later (follow-through)
        P.headPitch += Math.sin(TAU * (t - 0.25) / 2.0) * 0.012 * (1 - sleepE);
        // one blink per loop
        P.lid = Math.max(P.lid, blink(t, 2.6) * P.idleBlink * (1 - sleepE));
        // tail: one lazy sway per loop; each joint a bit later than the last, so a wave runs down the tail
        const tailW = (1 - 0.6 * sleepE) * (1 - walkE);
        P.tailSway0 += Math.sin(TAU * t / 4.0) * 0.07 * tailW;
        P.tailSway1 += Math.sin(TAU * t / 4.0 - 0.7) * 0.10 * tailW;
        P.tailSway2 += Math.sin(TAU * t / 4.0 - 1.4) * 0.14 * tailW;
        P.tailCurl2 += Math.sin(TAU * t / 2.0 - 1.0) * 0.04 * tailW;
        // bow: a tiny tilt riding the breath, and the loops flutter a hair
        P.bowRoll += Math.sin(TAU * (t - 0.35) / 2.0) * 0.035;
        P.loopFlap += Math.sin(TAU * t / 1.0) * 0.03 * (1 - sleepE);
        // cloud: one slow bob per loop, drifting in a small ellipse with a gentle roll
        P.cloudBobY += Math.sin(TAU * t / 4.0) * 0.3;
        P.cloudBobX += Math.cos(TAU * t / 4.0) * 0.15;
        P.cloudRoll += Math.sin(TAU * t / 4.0 + 0.8) * 0.025;
    }

    // ---------- 7.9 Walk cycle ----------
    // phase: 0..1 is one full cycle. Diagonal pairs move together (a trot): front-left + back-right, then
    // front-right + back-left. The body bob comes for free: when the legs are spread the body sits lower
    // (see "foot planting" in applyPose), which happens twice per cycle.
    function addWalk(sheet, phase, w) {
        if (w <= 0) return;
        const s = Math.sin(TAU * phase);
        const swing = WALK_SWING * s * w;
        sheet.legFL += swing;
        sheet.legBR += swing;
        sheet.legFR -= swing;
        sheet.legBL -= swing;
        sheet.rootY += 0.06 * Math.max(0, Math.cos(TAU * 2 * phase)) * w;     // a little spring in each step
        sheet.bodyYaw += 0.07 * s * w;                                        // spine S-curve, like a real gecko
        sheet.headYaw -= 0.045 * s * w;                                       // the head keeps itself steady
        sheet.bodyRoll += 0.025 * Math.sin(TAU * phase + 0.6) * w;
        sheet.tailSway0 -= 0.10 * Math.sin(TAU * phase - 0.4) * w;            // tail swings against the body
        sheet.tailSway1 -= 0.14 * Math.sin(TAU * phase - 0.9) * w;
        sheet.tailSway2 -= 0.18 * Math.sin(TAU * phase - 1.4) * w;
    }

    // ---------- 7.10 Shake-off (shared by the shake, rain and monsoon) ----------
    // Like a wet dog: the body rolls fast around its long axis, the head and tail follow a beat later in the
    // opposite direction (overlapping action), and the whole wobble dies out. Eyes squeeze shut while shaking.
    function addShake(sheet, t, dur, strength) {
        if (t < 0 || t > dur) return;
        const u = t / dur;
        const env = easeOutCubic(clamp01(u / 0.12)) * (1 - u) * (1 - u) * strength;
        const f = 7;
        sheet.bodyRoll += Math.sin(TAU * f * t) * 0.22 * env;
        sheet.headRoll -= Math.sin(TAU * f * t - 0.9) * 0.18 * env;
        sheet.headYaw += Math.sin(TAU * f * t - 0.5) * 0.08 * env;
        sheet.tailSway0 += Math.sin(TAU * f * t - 1.0) * 0.22 * env;
        sheet.tailSway1 += Math.sin(TAU * f * t - 1.6) * 0.28 * env;
        sheet.tailSway2 += Math.sin(TAU * f * t - 2.2) * 0.36 * env;
        sheet.loopFlap += Math.sin(TAU * f * t - 1.4) * 0.35 * env;
        sheet.bowRoll += Math.sin(TAU * f * t - 1.2) * 0.15 * env;
        sheet.squash *= 1 + 0.03 * Math.sin(TAU * 2 * f * t) * env;
        sheet.lid = Math.max(sheet.lid, 0.85 * clamp01(env * 3));
        sheet.splay += 0.1 * clamp01(env * 3);
    }

    // ---------- 7.11 Actions ----------
    // Each action writes into the scratch sheet S (unweighted) for its own time t. Every action starts and
    // ends in the neutral pose, so starting, ending or cross-fading never makes Koko pop.

    function runHop(sh, t) {
        const H = KOKO_TIMING.hop;
        const up = H.takeoffAt;
        const land = H.landAt;
        const apex = (up + land) / 2;
        if (t < up) {
            // 1. anticipation: crouch and squash, nose dips
            const k = easeOutCubic(t / up);
            sh.squash = 1 - 0.18 * k;
            sh.headPitch = -0.08 * k;
            sh.splay = 0.15 * k;
        } else if (t < land) {
            // 2. airborne: a parabola up 4 voxels; stretched on the way up, a bit again on the way down
            const u = (t - up) / (land - up);
            sh.rootY = H.height * 4 * u * (1 - u);
            const takeoff = easeOutCubic(seg(t, up, up + 0.06));
            if (t < up + 0.06) sh.squash = lerp(0.82, 1.14, takeoff);
            else if (t < apex) sh.squash = lerp(1.14, 1.0, easeInOutSine(seg(t, up + 0.06, apex)));
            else sh.squash = lerp(1.0, 1.06, seg(t, apex, land));
            sh.plant = 0;
            const tuck = bump(t, up, up + 0.08, land - 0.1, land);
            sh.legFL = sh.legFR = 0.35 * tuck;         // front legs reach forward
            sh.legBL = sh.legBR = -0.35 * tuck;        // back legs kick back
            sh.splay = 0.15 * (1 - takeoff);
            sh.headPitch = 0.12 * tuck - 0.08 * (1 - takeoff);
            sh.tailCurl0 = 0.12 * tuck;
            sh.tailCurl1 = 0.15 * tuck;
            sh.tailCurl2 = 0.2 * tuck;
        } else {
            // 3. landing: squash flat on impact, then spring back with a tiny overshoot
            const hit = easeOutCubic(seg(t, land, land + 0.04));
            const back = easeOutBack(seg(t, land + 0.04, H.duration));
            sh.squash = t < land + 0.04 ? lerp(1.06, 0.8, hit) : lerp(0.8, 1, back);
            sh.splay = 0.25 * bump(t, land, land + 0.04, land + 0.06, H.duration);
            sh.headPitch = -0.1 * bump(t, land, land + 0.04, land + 0.08, H.duration);
            sh.lid = 0.45 * bump(t, land, land + 0.03, land + 0.08, land + 0.2);
        }
    }

    function runTongue(sh, t, a) {
        sh.tongue = tongueShape(t);
        sh.headPitch = 0.07 * bump(t, 0, 0.06, 0.15, 0.32);     // the head pushes after the tongue
        sh.lid = 0.25 * bump(t, 0.05, 0.1, 0.17, 0.3);
        if (a.hasTarget) {
            sh.focusW = bump(t, 0, 0.05, 0.25, 0.35);
            sh.focus.copy(a.targetLocal);
        }
    }

    function runRain(sh, t) {
        // look up at the cloud (eyes first, then the head), squint, brace...
        const up = bump(t, 0, 0.25, 0.95, 1.2);
        sh.headPitch = 0.42 * up;
        sh.pupilY = 0.25 * bump(t, 0, 0.1, 0.95, 1.1);
        sh.lookW = 1 - up;
        sh.idleBlink = 0;
        // ...while the cloud puffs up and drips fast...
        sh.cloudPuff = 1 + 0.28 * (t < 0.35 ? easeOutBack(t / 0.35) : 1 - easeInOutSine(seg(t, 1.05, 1.5)));
        sh.dripRate = 1 + 4 * bump(t, 0.05, 0.25, 1.0, 1.3);
        sh.lid = Math.max(0.3 * bump(t, 0.3, 0.4, 0.9, 1.0), blink(t, 0.55));
        sh.splay = 0.14 * bump(t, 0.2, 0.4, 0.95, 1.05);
        // ...then a quick shiver to shake the drops off
        addShake(sh, t - 1.0, 0.6, 0.7);
    }

    function runCollect(sh, t, a) {
        const C = KOKO_TIMING.collect;
        const up = 0.16;
        const land = C.landAt;
        if (a.hasTarget) {
            sh.focusW = bump(t, 0, 0.08, 0.7, 1.0);
            sh.focus.copy(a.targetLocal);
        }
        if (t < up) {
            const k = easeOutCubic(seg(t, 0.06, up));
            sh.squash = 1 - 0.1 * k;
            sh.splay = 0.08 * k;
        } else if (t < land) {
            const u = (t - up) / (land - up);
            sh.rootY = C.height * 4 * u * (1 - u);
            const takeoff = easeOutCubic(seg(t, up, up + 0.05));
            sh.squash = t < up + 0.05 ? lerp(0.9, 1.08, takeoff) : lerp(1.08, 1.0, seg(t, up + 0.05, land));
            sh.splay = 0.08 * (1 - takeoff);
            sh.plant = 0;
            const tuck = bump(t, up, up + 0.06, land - 0.08, land);
            sh.legFL = sh.legFR = 0.2 * tuck;
            sh.legBL = sh.legBR = -0.2 * tuck;
        } else {
            const hit = easeOutCubic(seg(t, land, land + 0.04));
            const back = easeOutBack(seg(t, land + 0.04, 0.68));
            sh.squash = t < land + 0.04 ? lerp(1.0, 0.88, hit) : lerp(0.88, 1, back);
            sh.splay = 0.12 * bump(t, land, land + 0.04, land + 0.06, 0.68);
        }
        // happy wiggle: tail wag, a cute head tilt, content squint
        const happy = bump(t, 0.46, 0.56, 0.85, 1.0);
        sh.tailSway1 += Math.sin(TAU * 5 * t) * 0.18 * happy;
        sh.tailSway2 += Math.sin(TAU * 5 * t - 0.8) * 0.26 * happy;
        sh.headRoll += 0.12 * happy;
        sh.lid = Math.max(sh.lid, 0.35 * happy);
        sh.idleBlink = 0;
    }

    function runShake(sh, t) {
        addShake(sh, t, KOKO_TIMING.shake.duration, 1);
    }

    function runWake(sh, t) {
        // (the sleep layer opens the eyes over 0.25 s; this adds the head lift and the little shake)
        const env = bump(t, 0.2, 0.28, 0.4, 0.65);
        sh.headYaw = Math.sin(TAU * 5 * (t - 0.2)) * 0.12 * env;
        sh.headPitch = 0.06 * bump(t, 0, 0.2, 0.35, 0.6);
        sh.squash = 1 - 0.04 * bump(t, 0.25, 0.32, 0.36, 0.5);
        sh.loopFlap = Math.sin(TAU * 5 * (t - 0.2)) * 0.2 * env;
        sh.lid = blink(t, 0.45);
        sh.idleBlink = 0;
    }

    // ---------- 7.12 Intros (played once) ----------
    const INTRO_TURN_BODY = -0.3;   // concept A ends by turning toward the visitor
    const INTRO_TURN_HEAD = -0.45;

    function runIntroWake(sh, t) {
        const T = KOKO_TIMING.introWake;
        sh.idleBlink = 0;
        sh.lookW = easeInOutSine(seg(t, T.handover, T.duration - 0.1));
        // 1. drop in from above, stretched by the speed, eyes still shut
        if (t < T.landAt) {
            const u = t / T.landAt;
            sh.rootY = T.dropHeight * (1 - u * u);          // gravity: slow at the top, fast at the bottom
            sh.squash = 1.16;
            sh.plant = 0;
            sh.legFL = sh.legFR = 0.25;
            sh.legBL = sh.legBR = -0.25;
            sh.tailCurl0 = 0.1;
            sh.tailCurl1 = 0.15;
            sh.tailCurl2 = 0.2;
        } else if (t < 0.95) {
            // 2. land: a big squash, then spring back up with a little overshoot
            const hit = easeOutCubic(seg(t, T.landAt, T.landAt + 0.05));
            const back = easeOutBack(seg(t, T.landAt + 0.05, 0.95));
            sh.squash = t < T.landAt + 0.05 ? lerp(1.16, 0.72, hit) : lerp(0.72, 1, back);
            const legs = 0.25 * (1 - hit);
            sh.legFL = sh.legFR = legs;
            sh.legBL = sh.legBR = -legs;
            sh.splay = 0.3 * bump(t, T.landAt, T.landAt + 0.05, T.landAt + 0.12, 0.95);
            sh.tailCurl0 = 0.1 * (1 - hit);
            sh.tailCurl1 = 0.15 * (1 - hit);
            sh.tailCurl2 = 0.2 * (1 - hit);
            sh.headPitch = -0.12 * bump(t, T.landAt, T.landAt + 0.05, T.landAt + 0.1, 0.95);
        }
        // 3. stretch: reach forward (nose down, bottom up), then push the back legs out and stand tall
        const reach = bump(t, 1.15, 1.45, 1.55, 1.85);
        sh.legFL += 0.55 * reach;
        sh.legFR += 0.55 * reach;
        sh.bodyPitch -= 0.1 * reach;
        sh.headPitch += 0.15 * reach;
        sh.tailCurl0 += 0.15 * reach;
        sh.tailCurl1 += 0.2 * reach;
        sh.tailCurl2 += 0.25 * reach;
        const tall = bump(t, 1.55, 1.85, 1.95, 2.3);
        sh.legBL -= 0.5 * tall;
        sh.legBR -= 0.5 * tall;
        sh.squash *= 1 + 0.1 * tall;
        sh.bodyPitch += 0.06 * tall;
        sh.headPitch += 0.3 * tall;
        // eyes: shut, groggy half-open, squeezed while stretching, wide open, then two blinks
        let lid = 1;
        if (t >= 0.95) lid = lerp(1, 0.45, easeOutCubic(seg(t, 0.95, 1.15)));
        if (t >= 1.15) lid = lerp(0.45, 0.85, easeInOutSine(seg(t, 1.15, 1.35)));
        if (t >= 2.15) lid = lerp(0.85, 0, easeOutCubic(seg(t, 2.15, 2.3)));
        sh.headRoll = 0.1 * bump(t, 2.35, 2.55, 2.75, 2.95);      // a curious tilt between the blinks
        // 4. a petal falls: follow it, pull back a hair (anticipation), flick, catch
        sh.focusW = bump(t, T.petalAt, T.petalAt + 0.3, T.hitAt + 0.1, T.hitAt + 0.4);
        sh.focus.copy(petalPos);
        const ready = bump(t, T.flickAt - 0.15, T.flickAt - 0.05, T.flickAt - 0.03, T.flickAt + 0.03);
        sh.headPitch -= 0.06 * ready;
        sh.squash *= 1 - 0.04 * ready;
        sh.tongue = tongueShape(t - T.flickAt);
        sh.headPitch += 0.07 * bump(t - T.flickAt, 0, 0.06, 0.15, 0.32);
        // 5. munch: two little nods, a content squint and a tail wag
        const chew = bump(t, 4.45, 4.5, 4.75, 4.85);
        sh.headPitch += Math.sin(TAU * 5 * (t - 4.45)) * 0.05 * chew;
        sh.tailSway1 += Math.sin(TAU * 4 * t) * 0.15 * chew;
        sh.tailSway2 += Math.sin(TAU * 4 * t - 0.8) * 0.22 * chew;
        sh.lid = Math.max(lid, blink(t, 2.4), blink(t, 2.7), 0.3 * chew);
        // 6. turn toward the visitor; at T.handover the springs take this turn over (see handOverTurn)
        if (t < T.handover) {
            const turn = easeInOutSine(seg(t, 4.85, T.handover));
            sh.rootYaw = INTRO_TURN_BODY * turn;
            sh.headYaw = INTRO_TURN_HEAD * turn;
        }
    }

    // The scripted turn becomes the starting point of the look springs, so look-follow continues smoothly
    // from exactly where the intro left Koko (no jump).
    function handOverTurn() {
        look.body.x += INTRO_TURN_BODY;
        look.yaw.x += INTRO_TURN_HEAD;
    }

    function runIntroMonsoon(sh, t, a) {
        const T = KOKO_TIMING.introMonsoon;
        sh.idleBlink = 0;
        sh.lookW = easeInOutSine(seg(t, T.backAt, T.duration));
        // 1. look up: the cloud swells and the rain starts
        sh.headPitch += 0.4 * bump(t, 0, 0.35, 0.55, 0.75);
        sh.pupilY += 0.25 * bump(t, 0, 0.15, 0.55, 0.7);
        sh.cloudPuff = 1 + 0.35 * (t < 0.6 ? easeOutBack(t / 0.6) : 1 - easeInOutSine(seg(t, T.rainStop, T.rainGone)));
        sh.dripRate = 1 + 5 * (t < T.rainStop
            ? easeInOutSine(seg(t, T.rainStart, T.rainFull))
            : 1 - easeInOutSine(seg(t, T.rainStop, T.rainStop + 0.4)));
        // 2. a drop lands on Koko: flinch and blink
        const flinch = bump(t, 0.55, 0.6, 0.62, 0.8);
        sh.headPitch -= 0.18 * flinch;
        sh.squash *= 1 - 0.05 * flinch;
        let lid = Math.max(blink(t, 0.56), 0.3 * bump(t, 0.6, 0.7, 0.85, 0.95));
        // 3. glance toward the shelter (head first), turn, scurry there, then turn to show his side again
        sh.headYaw += a.glance * bump(t, 0.65, 0.8, 0.95, 1.1);
        const settleTurn = T.arriveAt - 0.05;
        let yaw;
        if (t < T.goAt) yaw = lerp(0, a.yawOut, easeInOutSine(seg(t, T.shelterAt, T.goAt)));
        else if (t < settleTurn) yaw = a.yawOut;
        else if (t < T.shakeAt + 0.6) yaw = lerp(a.yawOut, a.yawFace, easeInOutSine(seg(t, settleTurn, T.arriveAt + 0.2)));
        else if (t < T.homeAt) yaw = lerp(a.yawFace, a.yawBack, easeInOutSine(seg(t, T.shakeAt + 0.6, T.homeAt)));
        else if (t < T.backAt - 0.05) yaw = a.yawBack;
        else yaw = lerp(a.yawBack, a.yawEnd, easeInOutSine(seg(t, T.backAt - 0.05, T.backAt + 0.2)));
        sh.rootYaw = yaw;
        const goOut = easeInOutSine(seg(t, T.goAt, T.arriveAt));
        const goHome = easeInOutSine(seg(t, T.homeAt, T.backAt));
        sh.rootX = a.dx * (goOut - goHome);
        sh.rootZ = a.dz * (goOut - goHome);
        // the walk cycle's phase is tied to the distance travelled, so the feet never slide
        addWalk(sh, a.dist * goOut / STRIDE,
            bump(t, T.goAt - 0.05, T.goAt + 0.05, T.arriveAt - 0.05, T.arriveAt + 0.05) * a.travel);
        addWalk(sh, a.dist * goHome / STRIDE,
            bump(t, T.homeAt - 0.05, T.homeAt + 0.05, T.backAt - 0.05, T.backAt + 0.05) * a.travel);
        // 4. shelter: crouch low, tail tucked, small shivers, peek up at the leaf, then again as the rain stops
        const crouch = bump(t, T.arriveAt, T.arriveAt + 0.3, 3.95, T.shakeAt - 0.05);
        sh.splay += 0.45 * crouch;
        sh.headPitch -= 0.1 * crouch;
        sh.tailSway0 += 0.12 * crouch;
        sh.tailSway1 += 0.2 * crouch;
        sh.tailSway2 += 0.3 * crouch;
        sh.bodyRoll += Math.sin(TAU * 9 * t) * 0.02 * bump(t, 2.4, 2.6, 3.4, 3.6);
        sh.headPitch += 0.22 * bump(t, 2.85, 3.05, 3.2, 3.4) + 0.3 * bump(t, 3.75, 3.95, 4.0, 4.2);
        sh.pupilY += 0.2 * bump(t, 2.8, 2.95, 3.2, 3.35) + 0.25 * bump(t, 3.7, 3.85, 4.0, 4.15);
        lid = Math.max(lid, 0.35 * bump(t, 2.2, 2.4, 3.6, 3.75), blink(t, 2.7), blink(t, 3.3));
        // 5. the sun is back: a full-body shake-off
        addShake(sh, t - T.shakeAt, 0.6, 1);
        // 6. trot home (above), then settle with a small squash
        sh.squash *= 1 - 0.05 * bump(t, 6.15, 6.21, 6.25, T.duration);
        sh.lid = Math.max(sh.lid, lid);
    }

    // Where should Koko shelter? opts.shelterPoint (world Vector3) wins; an Object3D works too
    // (opts.shelter, e.g. grove-b's props.shelterSpot); a leaf Object3D gives the middle of its footprint.
    function shelterWorld(opts, out) {
        if (opts.shelterPoint) return out.copy(opts.shelterPoint);
        const spot = opts.shelter || opts.shelterSpot;
        if (spot && spot.isObject3D) return spot.getWorldPosition(out);
        if (opts.leaf && opts.leaf.isObject3D) {
            const box = new THREE.Box3().setFromObject(opts.leaf);     // once per intro, not per frame
            box.getCenter(out);
            out.y = box.min.y;
            return out;
        }
        return null;
    }

    function callShelter(a) {
        emit("shelter-go");
        if (a.onShelter) {
            try {
                a.onShelter();
            } catch (err) {
                console.error("onShelter failed:", err);
            }
        }
    }

    // Each action: duration, run(sheet, t, instance) and timed events. kick = a push to the bow spring.
    const ACTIONS = {
        hop: {
            name: "hop", dur: KOKO_TIMING.hop.duration, run: runHop,
            events: [{ at: KOKO_TIMING.hop.takeoffAt, kick: -3 }, { at: KOKO_TIMING.hop.landAt, kick: -8, emit: "landed" }]
        },
        tongue: {
            name: "tongue", dur: KOKO_TIMING.tongue.duration, run: runTongue, overlay: true,
            events: [{ at: KOKO_TIMING.tongue.hitAt, emit: "tongue-hit" }]
        },
        rain: { name: "rain", dur: KOKO_TIMING.rain.duration, run: runRain, events: [{ at: 1.0, kick: -2 }] },
        collect: {
            name: "collect", dur: KOKO_TIMING.collect.duration, run: runCollect,
            events: [{ at: 0.16, kick: -2 }, { at: KOKO_TIMING.collect.landAt, kick: -5, emit: "landed" }]
        },
        shake: { name: "shake", dur: KOKO_TIMING.shake.duration, run: runShake, events: [{ at: 0, emit: "shake" }] },
        wake: { name: "wake", dur: KOKO_TIMING.wake.duration, run: runWake, events: [{ at: 0.25, kick: -3 }] },
        "intro-wake": {
            name: "intro-wake", dur: KOKO_TIMING.introWake.duration, run: runIntroWake, intro: true,
            events: [
                { at: KOKO_TIMING.introWake.landAt, kick: -10, emit: "landed" },
                { at: KOKO_TIMING.introWake.hitAt, emit: "tongue-hit" },
                { at: KOKO_TIMING.introWake.handover, call: handOverTurn }
            ]
        },
        "intro-monsoon": {
            name: "intro-monsoon", dur: KOKO_TIMING.introMonsoon.duration, run: runIntroMonsoon, intro: true,
            events: [
                { at: KOKO_TIMING.introMonsoon.rainStart, emit: "rain-start" },
                { at: KOKO_TIMING.introMonsoon.shelterAt, call: callShelter },
                { at: KOKO_TIMING.introMonsoon.arriveAt, emit: "shelter" },
                { at: KOKO_TIMING.introMonsoon.rainStop, emit: "rain-stop" },
                { at: KOKO_TIMING.introMonsoon.shakeAt, kick: -3, emit: "shake" },
                { at: 6.21, kick: -3 }
            ]
        }
    };

    // ---------- 7.13 Action slots (three, reused forever: no allocation) ----------
    function makeSlot() {
        return {
            def: null, t: 0, next: 0, fade: 0,
            hasTarget: false, targetWorld: new THREE.Vector3(), targetLocal: new THREE.Vector3(),
            dx: 0, dz: 0, dist: 0, travel: 0, glance: 0,
            yawOut: 0, yawFace: 0, yawBack: 0, yawEnd: 0, onShelter: null
        };
    }
    let mainSlot = makeSlot();      // the current body action (hop, rain, intro...)
    let fadeSlot = makeSlot();      // the action being faded out after an interruption
    const tongueSlot = makeSlot();  // the tongue runs on its own layer, on top of anything

    function setupSlot(slot, def, opts) {
        slot.def = def;
        slot.t = 0;
        slot.next = 0;
        slot.fade = 0;
        slot.hasTarget = !!(opts && opts.target);
        if (slot.hasTarget) slot.targetWorld.copy(opts.target);
        slot.onShelter = null;
        if (def.name === "intro-monsoon") {
            const T = KOKO_TIMING.introMonsoon;
            let dx = 4;                                  // default: scurry 4 voxels ahead
            let dz = 0;
            if (opts && shelterWorld(opts, tmpB)) {
                refreshParentInverse();
                worldToRest(tmpB, tmpA);
                dx = tmpA.x;
                dz = tmpA.z;
            }
            let dist = Math.sqrt(dx * dx + dz * dz);
            if (dist > T.maxTravel) {
                dx *= T.maxTravel / dist;
                dz *= T.maxTravel / dist;
                dist = T.maxTravel;
            }
            if (dist < 0.5) dx = dz = dist = 0;
            slot.dx = dx;
            slot.dz = dz;
            slot.dist = dist;
            slot.travel = dist > 0 ? 1 : 0;
            // headings (yaw): out to the shelter, back to the canonical side there, home, canonical again
            slot.yawOut = dist > 0 ? turnVia(0, Math.atan2(-dz, dx)) : 0;
            slot.yawFace = turnVia(slot.yawOut, 0);
            slot.yawBack = dist > 0 ? turnVia(slot.yawFace, Math.atan2(dz, -dx)) : slot.yawFace;
            slot.yawEnd = turnVia(slot.yawBack, 0);
            slot.glance = clamp(slot.yawOut, LOOK.yawMin, LOOK.yawMax) * 0.7;
            slot.onShelter = (opts && opts.onShelter) || null;
        }
    }

    function fireEvents(slot) {
        const events = slot.def.events;
        while (slot.next < events.length && slot.t >= events[slot.next].at) {
            const ev = events[slot.next];
            slot.next += 1;
            if (ev.kick) bowSpring.v += ev.kick;
            if (ev.call) ev.call(slot);
            if (ev.emit) emit(ev.emit);
        }
    }

    // Move the running action to the fade slot, where it melts away over FADE_TIME instead of popping.
    function fadeOutMain() {
        if (!mainSlot.def) return;
        if (mainSlot.def.intro) emit("intro-done");          // a forced interruption still closes the intro
        const spare = fadeSlot;
        fadeSlot = mainSlot;
        mainSlot = spare;
        fadeSlot.fade = 0;
        mainSlot.def = null;
    }

    function startMain(def, opts) {
        fadeOutMain();
        setupSlot(mainSlot, def, opts);
    }

    function finishMain() {
        const def = mainSlot.def;
        mainSlot.def = null;
        if (def.intro) emit("intro-done");
        if (queued.name) {
            const name = queued.name;
            const opts = queued.opts;
            queued.name = null;
            queued.opts = null;
            play(name, opts);
        }
    }

    function advanceSlots(dt) {
        if (mainSlot.def) {
            mainSlot.t += dt;
            fireEvents(mainSlot);
            if (mainSlot.t >= mainSlot.def.dur) finishMain();
        }
        if (fadeSlot.def) {
            fadeSlot.t += dt;
            fadeSlot.fade += dt;
            if (fadeSlot.fade >= FADE_TIME || fadeSlot.t >= fadeSlot.def.dur) fadeSlot.def = null;
        }
        if (tongueSlot.def) {
            tongueSlot.t += dt;
            fireEvents(tongueSlot);
            if (tongueSlot.t >= tongueSlot.def.dur) tongueSlot.def = null;
        }
    }

    function blendSlot(slot, w) {
        if (!slot.def || w <= 0) return;
        if (slot.hasTarget) worldToRest(slot.targetWorld, slot.targetLocal);
        clearPoseSheet(S);
        slot.def.run(S, Math.min(slot.t, slot.def.dur), slot);
        mergePoseSheet(P, S, w);
    }

    function cancelActions() {
        mainSlot.def = null;
        fadeSlot.def = null;
        tongueSlot.def = null;
        queued.name = null;
        queued.opts = null;
    }

    // ---------- 7.14 Sleep ----------
    function fallAsleep() {
        if (sleep.target === 1) return;
        fadeOutMain();
        sleep.target = 1;
        clock.z = 0;
        emit("sleep");
    }

    function addSleep(s) {
        if (s <= 0) return;
        P.lid = Math.max(P.lid, s);
        P.headPitch -= 0.22 * s;             // the head droops
        P.lookW *= 1 - s;
        P.splay += 0.35 * s;                 // legs relax outward, the belly sinks (feet stay put)
        P.tailSway0 += 0.1 * s;              // the tail curls round
        P.tailSway1 += 0.18 * s;
        P.tailSway2 += 0.26 * s;
        P.bowPitch -= 0.1 * s;               // even the bow droops
        P.cloudBobY -= 0.6 * s;              // the cloud settles lower...
        P.dripRate *= 1 - 0.5 * s;           // ...and drips slower
        P.zzz = clamp01((s - 0.5) * 2);
    }

    // ---------- 7.15 Write the pose sheet onto the rig ----------
    function applyPose() {
        // root: position, turn, and squash & stretch around the feet (root's origin is on the ground).
        // Volume is kept: squash 0.8 tall makes it 1/sqrt(0.8) ≈ 1.12 wider.
        const sq = P.squash;
        const wide = 1 / Math.sqrt(sq);
        setPos(restRoot, P.rootX, P.rootY, P.rootZ);
        setRot(restRoot, 0, P.rootYaw + look.body.x, 0);
        setScale(restRoot, wide, sq, wide);

        // legs, and "foot planting": a leg swung by angle a lifts its foot by legLen * (1 - cos a), so we lower
        // the body by that much (using the most upright leg) and the feet stay on the ground.
        const fl = P.legFL + P.splay;
        const fr = P.legFR + P.splay;
        const bl = P.legBL - P.splay;
        const br = P.legBR - P.splay;
        const upright = Math.min(Math.abs(fl), Math.abs(fr), Math.abs(bl), Math.abs(br));
        const plantDrop = legLen * (1 - Math.cos(upright)) * P.plant;
        setRot(restLegs.fl, 0, 0, fl);
        setRot(restLegs.fr, 0, 0, fr);
        setRot(restLegs.bl, 0, 0, bl);
        setRot(restLegs.br, 0, 0, br);

        // body + breathing. The chest swells around the torso centre; we lift the body by the same ratio so
        // the feet do not sink into the ground while it does.
        const b = P.breath;
        setPos(restBody, 0, P.bodyY - plantDrop + bodyPivotY * b, 0);
        setRot(restBody, P.bodyRoll, P.bodyYaw, P.bodyPitch);
        setScale(restBody, 1 + 0.35 * b, 1 + b, 1 + 0.8 * b);

        // head: scripted offsets + the look springs
        setRot(restHead, P.headRoll, P.headYaw + look.yaw.x, P.headPitch + look.pitch.x);

        // pupils (±0.3 in eye space)
        const px = clamp(look.px.x + P.pupilX, -0.3, 0.3);
        const py = clamp(look.py.x + P.pupilY, -0.3, 0.3);
        for (let i = 0; i < restPupils.length; i++) setPos(restPupils[i], px, py, 0);

        // lids: scale.y 0.001 = open (hidden), 1 = shut
        const lid = clamp01(P.lid);
        for (let i = 0; i < lids.length; i++) {
            lids[i].scale.y = Math.max(0.001, lid);
            lids[i].visible = lid > 0.01;
        }

        // tongue: scale.x 0 = hidden, 1 = fully out
        const tongue = clamp01(P.tongue);
        rig.tongue.scale.x = Math.max(0.0001, tongue);
        rig.tongue.visible = tongue > 0.01;

        // tail chain: y = sway, z = curl
        if (restTail[0]) setRot(restTail[0], 0, P.tailSway0, P.tailCurl0);
        if (restTail[1]) setRot(restTail[1], 0, P.tailSway1, P.tailCurl1);
        if (restTail[2]) setRot(restTail[2], 0, P.tailSway2, P.tailCurl2);

        // bow: scripted wobble + the bouncy spring. A negative spring value = loops dragged down (droop).
        if (restBow) {
            const boing = bowSpring.x;
            setRot(restBow, P.bowRoll, 0, P.bowPitch + boing * 0.25);
            setScale(restBow, 1 - boing * 0.06, 1 + boing * 0.12, 1 - boing * 0.06);
            const flap = P.loopFlap + boing;
            for (let i = 0; i < restLoops.length; i++) {
                const rec = restLoops[i];
                const f = loopFlapAxis[i];
                if (f.axis === "z") setRot(rec, 0, 0, f.sign * flap);
                else setRot(rec, f.sign * flap, 0, 0);
            }
        }
    }

    // ---------- 7.16 Cloud: follows Koko with a lagging spring; drops fall and recycle ----------
    function updateCloud(dt) {
        if (!cloud) return;
        const croot = cloud.root;
        const kp = root.parent;
        const cp = croot.parent;
        // where the cloud wants to be: cloudHome above Koko's current root position (ignoring squash)
        tmpA.copy(anchors.cloudHome).multiply(restRoot.s).applyQuaternion(restRootQuat).add(root.position);
        if (kp) {
            tmpA.applyMatrix4(kp.matrixWorld);
            kp.matrixWorld.decompose(posK, quatK, scaleK);
        } else {
            quatK.identity();
            scaleK.set(1, 1, 1);
        }
        if (cp) {
            cp.updateWorldMatrix(true, false);
            cloudInv.copy(cp.matrixWorld).invert();
            tmpA.applyMatrix4(cloudInv);
            cp.matrixWorld.decompose(posC, quatC, scaleC);
        } else {
            quatC.identity();
            scaleC.set(1, 1, 1);
        }
        const cs = cloudSpring;
        if (!cs.snapped || reduced) {
            resetSpring(cs.x, tmpA.x);
            resetSpring(cs.y, tmpA.y);
            resetSpring(cs.z, tmpA.z);
            cs.snapped = true;
        } else {
            const c = critical(CLOUD_K);
            stepSpring(cs.x, tmpA.x, CLOUD_K, c, dt);
            stepSpring(cs.y, tmpA.y, CLOUD_K, c, dt);
            stepSpring(cs.z, tmpA.z, CLOUD_K, c, dt);
        }
        // match Koko's size and facing even if the cloud lives in another parent
        croot.quaternion.copy(quatC).invert().multiply(quatK).multiply(restCloudQuat);
        croot.scale.copy(restCloud.s).multiply(scaleK).divide(scaleC);
        // the bob is added AFTER the spring, so the idle loop stays exactly periodic
        tmpB.set(P.cloudBobX, P.cloudBobY, 0).multiply(croot.scale).applyQuaternion(croot.quaternion);
        croot.position.set(cs.x.x + tmpB.x, cs.y.x + tmpB.y, cs.z.x + tmpB.z);
        if (P.cloudRoll !== 0) {
            tmpQ.setFromAxisAngle(Z_AXIS, P.cloudRoll);
            croot.quaternion.multiply(tmpQ);
        }
        if (restPuff) setScale(restPuff, P.cloudPuff, P.cloudPuff, P.cloudPuff);
        // drops: one shared clock; drop i is i/n of a cycle behind the first
        clock.drops = frac(clock.drops + (dt * P.dripRate) / DRIP_PERIOD);
        const n = restDrops.length;
        for (let i = 0; i < n; i++) {
            placeDrop(restDrops[i], reduced ? 0.12 + (0.5 * i) / n : frac(clock.drops + i / n));
        }
    }

    // u = 0..1 through one drop cycle: it falls during the first 70 %, then waits hidden to be recycled.
    function placeDrop(rec, u) {
        const fallPart = 0.7;
        if (u >= fallPart) {
            rec.obj.visible = false;
            return;
        }
        const a = u / fallPart;
        const s = easeOutCubic(clamp01(a / 0.15)) * (1 - easeInOutSine(seg(a, 0.8, 1)));
        rec.obj.visible = s > 0.02;
        rec.obj.position.set(rec.p.x, dropTopY - DROP_FALL * a * a, rec.p.z);   // speeds up like gravity
        const k = Math.max(s, 0.0001);
        rec.obj.scale.set(rec.s.x * k, rec.s.y * k * (1 + 0.5 * a), rec.s.z * k); // stretches as it speeds up
    }

    // ---------- 7.17 Sleepy z's ----------
    function updateZzz(dt, amount) {
        if (amount <= 0.001) {
            for (let i = 0; i < zs.length; i++) zs[i].visible = false;
            return;
        }
        clock.z = (clock.z + dt) % Z_PERIOD;
        for (let i = 0; i < zs.length; i++) {
            const u = reduced ? 0.25 + 0.22 * i : frac(clock.z / Z_PERIOD + i / zs.length);
            const pop = easeOutBack(clamp01(u / 0.15));
            const fade = 1 - easeInOutSine(seg(u, 0.75, 1));
            const s = (0.55 + 0.45 * u) * pop * fade * amount;   // grows as it rises, shrinks away at the top
            const g = zs[i];
            g.visible = s > 0.02;
            g.position.set(zStart.x + 1.6 * u + Math.sin(TAU * u * 1.5) * 0.35, zStart.y + 4.5 * u, zStart.z);
            g.rotation.z = Math.sin(TAU * u) * 0.25;
            g.scale.setScalar(Math.max(s, 0.0001));
        }
    }

    // ---------- 7.18 Intro petal (concept A) ----------
    function updatePetal() {
        const T = KOKO_TIMING.introWake;
        const slot = mainSlot;
        if (!slot.def || slot.def.name !== "intro-wake" || slot.t < T.petalAt || slot.t > T.hitAt + 0.23) {
            petal.visible = false;
            return;
        }
        const t = slot.t;
        petal.visible = true;
        // the real tongue tip right now (fully out, or as far out as it currently is)
        rig.head.updateWorldMatrix(true, false);
        const out = t < T.hitAt ? 1 : tongueShape(t - T.flickAt);
        tmpB.copy(restTongue.p).lerp(tipInHead, out);
        rig.head.localToWorld(tmpB);
        root.worldToLocal(tmpB);
        if (t < T.hitAt) {
            // drift down, swaying like a falling leaf; the last 0.3 s it is drawn to the tongue tip so the
            // catch lines up exactly
            const u = seg(t, T.petalAt, T.hitAt);
            const sway = Math.sin(TAU * 0.9 * (t - T.petalAt));
            petalPos.set(
                lerp(petalStart.x, tipRest.x, u) + sway * 1.2 * (1 - u),
                lerp(petalStart.y, tipRest.y + 0.5, u),
                lerp(petalStart.z, tipRest.z, u)
            );
            petalPos.lerp(tmpB, easeInOutSine(seg(t, T.hitAt - 0.3, T.hitAt)));
            petal.rotation.set(sway * 0.5, (t - T.petalAt) * 1.5, Math.cos(TAU * 0.9 * (t - T.petalAt)) * 0.4);
            petal.scale.setScalar(Math.max(0.0001, easeOutBack(seg(t, T.petalAt, T.petalAt + 0.2))));
        } else {
            // caught: it rides the tongue back into the mouth and is gone
            petalPos.copy(tmpB);
            petal.scale.setScalar(Math.max(0.0001, 0.3 + 0.7 * out));
        }
        petal.position.copy(petalPos);
    }

    // ---------- 7.19 Look-follow ----------
    function updateLook(dt) {
        const lw = look.active ? P.lookW : 0;
        const fw = P.focusW;
        let yawT = 0;
        let pitchT = 0;
        if (lw > 0) {
            aimAt(worldToRest(look.world, tmpA), aimLook);
            yawT = aimLook.yaw * lw;
            pitchT = aimLook.pitch * lw;
        }
        if (fw > 0) {
            aimAt(P.focus, aimFocus);
            yawT = lerp(yawT, aimFocus.yaw, fw);
            pitchT = lerp(pitchT, aimFocus.pitch, fw);
        }
        // the body takes a share of a big turn (not while walking); the head does the rest
        const bodyT = clamp(yawT * LOOK.bodyShare, -0.3, 0.3) * (1 - walkE);
        stepSpring(look.body, bodyT, LOOK.kBody, critical(LOOK.kBody), dt);
        stepSpring(look.yaw, yawT - look.body.x, LOOK.kHead, critical(LOOK.kHead), dt);
        stepSpring(look.pitch, pitchT, LOOK.kHead, critical(LOOK.kHead), dt);
        // pupils lead: they aim from where the head is NOW, with a much faster spring
        const headYaw = look.body.x + look.yaw.x;
        const headPitch = look.pitch.x;
        let pxT = 0;
        let pyT = 0;
        if (lw > 0) {
            pupilAim(aimLook, headYaw, headPitch, pupilAimOut);
            pxT = pupilAimOut.x * lw;
            pyT = pupilAimOut.y * lw;
        }
        if (fw > 0) {
            pupilAim(aimFocus, headYaw, headPitch, pupilAimOut);
            pxT = lerp(pxT, pupilAimOut.x, fw);
            pyT = lerp(pyT, pupilAimOut.y, fw);
        }
        stepSpring(look.px, pxT, LOOK.kPupil, critical(LOOK.kPupil), dt);
        stepSpring(look.py, pyT, LOOK.kPupil, critical(LOOK.kPupil), dt);
    }

    function resetSprings() {
        resetSpring(look.yaw);
        resetSpring(look.pitch);
        resetSpring(look.body);
        resetSpring(look.px);
        resetSpring(look.py);
        resetSpring(bowSpring);
        cloudSpring.snapped = false;
    }

    // ---------- 7.20 Still poses (pose("hero"), and the reduced-motion stand-ins for actions) ----------
    function addStillPose(name) {
        switch (name) {
            case "hero":
                P.rootYaw -= 0.18;
                P.headYaw -= 0.3;
                P.headPitch += 0.1;
                P.headRoll += 0.06;
                P.tailCurl1 += 0.08;
                P.tailCurl2 += 0.16;
                P.legFL += 0.15;
                P.legBL -= 0.1;
                P.bowRoll += 0.05;
                break;
            case "hop":
                P.headPitch += 0.12;
                P.tailCurl2 += 0.15;
                break;
            case "tongue":
                P.tongue = 1;
                P.headPitch += 0.05;
                break;
            case "rain":
                P.headPitch += 0.35;
                P.pupilY += 0.25;
                P.cloudPuff *= 1.1;
                P.lid = Math.max(P.lid, 0.3);
                break;
            case "collect":
                P.headYaw += rm.yaw;
                P.headPitch += rm.pitch;
                P.headRoll += 0.1;
                break;
            case "shake":
                P.lid = Math.max(P.lid, 0.8);
                break;
            default:
                break;
        }
    }

    const RM_HOLD = { hop: 0.5, tongue: 0.3, rain: 1.2, collect: 0.8, shake: 0.3 };

    // Reduced motion: no travel, no tweens. An action becomes a small still pose held for a moment, then Koko
    // snaps back. Events still fire so game logic (coins, sounds) keeps working.
    function playReduced(name, opts) {
        if (name === "intro-wake" || name === "intro-monsoon") {
            cancelActions();
            rm.name = null;
            emit("intro-done");
            return true;
        }
        if (name === "sleep") {
            sleep.k = sleep.target = 1;
            emit("sleep");
            return true;
        }
        if (name === "wake") {
            if (!sleep.target) return false;
            sleep.k = sleep.target = 0;
            emit("wake");
            return true;
        }
        if (sleep.target) {
            sleep.k = sleep.target = 0;
            emit("wake");
        }
        rm.name = name;
        rm.t = 0;
        rm.dur = RM_HOLD[name] || 0.4;
        rm.yaw = 0;
        rm.pitch = 0;
        if (name === "collect" && opts && opts.target) {
            refreshParentInverse();
            aimAt(worldToRest(opts.target, tmpA), aimFocus);
            rm.yaw = aimFocus.yaw * 0.7;
            rm.pitch = aimFocus.pitch * 0.7;
        }
        if (name === "hop" || name === "collect") emit("landed");
        if (name === "tongue") emit("tongue-hit");
        if (name === "shake") emit("shake");
        return true;
    }

    // ---------- 7.21 The frame ----------
    function currentState() {
        if (reduced && rm.name) return rm.name;
        if (mainSlot.def) return mainSlot.def.name;
        if (tongueSlot.def) return "tongue";
        if (sleep.target === 1) return "sleeping";
        if (walk.speed > 0) return "walking";
        return "idle";
    }

    function update(dt /*, elapsed */) {
        // `elapsed` is accepted for symmetry with the scenes, but Koko keeps his own clocks (built from the
        // clamped dt), so stepping with a fixed dt is fully deterministic.
        dt = clamp(Number(dt) || 0, 0, 0.1);
        clearPoseSheet(P);
        refreshParentInverse();

        if (reduced) {
            updateReduced(dt);
        } else {
            updateAnimated(dt);
        }

        const state = currentState();
        if (state !== lastState) {
            lastState = state;
            emit("state");
        }
    }

    function updateAnimated(dt) {
        // clocks
        clock.idle = (clock.idle + dt) % KOKO_TIMING.idleLoop;
        clock.quiet += dt;
        if (clock.quiet > KOKO_TIMING.sleepAfter && !mainSlot.def && !tongueSlot.def && walk.speed === 0 && !still) {
            fallAsleep();
        }
        const sleepRate = sleep.target ? 1 / 0.8 : 1 / 0.25;
        sleep.k = sleep.k < sleep.target
            ? Math.min(sleep.target, sleep.k + dt * sleepRate)
            : Math.max(sleep.target, sleep.k - dt * sleepRate);
        const sleepE = easeInOutSine(sleep.k);

        const walkTarget = walk.speed > 0 ? 1 : 0;
        walk.w = walk.w < walkTarget ? Math.min(1, walk.w + dt / 0.25) : Math.max(0, walk.w - dt / 0.25);
        walkE = easeInOutSine(walk.w);
        if (walk.speed > 0) walk.freq = clamp(walk.speed / voxelWorld / STRIDE, 0.4, 2.5);
        walk.phase = frac(walk.phase + walk.freq * dt * (walkE > 0 ? 1 : 0));

        // layers
        advanceSlots(dt);
        const fadeW = fadeSlot.def ? 1 - easeInOutSine(clamp01(fadeSlot.fade / FADE_TIME)) : 0;
        blendSlot(fadeSlot, fadeW);
        blendSlot(mainSlot, 1);
        blendSlot(tongueSlot, 1);
        if (still) addStillPose(still);
        addIdle(clock.idle, sleepE);
        addWalk(P, walk.phase, walkE);
        addSleep(sleepE);

        // springs, then write everything
        updateLook(dt);
        stepSpring(bowSpring, 0, BOW_K, BOW_C, dt);
        applyPose();
        updateCloud(dt);
        updateZzz(dt, P.zzz);
        updatePetal();
    }

    function updateReduced(dt) {
        if (rm.name) {
            rm.t += dt;
            if (rm.t >= rm.dur) rm.name = null;
        }
        if (still) addStillPose(still);
        if (rm.name) addStillPose(rm.name);
        if (sleep.target) {
            P.lid = 1;
            P.headPitch -= 0.22;
            P.splay += 0.35;
            P.bowPitch -= 0.1;
            P.zzz = 1;
        }
        applyPose();
        updateCloud(0);
        updateZzz(0, P.zzz);
        petal.visible = false;
    }

    // ---------- 7.22 Public API ----------
    function noteInput() {
        clock.quiet = 0;
        if (sleep.target === 1 && !reduced && !(mainSlot.def && mainSlot.def.name === "wake")) play("wake");
    }

    function play(name, opts = {}) {
        if (name !== "sleep" && !ACTIONS[name]) {
            console.warn("koko-anim: unknown action", name);
            return false;
        }
        still = null;
        if (name !== "sleep") clock.quiet = 0;
        if (reduced) return playReduced(name, opts);

        // intros are not interrupted (pass { force: true } to do it anyway)
        if (mainSlot.def && mainSlot.def.intro && !(opts && opts.force)) return false;

        if (name === "sleep") {
            fallAsleep();
            return true;
        }
        if (name === "wake") {
            if (sleep.target === 0) return false;
            sleep.target = 0;
            emit("wake");
            startMain(ACTIONS.wake, opts);
            return true;
        }
        // asleep? wake up first; the request plays right after
        if (sleep.target === 1) {
            queued.name = name;
            queued.opts = opts;
            sleep.target = 0;
            emit("wake");
            startMain(ACTIONS.wake, null);
            return true;
        }
        const def = ACTIONS[name];
        if (def.overlay) {
            setupSlot(tongueSlot, def, opts);
            return true;
        }
        // already in the air: a second hop would look broken, so ignore it
        if (name === "hop" && mainSlot.def === ACTIONS.hop && mainSlot.t < KOKO_TIMING.hop.landAt) return false;
        if (def.intro) {
            resetSprings();
            tongueSlot.def = null;
        }
        startMain(def, opts);
        return true;
    }

    function lookAt(point) {
        if (!point) {
            if (look.active) {
                look.active = false;
                noteInput();
            }
            return;
        }
        // calling this every frame with a still pointer does not count as input, so Koko can still doze off
        const eps = 0.05 * voxelWorld;
        if (!look.active || look.world.distanceToSquared(point) > eps * eps) noteInput();
        look.world.copy(point);
        look.active = true;
    }

    function setWalking(speed) {
        const s = Math.max(0, Number(speed) || 0);
        if (s > 0) noteInput();
        walk.speed = s;
    }

    function setReducedMotion(on) {
        reduced = !!on;
        cancelActions();
        rm.name = null;
        walk.w = 0;
        walkE = 0;
        resetSprings();
        if (!sleep.target) sleep.k = 0;
        else sleep.k = 1;
        clock.idle = 0;
        clock.drops = 0;
        clock.quiet = 0;
        update(0);
    }

    // Snap to a named still pose. pose("idle", t) evaluates the idle loop at exactly time t (for capture).
    function pose(name = "idle", t = 0) {
        cancelActions();
        rm.name = null;
        resetSprings();
        sleep.k = sleep.target = name === "sleep" ? 1 : 0;
        walk.speed = 0;
        walk.w = 0;
        walk.phase = 0;
        walkE = 0;
        still = name === "hero" ? "hero" : null;
        clock.idle = ((t % KOKO_TIMING.idleLoop) + KOKO_TIMING.idleLoop) % KOKO_TIMING.idleLoop;
        clock.drops = frac(t / DRIP_PERIOD);
        clock.quiet = 0;
        clock.z = 0;
        update(0);
        return true;
    }

    function dispose() {
        for (const g of zs) root.remove(g);
        root.remove(petal);
        zGeo.dispose();
        zMat.dispose();
        petalGeo.dispose();
        petalMat.dispose();
        for (const key of Object.keys(listeners)) delete listeners[key];
    }

    const api = {
        update,
        play,
        lookAt,
        setWalking,
        setReducedMotion,
        pose,
        on,
        dispose,
        get state() {
            return currentState();
        },
        get reducedMotion() {
            return reduced;
        },
        timing: KOKO_TIMING
    };

    pose("idle", 0);
    return api;
}
