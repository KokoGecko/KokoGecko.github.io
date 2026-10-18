// koko-model.js — Koko the gecko as a chunky 3D voxel toy.
//
// Koko started life as a 16x10 pixel sprite (see script.js). Here every sprite pixel becomes a
// little cube (a "voxel"), and the flat picture gets some depth, so the side view still looks
// exactly like the sprite. The model is split into rig parts (head, legs, tail...) that the
// animator can rotate. Each part is ONE mesh, made by a small "mesher" that keeps only the cube
// faces you can actually see and bakes soft shadows into the creases (ambient occlusion).
//
// Units and axes: 1 voxel = 1 unit. Koko faces +X, up is +Y, and the sprite side faces +Z
// (towards a default camera). Koko's right-hand side is +Z, the left-hand side is -Z.

import * as THREE from "three";

// ---------- 1. Koko's design, as text maps ----------
// Same sprite as script.js: one character per pixel, row 0 is the top, Koko faces right.
export const KOKO_SPRITE = [
    "..........GGGGG.",
    ".........GLLLLLG",
    ".........GLWKLLG",
    "...GG....GLLLPPG",
    "..GGGG.GGGGGGGG.",
    ".GGLLGGGGLLLLLG.",
    "GGLLLLLLLLLLLG..",
    ".GGGDGGGGGGDGG..",
    "..GG.G....GG.G..",
    "..GG.GG...GG.GG."
];

export const KOKO_COLOURS = {
    G: "#43b047",   // body green
    L: "#8be28b",   // light belly / face
    D: "#2e8b3a",   // dark spots
    W: "#ffffff",   // eye white
    K: "#2b2b3a",   // pupil
    P: "#ff8fab"    // cheek blush
};

// Colours that only exist in 3D.
const EXTRA_COLOURS = {
    tongue: "#ff5d8f",
    mouth: "#2e8b3a",
    bowMain: "#ff6fa3",
    bowShade: "#d94680",
    bowLight: "#ffc1d8",
    cloudTop: "#ffffff",
    cloudBelly: "#e3e8f2",
    drop: "#5aa9ff"
};

// Which rig part owns each sprite pixel: h = head, b = body, 0 / 1 / 2 = tail segments t0 / t1 / t2.
// The tail is the sprite's raised curl: it leaves the back, arches up over the hips and hooks
// down behind them. Legs: F = front-right, f = front-left, R = rear-right, r = rear-left.
// UPPERCASE = Koko's right side (+Z, near the camera), lowercase = left side (-Z).
// The sprite draws the near legs on the outside and the far legs tucked in between, so the
// diagonal pairs (front-right + rear-left, front-left + rear-right) look like a mid-step trot.
const PART_MAP = [
    "..........hhhhh.",
    ".........hhhhhhh",
    ".........hhhhhhh",
    "...00....hhhhhhh",
    "..1000.bbhhhhhh.",
    ".11bbbbbbbbbbbb.",
    "22bbbbbbbbbbbb..",
    ".2bbbbbbbbbbbb..",
    "..RR.r....ff.F..",
    "..RR.rr...ff.FF."
];

// How thick Koko is at each pixel. The digit is the "half depth" h: the pixel is pushed out
// into a row of 2h + 1 voxels, from z = -h to z = +h (0 = 1 voxel, 1 = 3 voxels, 2 = 5 voxels).
// Edges are thinner than the middle, which rounds Koko off like a vinyl toy.
// ("t" = tail pixel: the tail's thickness comes from TAIL below.)
const DEPTH_MAP = [
    "..........12221.",
    ".........2333332",
    ".........2333332",
    "...tt....2333332",
    "..tttt.12222222.",
    ".tt222222222222.",
    "tt122222222222..",
    ".t122222222222..",
    "................",
    "................"
];

// A few dark spots on top of the back, as [sprite x, sprite row, z]. Only "inside" voxels
// (not the side shell) are used, so the side view stays identical to the sprite.
const BACK_SPOTS = [[7, 4, 0], [12, 0, 0]];

// ---------- 2. Where things are (pivots) ----------
// A voxel in the "main grid" at cell (x, y, z) fills the unit box that starts at
// MAIN_ORIGIN + (x, y, z). Sprite column x is grid x, sprite row r is grid y = 9 - r,
// so the feet (row 9) sit on y = 0 and Koko's middle is at x = 0.
const MAIN_ORIGIN = new THREE.Vector3(-8, 0, -0.5);

// A pivot is the point a part turns around (like a joint). Each rig Group is placed at its
// pivot, and its mesh is stored relative to that point, so rotating the Group bends the joint.
// All positions below are in Koko's root space (the space of koko.root).
const PIVOTS = {
    body: new THREE.Vector3(0, 4, 0),       // middle of the torso
    head: new THREE.Vector3(2.5, 5, 0),     // the neck: back-bottom of the head
    mouth: new THREE.Vector3(7.7, 6.5, 0)   // just inside the front of the snout
};

const EYE = {
    // The eye white covers sprite columns 11-12, rows 1-2 (the sprite's W K pixel grown to 2x2).
    whiteMin: new THREE.Vector2(3, 7),      // root-space x/y of the white's lower-back corner
    whiteSize: 2,
    pupilRest: new THREE.Vector2(4.25, 7.85), // pupil centre at rest: a little forward and low
    surfaceZ: Number(DEPTH_MAP[2][11]) + 0.5, // the side of the head, read from the depth map
    bulge: 0.45                             // how far the white stands out from the head
};

// ---------- 3. Small voxel helpers ----------
function keyOf(x, y, z) {
    return x + "," + y + "," + z;
}

function forEachPixel(map, fn) {
    map.forEach((row, r) => {
        [...row].forEach((ch, x) => {
            if (ch !== ".") fn(ch, x, r);
        });
    });
}

function colourOf(code) {
    return KOKO_COLOURS[code] || code;
}

// ---------- 4. The mesher: face culling + baked ambient occlusion ----------
// Input: a Map of voxels { "x,y,z" -> colour }. Output: ONE BufferGeometry for the whole part.
//
// Face culling: a cube has 6 faces. If the neighbouring cell on one side is filled by another
// voxel of the SAME part, that face is buried inside the model and nobody can see it, so we skip
// it. Only the outer skin is kept, which is far fewer triangles.
//
// Ambient occlusion (AO): in real life, inside corners and creases get less light. For each of
// the 4 corners of a face we look at the 3 cells that touch that corner, just in front of the
// face: two "side" cells and one diagonal "corner" cell. The more of them are filled, the darker
// that corner of the face:
//
//     ao = (side1 && side2) ? 0 : 3 - (side1 + side2 + corner)      // 3 = open, 0 = darkest
//
// (This is the classic trick from the "0fps" blog post "Ambient occlusion for Minecraft-like
// worlds" by Mikola Lysenko.) The darkness is baked into the vertex colours, and the GPU blends
// the 4 corner colours across the face, so creases get soft shadows for free, every frame.

const AO_BRIGHTNESS = [0.42, 0.62, 0.82, 1.0];   // brightness for ao = 0, 1, 2, 3

// The 6 face directions. For each face we store its 4 corners (0/1 offsets inside the voxel) in
// counter-clockwise order as seen from outside: that is how three.js knows which side is the
// front. du / dv say which way to step (along the face) to find the cells around each corner.
const FACES = makeFaceTable();

function makeFaceTable() {
    const faces = [];
    for (let axis = 0; axis < 3; axis++) {
        const u = (axis + 1) % 3;           // the two directions lying flat on the face
        const v = (axis + 2) % 3;
        for (const sign of [1, -1]) {
            const normal = [0, 0, 0];
            normal[axis] = sign;
            const order = sign > 0
                ? [[0, 0], [1, 0], [1, 1], [0, 1]]
                : [[0, 0], [0, 1], [1, 1], [1, 0]];
            const corners = order.map(([cu, cv]) => {
                const p = [0, 0, 0];
                p[axis] = sign > 0 ? 1 : 0;
                p[u] = cu;
                p[v] = cv;
                const du = [0, 0, 0];
                const dv = [0, 0, 0];
                du[u] = cu ? 1 : -1;
                dv[v] = cv ? 1 : -1;
                return { p, du, dv };
            });
            faces.push({ normal, corners });
        }
    }
    return faces;
}

function cornerAO(isSolid, n, corner) {
    const side1 = isSolid(n[0] + corner.du[0], n[1] + corner.du[1], n[2] + corner.du[2]) ? 1 : 0;
    const side2 = isSolid(n[0] + corner.dv[0], n[1] + corner.dv[1], n[2] + corner.dv[2]) ? 1 : 0;
    const diag = isSolid(
        n[0] + corner.du[0] + corner.dv[0],
        n[1] + corner.du[1] + corner.dv[1],
        n[2] + corner.du[2] + corner.dv[2]
    ) ? 1 : 0;
    if (side1 && side2) return 0;
    return 3 - (side1 + side2 + diag);
}

// voxels: Map "x,y,z" -> colour. offset: added to every vertex (grid origin minus pivot).
// isSolid(x, y, z): which cells count as "filled" for AO (can include touching parts).
function meshVoxels(voxels, offset, isSolid) {
    const solid = isSolid || ((x, y, z) => voxels.has(keyOf(x, y, z)));
    const positions = [];
    const normals = [];
    const colours = [];
    const indices = [];
    const colour = new THREE.Color();

    for (const [key, hex] of voxels) {
        const [x, y, z] = key.split(",").map(Number);
        colour.set(colourOf(hex));          // three converts the sRGB hex to linear for us
        for (const face of FACES) {
            const [nx, ny, nz] = face.normal;
            if (voxels.has(keyOf(x + nx, y + ny, z + nz))) continue;   // buried face: skip
            const n = [x + nx, y + ny, z + nz];                         // the cell in front
            const first = positions.length / 3;
            const ao = face.corners.map((corner) => {
                const level = cornerAO(solid, n, corner);
                const b = AO_BRIGHTNESS[level];
                positions.push(offset.x + x + corner.p[0], offset.y + y + corner.p[1], offset.z + z + corner.p[2]);
                normals.push(nx, ny, nz);
                colours.push(colour.r * b, colour.g * b, colour.b * b);
                return level;
            });
            // Split the square into 2 triangles along the brighter diagonal. Otherwise one dark
            // corner would smear a dark streak across the middle of the face.
            if (ao[0] + ao[2] >= ao[1] + ao[3]) {
                indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
            } else {
                indices.push(first + 1, first + 2, first + 3, first + 1, first + 3, first);
            }
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colours, 3));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    return geometry;
}

// Plain coloured boxes merged into one geometry, for the small parts that are not on the voxel
// grid (eye whites, pupils, lids). boxes: [{ min: [x, y, z], max: [x, y, z], colour }].
function boxesGeometry(boxes) {
    const positions = [];
    const normals = [];
    const colours = [];
    const indices = [];
    const colour = new THREE.Color();
    for (const box of boxes) {
        colour.set(colourOf(box.colour));
        for (const face of FACES) {
            const first = positions.length / 3;
            for (const corner of face.corners) {
                for (let a = 0; a < 3; a++) {
                    positions.push(box.min[a] + corner.p[a] * (box.max[a] - box.min[a]));
                }
                normals.push(...face.normal);
                colours.push(colour.r, colour.g, colour.b);
            }
            indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colours, 3));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    return geometry;
}

// A box centred on (cx, cy, cz) with size (sx, sy, sz), in the format boxesGeometry wants.
function centredBox(cx, cy, cz, sx, sy, sz, colour) {
    return {
        min: [cx - sx / 2, cy - sy / 2, cz - sz / 2],
        max: [cx + sx / 2, cy + sy / 2, cz + sz / 2],
        colour
    };
}

// ---------- 5. Body and head voxels (extruding the sprite) ----------
// The side shell (z = -h and z = +h) shows the sprite exactly, on both sides. The voxels in
// between are only seen from the top, bottom and front, so they get "3D only" colours:
// a pale belly underneath, a pale throat, a mouth, and a few dark spots on the back.
function isBodyPixel(x, row) {
    return row >= 0 && row < 10 && x >= 0 && x < 16 && PART_MAP[row][x] === "b";
}

function innerColour(part, x, row, z) {
    const ch = KOKO_SPRITE[row][x];
    if (BACK_SPOTS.some(([sx, sr, sz]) => sx === x && sr === row && sz === z)) return "D";
    if (part === "h" && x === 15 && row === 3 && Math.abs(z) <= 1) return EXTRA_COLOURS.mouth;
    if (ch === "W" || ch === "K" || ch === "P") return "L";       // eyes/blush only on the sides
    if (part === "b") {
        const isUnderside = !isBodyPixel(x, row + 1);
        const isChestFront = row >= 5 && !isBodyPixel(x + 1, row);
        if (isUnderside || isChestFront) return "L";
    }
    return ch;
}

function shellColour(part, x, row) {
    const ch = KOKO_SPRITE[row][x];
    if (ch === "W" || ch === "K") return "L";                    // the eye Groups sit on top
    return ch;
}

function buildTorsoVoxels(partLetter) {
    const voxels = new Map();
    forEachPixel(PART_MAP, (part, x, row) => {
        if (part !== partLetter) return;
        const h = Number(DEPTH_MAP[row][x]);
        for (let z = -h; z <= h; z++) {
            const outer = Math.abs(z) === h;
            const colour = outer ? shellColour(part, x, row) : innerColour(part, x, row, z);
            voxels.set(keyOf(x, 9 - row, z), colour);
        }
    });
    return voxels;
}

// ---------- 6. Legs ----------
// Geckos stand with their legs splayed out sideways. Each leg sits just outside the body
// (z = ±3): a shoulder voxel against the body, the leg pixels from the sprite below it,
// and a little toe sticking out sideways at the front of the foot.
const LEG_NAMES = { F: "fr", f: "fl", R: "br", r: "bl" };

function buildLegVoxels() {
    const legs = {};
    forEachPixel(PART_MAP, (letter, x, row) => {
        const name = LEG_NAMES[letter];
        if (!name) return;
        if (!legs[name]) legs[name] = { side: letter === letter.toUpperCase() ? 1 : -1, pixels: [] };
        legs[name].pixels.push([x, row]);
    });

    for (const leg of Object.values(legs)) {
        const z = 3 * leg.side;
        const out = leg.side;                     // one step further away from the body
        const topRow = Math.min(...leg.pixels.map(([, r]) => r));
        const shoulderXs = leg.pixels.filter(([, r]) => r === topRow).map(([x]) => x);
        const footXs = leg.pixels.filter(([, r]) => r === 9).map(([x]) => x);
        leg.voxels = new Map();
        // shoulder: one voxel pressed against the body's side, one row above the leg
        shoulderXs.forEach((x) => leg.voxels.set(keyOf(x, 9 - 7, z), "G"));
        // the leg itself is 2 voxels thick (z and z + out), so it looks chunky from the front
        leg.pixels.forEach(([x, row]) => {
            leg.voxels.set(keyOf(x, 9 - row, z), "G");
            leg.voxels.set(keyOf(x, 9 - row, z + out), "G");
        });
        // a little toe poking out sideways at the front of the foot
        leg.voxels.set(keyOf(Math.max(...footXs), 0, z + 2 * out), "G");
        // pivot: centre of the shoulder voxel(s)
        const minX = Math.min(...shoulderXs);
        const maxX = Math.max(...shoulderXs);
        leg.pivot = new THREE.Vector3((minX + maxX + 1) / 2 + MAIN_ORIGIN.x, 2.5, z);
    }
    return legs;
}

// ---------- 7. Tail ----------
// Three segments (0, 1, 2 in PART_MAP), each thinner than the last: 3, then 2, then 1 voxel
// deep, with dark bands on top like a leopard gecko. Each one is a child of the one before, so the animator can sway (rotation.y) and curl
// (rotation.z) them like a chain. Each pivot is the joint with the previous piece.
const TAIL = [
    { depth: 3, pivot: new THREE.Vector3(-2.5, 5.5, 0), spots: [[3, 3], [5, 4]] }, // t0: root, banded
    { depth: 2, pivot: new THREE.Vector3(-5, 5.5, 0), spots: [] },         // t1: the arch
    { depth: 1, pivot: new THREE.Vector3(-6.5, 4, 0), spots: [] }          // t2: the hooked tip
];

function isTailPixel(x, row) {
    return row >= 0 && row < 10 && x >= 0 && x < 16 && "012".includes(PART_MAP[row][x]);
}

// Voxels of one tail segment. z runs 0 .. depth-1; the segment's grid is centred on z = 0.
function buildTailSegmentVoxels(index) {
    const { depth, spots } = TAIL[index];
    const voxels = new Map();
    forEachPixel(PART_MAP, (part, x, row) => {
        if (part !== String(index)) return;
        for (let z = 0; z < depth; z++) {
            const outer = z === 0 || z === depth - 1;
            let colour = KOKO_SPRITE[row][x];
            if (!outer && spots.some(([sx, sr]) => sx === x && sr === row)) colour = "D";
            else if (!outer && !isTailPixel(x, row + 1) && !isBodyPixel(x, row + 1)) colour = "L";
            voxels.set(keyOf(x, 9 - row, z), colour);
        }
    });
    return voxels;
}

// ---------- 8. The bow ----------
// Drawn like the sprite: a little front view of the bow, top row first.
// M = main pink, S = shade, H = highlight, K = knot, T = ribbon tail.
// Voxels left of the knot column belong to one loop, right of it to the other loop (a ribbon
// tail belongs to the loop above it, so they flutter together and never come apart).
// The bow is then turned to face the three-quarter camera and tilted, and that turn is baked
// into the geometry, so every bow Group still rests at rotation 0 for the animator.
const BOW_STYLES = {
    round: {
        map: [
            "HM.MH",
            "MSKSM",
            ".TKT."
        ],
        yaw: 30,        // degrees: turn the bow's face towards the 3/4 front camera
        roll: -10       // degrees: a cheeky tilt
    },
    ribbon: {
        // flat and angular: wide wings that rise to sharp tips, ribbon tails under them
        map: [
            "HM...MH",
            "MMSKSMM",
            ".T.K.T."
        ],
        yaw: 26,
        roll: -8
    }
};

const BOW_COLOURS = {
    M: EXTRA_COLOURS.bowMain,
    S: EXTRA_COLOURS.bowShade,
    H: EXTRA_COLOURS.bowLight,
    K: EXTRA_COLOURS.bowShade,
    T: EXTRA_COLOURS.bowMain
};

// Where the knot sits, in root space: on top of the head, just above and behind the eye,
// leaning towards Koko's right side (+Z, the camera side). Sunk a little so it touches.
const BOW_SEAT = new THREE.Vector3(3.6, 9.8, 1.4);

function buildBowVoxels(style) {
    const rows = style.map;
    const half = (rows[0].length - 1) / 2;
    const knot = new Map();
    const loopL = new Map();
    const loopR = new Map();
    const all = new Map();
    let knotTop = 0;
    rows.forEach((row, r) => {
        const y = rows.length - 1 - r;
        [...row].forEach((ch, c) => {
            if (ch === ".") return;
            const x = c - half;
            const key = keyOf(x, y, 0);
            const hex = BOW_COLOURS[ch];
            all.set(key, hex);
            if (ch === "K") knot.set(key, hex);
            else if (x > 0) loopL.set(key, hex);      // +x in bow space = front loop (Koko's left)
            else loopR.set(key, hex);                 // -x in bow space = back loop (Koko's right)
            if (ch === "K") knotTop = Math.max(knotTop, y + 1);
        });
    });
    return { knot, loopL, loopR, all, knotCentreY: knotTop / 2 };
}

// ---------- 9. The rain-cloud sidekick ----------
// Three overlapping balls of voxels, cut flat underneath: white on top, soft grey-blue below.
// Ball centres are measured from the bottom of the cloud.
const CLOUD_BALLS = [
    { x: -2.5, y: 1.1, z: 0, r: 1.6 },
    { x: 0.0, y: 1.6, z: 0, r: 2.1 },
    { x: 2.4, y: 1.0, z: 0, r: 1.5 }
];

const CLOUD_DROPS = [
    new THREE.Vector3(-2.2, -1.4, 0.6),
    new THREE.Vector3(0.4, -2.6, -0.4),
    new THREE.Vector3(2.4, -1.2, 0.3)
];

function buildCloudVoxels() {
    const voxels = new Map();
    for (let x = -6; x <= 6; x++) {
        for (let y = 0; y <= 5; y++) {
            for (let z = -4; z <= 4; z++) {
                const inside = CLOUD_BALLS.some((b) =>
                    (x - b.x) ** 2 + (y + 0.5 - b.y) ** 2 + (z - b.z) ** 2 <= b.r * b.r);
                if (inside) voxels.set(keyOf(x, y, z), y === 0 ? EXTRA_COLOURS.cloudBelly : EXTRA_COLOURS.cloudTop);
            }
        }
    }
    return voxels;
}

// ---------- 10. Assembling the rig ----------
function makeMaterials() {
    return {
        // One shared material for (almost) everything: the colours live in the vertices.
        body: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 }),
        // Eyes and rain drops are a bit glossier, so they catch a highlight.
        gloss: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.18, metalness: 0 }),
        cloud: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 })
    };
}

// A rig part = a Group placed at its pivot (relative to its parent's pivot) holding one mesh.
function makePart(name, pivot, parentPivot, geometry, material) {
    const group = new THREE.Group();
    group.name = name;
    group.position.copy(pivot).sub(parentPivot);
    if (geometry) addMesh(group, name, geometry, material);
    return group;
}

function addMesh(parent, name, geometry, material) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name + "-mesh";
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
}

// Offset that moves main-grid cells into a part's local space (relative to its pivot).
function mainGridOffset(pivot) {
    return MAIN_ORIGIN.clone().sub(pivot);
}

function buildBodyAndHead(materials, bodyVoxels, headVoxels, isSolidMain) {
    const body = makePart("body", PIVOTS.body, new THREE.Vector3(),
        meshVoxels(bodyVoxels, mainGridOffset(PIVOTS.body), isSolidMain), materials.body);
    const head = makePart("head", PIVOTS.head, PIVOTS.body,
        meshVoxels(headVoxels, mainGridOffset(PIVOTS.head), isSolidMain), materials.body);
    body.add(head);
    return { body, head };
}

function buildEye(side, materials) {
    // The eye Group sits on the side of the head at the pupil's rest spot. Its local x/y are
    // the same as the head's on BOTH sides, so pupil.position.x > 0 always looks forward.
    const eye = new THREE.Group();
    eye.name = side > 0 ? "eye-r" : "eye-l";
    eye.position.set(EYE.pupilRest.x, EYE.pupilRest.y, EYE.surfaceZ * side).sub(PIVOTS.head);

    // the white: a 2x2 voxel block, mostly sunk into the head, standing out by EYE.bulge
    const s = EYE.whiteSize;
    const whiteCentre = [EYE.whiteMin.x + s / 2 - EYE.pupilRest.x, EYE.whiteMin.y + s / 2 - EYE.pupilRest.y];
    addMesh(eye, eye.name + "-white",
        boxesGeometry([centredBox(whiteCentre[0], whiteCentre[1], side * (EYE.bulge - 0.5), s, s, 1, "W")]),
        materials.gloss);

    // the pupil: one dark voxel just in front of the white, with a tiny catch-light in its
    // upper front corner (the reflection of the key light that makes eyes look alive)
    const front = EYE.bulge + 0.12;
    const pupil = new THREE.Mesh(boxesGeometry([
        centredBox(0, 0, side * (front - 0.2), 1, 1, 0.4, "K"),
        centredBox(0.2, 0.2, side * (front + 0.01), 0.34, 0.34, 0.04, "W")
    ]), materials.gloss);
    pupil.name = eye.name + "-pupil";
    pupil.castShadow = true;
    eye.add(pupil);
    eye.userData.pupil = pupil;
    return eye;
}

function buildLid(side, materials) {
    // Pivot along the top edge of the eye: scaling y from ~0 to 1 pulls the lid down.
    const s = EYE.whiteSize + 0.2;
    const outer = EYE.bulge + 0.22;               // reaches just past the pupil
    const lid = new THREE.Group();
    lid.name = side > 0 ? "lid-r" : "lid-l";
    lid.position.set(EYE.whiteMin.x + EYE.whiteSize / 2, EYE.whiteMin.y + EYE.whiteSize + 0.1,
        EYE.surfaceZ * side).sub(PIVOTS.head);
    addMesh(lid, lid.name,
        boxesGeometry([centredBox(0, -s / 2, side * (outer - 0.05) / 2, s, s, outer + 0.05, "G")]),
        materials.body);
    hideByScale(lid, "y");
    return lid;
}

function hideByScale(group, axis) {
    group.scale[axis] = 0.001;
    group.visible = false;
}

function buildTongue(materials) {
    const voxels = new Map();
    for (let x = 0; x < 4; x++) voxels.set(keyOf(x, 0, 0), EXTRA_COLOURS.tongue);
    const tongue = makePart("tongue", PIVOTS.mouth, PIVOTS.head,
        meshVoxels(voxels, new THREE.Vector3(0, -0.5, -0.5)), materials.body);
    hideByScale(tongue, "x");
    return tongue;
}

function buildLegs(materials, legData, isSolidMain) {
    const legs = {};
    for (const [name, leg] of Object.entries(legData)) {
        legs[name] = makePart("leg-" + name, leg.pivot, PIVOTS.body,
            meshVoxels(leg.voxels, mainGridOffset(leg.pivot), isSolidMain), materials.body);
    }
    return legs;
}

function buildTail(materials, voxelSets) {
    const chain = [];
    TAIL.forEach((segment, i) => {
        const voxels = buildTailSegmentVoxels(i);
        voxelSets.push(voxels);
        const gridOrigin = new THREE.Vector3(MAIN_ORIGIN.x, MAIN_ORIGIN.y, -segment.depth / 2);
        const parentPivot = i === 0 ? PIVOTS.body : TAIL[i - 1].pivot;
        const part = makePart("tail-" + i, segment.pivot, parentPivot,
            meshVoxels(voxels, gridOrigin.sub(segment.pivot)), materials.body);
        if (i > 0) chain[i - 1].add(part);
        chain.push(part);
    });
    return chain;
}

function buildBow(styleName, materials, voxelSets) {
    const style = BOW_STYLES[styleName] || BOW_STYLES.round;
    const bowVoxels = buildBowVoxels(style);
    voxelSets.push(bowVoxels.all);
    const isSolidBow = (x, y, z) => bowVoxels.all.has(keyOf(x, y, z));
    const turn = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(
        0, THREE.MathUtils.degToRad(style.yaw), THREE.MathUtils.degToRad(style.roll), "YXZ"));

    // bow Group: pivot at the knot base. The knot is its own mesh; the loops hang off it.
    const gridOrigin = new THREE.Vector3(-0.5, 0, -0.5);
    const knotGeometry = meshVoxels(bowVoxels.knot, gridOrigin, isSolidBow).applyMatrix4(turn);
    const bow = makePart("bow", BOW_SEAT, PIVOTS.head, knotGeometry, materials.body);

    // the loops: pivot at the middle of the knot, so they can flutter around it
    const knotCentre = new THREE.Vector3(0, bowVoxels.knotCentreY, 0);
    const knotCentreTurned = knotCentre.clone().applyMatrix4(turn);
    const loops = {};
    for (const [name, voxels] of [["l", bowVoxels.loopL], ["r", bowVoxels.loopR]]) {
        const geometry = meshVoxels(voxels, gridOrigin.clone().sub(knotCentre), isSolidBow).applyMatrix4(turn);
        const loop = makePart("bow-loop-" + name, knotCentreTurned, new THREE.Vector3(), geometry, materials.body);
        bow.add(loop);
        loops[name] = loop;
    }
    return { bow, loops };
}

function buildCloud(materials, voxelSets) {
    const voxels = buildCloudVoxels();
    voxelSets.push(voxels);
    const root = new THREE.Group();
    root.name = "cloud";
    const puff = makePart("cloud-puff", new THREE.Vector3(), new THREE.Vector3(),
        meshVoxels(voxels, new THREE.Vector3(-0.5, -1.5, -0.5)), materials.cloud);
    root.add(puff);
    const dropGeometry = meshVoxels(new Map([[keyOf(0, 0, 0), EXTRA_COLOURS.drop]]),
        new THREE.Vector3(-0.5, -0.5, -0.5));
    const drops = CLOUD_DROPS.map((p, i) => {
        const drop = makePart("drop-" + i, p, new THREE.Vector3(), dropGeometry, materials.gloss);
        root.add(drop);
        return drop;
    });
    return { root, puff, drops };
}

// ---------- 11. Counting (for the "KOKO 1234 TRIS" label) ----------
function countStats(objects, voxelSets) {
    let triangles = 0;
    let meshes = 0;
    for (const object of objects) {
        object.traverse((child) => {
            if (!child.isMesh) return;
            meshes += 1;
            const g = child.geometry;
            triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
        });
    }
    const voxels = voxelSets.reduce((sum, set) => sum + set.size, 0);
    return { voxels, triangles, meshes };
}

function disposeAll(objects, materials) {
    for (const object of objects) {
        object.traverse((child) => {
            if (child.isMesh) child.geometry.dispose();
        });
    }
    Object.values(materials).forEach((m) => m.dispose());
}

// ---------- 12. buildKoko(): the public entry point ----------
export function buildKoko({ bow = "round", withCloud = true } = {}) {
    const materials = makeMaterials();
    const voxelSets = [];
    const legData = buildLegVoxels();

    // Every voxel on the main grid counts as "filled" for AO, even across parts, so the creases
    // where the head meets the body or a leg meets the belly get soft shadows too.
    const bodyVoxels = buildTorsoVoxels("b");
    const headVoxels = buildTorsoVoxels("h");
    voxelSets.push(bodyVoxels, headVoxels);
    const mainCells = new Set();
    for (const set of [bodyVoxels, headVoxels, ...Object.values(legData).map((l) => l.voxels)]) {
        for (const key of set.keys()) mainCells.add(key);
    }
    const isSolidMain = (x, y, z) => mainCells.has(keyOf(x, y, z));

    const root = new THREE.Group();
    root.name = "koko";
    const { body, head } = buildBodyAndHead(materials, bodyVoxels, headVoxels, isSolidMain);
    root.add(body);

    const eyes = { l: buildEye(-1, materials), r: buildEye(1, materials) };
    const lids = { l: buildLid(-1, materials), r: buildLid(1, materials) };
    const tongue = buildTongue(materials);
    head.add(eyes.l, eyes.r, lids.l, lids.r, tongue);

    const legs = buildLegs(materials, legData, isSolidMain);
    Object.values(legData).forEach((l) => voxelSets.push(l.voxels));
    body.add(legs.fl, legs.fr, legs.bl, legs.br);

    const tail = buildTail(materials, voxelSets);
    body.add(tail[0]);

    const bowParts = buildBow(bow, materials, voxelSets);
    head.add(bowParts.bow);

    const kokoVoxelSets = voxelSets.slice();
    const cloud = withCloud ? buildCloud(materials, voxelSets) : null;

    // Anchors: handy points in root space (rest pose) for the animator and the scenes.
    root.updateMatrixWorld(true);
    const bowBox = new THREE.Box3().setFromObject(bowParts.bow);
    const anchors = {
        mouth: PIVOTS.mouth.clone(),
        headTop: new THREE.Vector3(4.5, 10, 0),
        bowTop: new THREE.Vector3((bowBox.min.x + bowBox.max.x) / 2, bowBox.max.y, (bowBox.min.z + bowBox.max.z) / 2),
        cloudHome: new THREE.Vector3(0.5, 17, -1.5)
    };
    if (cloud) cloud.root.position.copy(anchors.cloudHome);

    const box = new THREE.Box3().setFromObject(root);
    const size = {
        length: Math.round(box.max.x - box.min.x),
        height: Math.round(box.max.y - box.min.y),
        depth: Math.round(box.max.z - box.min.z)
    };

    const stats = countStats([root], kokoVoxelSets);
    if (cloud) {
        const cloudStats = countStats([cloud.root], voxelSets.slice(kokoVoxelSets.length));
        stats.cloud = cloudStats;
    }

    return {
        root,
        rig: {
            body,
            head,
            eyes,
            lids,
            tongue,
            tail,
            legs,
            bow: bowParts.bow,
            bowLoops: bowParts.loops
        },
        cloud,
        anchors,
        size,
        stats,
        dispose() {
            disposeAll(cloud ? [root, cloud.root] : [root], materials);
        }
    };
}
