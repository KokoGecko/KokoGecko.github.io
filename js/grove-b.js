// =========================================================
//  grove-b.js  -  Concept B "Monsoon": Koko's floating lantern island
//
//  A small voxel island floats in a pink studio. Blossom trees with flat,
//  layered pads (niwaki style), a stone lantern with an amber glow, a stream
//  that pours off the edge, and one big leaf Koko can shelter under.
//  setWeather(1) rolls a slate storm cloud in with rain; setWeather(0)
//  brings the sun back.
//
//  Everything is built in code (no image files). 1 world unit = 1 voxel,
//  the same size as one of Koko's voxels, so Koko and the island share a grid.
//
//  Public API (shared with grove-a.js):
//      createGrove({ renderer, reducedMotion, quality }) -> {
//          scene, camera, kokoSpot, walkPath, homeU,
//          update(dt, elapsed, input), resize(width, height, layout),
//          setReducedMotion(bool), burstPetals(worldPoint), setWeather(t),
//          props, stats()
//      }
// =========================================================

import * as THREE from "three";

// ---------- 1. Palette B (the only colours this scene uses) ----------
// Every colour below is a palette token or a small step between two tokens,
// so the scene stays calm: pinks lead, greens/stone support, amber + water accent.
const PALETTE = {
    blossom: "#ee7fa0",
    blossomShade: "#c9567a",
    blossomLight: "#ffc2d3",
    rose: "#b03a5e",
    slate: "#2e5560",
    leaf: "#43b047",
    grass: "#6dbb57",
    grassLight: "#82c869",
    grassDark: "#55a449",
    grassSoft: "#7fc46b",      // grass with a little mist mixed in: lets Koko's green pop
    leafDark: "#46913f",
    soil: "#8a5a44",
    soilDark: "#5e3b2e",
    stone: "#b9b2ad",
    stoneLight: "#d3cdc8",
    stoneDark: "#a19893",
    water: "#7cc3d6",
    waterLight: "#a9dbe8",
    foam: "#e4f4f8",
    lantern: "#ffb547",
    gold: "#ffc53d",
    white: "#fff8f5",
    cloudTop: "#8fa8b0",
    cloudMid: "#5f7f88"
};

// Make a THREE.Color from a hex token. three.js converts it to "linear" light
// values for us, which is what lighting maths needs.
function colour(hex) {
    return new THREE.Color(hex);
}

// Blend two palette tokens: t = 0 gives a, t = 1 gives b.
function blend(hexA, hexB, t) {
    return colour(hexA).lerp(colour(hexB), t);
}

// A tiny seeded random number generator ("mulberry32").
// Math.random() would give a different island on every visit; a seed makes
// the island identical every time, so screenshots and the owner's memory match.
function makeRandom(seed) {
    let a = seed >>> 0;
    return function random() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}

// smoothstep: an S-shaped 0..1 curve, so changes start and end gently.
function smooth01(v) {
    const t = clamp01(v);
    return t * t * (3 - 2 * t);
}

// Move `current` towards `target` by at most `step` (a constant-speed approach).
function approach(current, target, step) {
    if (current < target) return Math.min(target, current + step);
    return Math.max(target, current - step);
}

// Frame-rate independent smoothing: the same feel at 30 or 120 fps.
function damp(current, target, sharpness, dt) {
    return current + (target - current) * (1 - Math.exp(-sharpness * dt));
}

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;


// ---------- 2. Geometry builder: collect coloured quads, output one mesh ----------
// Drawing one big mesh is far cheaper for the GPU than drawing hundreds of small
// ones (each separate mesh is one "draw call"). So the island, its rocks,
// the lantern and the tree trunks all go into ONE builder and become ONE mesh.

// The six faces of a cube. For each face: its outward normal, and two edge
// directions u and v (with u x v = normal) so the corners come out
// counter-clockwise when seen from outside (that is the side the GPU draws).
const FACES = [
    { normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },   // +X (right)
    { normal: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },  // -X (left)
    { normal: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] },   // +Y (top)
    { normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },  // -Y (bottom)
    { normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },   // +Z (front)
    { normal: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0] }   // -Z (back)
];
const TOP_FACE = 2;
const BOTTOM_FACE = 3;

// The 4 corner offsets of a face on the unit cube, as (u, v) steps.
const CORNER_STEPS = [[0, 0], [1, 0], [1, 1], [0, 1]];

class GeometryBuilder {
    constructor() {
        this.positions = [];
        this.normals = [];
        this.colors = [];
        this.indices = [];
    }

    get vertexCount() {
        return this.positions.length / 3;
    }

    // corners: four [x, y, z] points, counter-clockwise from outside.
    // shades: four brightness multipliers (1 = full colour) for baked shadow.
    addQuad(corners, normal, col, shades = [1, 1, 1, 1]) {
        const start = this.vertexCount;
        for (let i = 0; i < 4; i++) {
            const p = corners[i];
            this.positions.push(p[0], p[1], p[2]);
            this.normals.push(normal[0], normal[1], normal[2]);
            this.colors.push(col.r * shades[i], col.g * shades[i], col.b * shades[i]);
        }
        // A quad is two triangles. Cutting it along the diagonal that joins the
        // two most similar corners keeps ambient-occlusion gradients smooth.
        if (shades[0] + shades[2] < shades[1] + shades[3]) {
            this.indices.push(start + 1, start + 2, start + 3, start + 1, start + 3, start);
        } else {
            this.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
        }
    }

    // An axis-aligned box from min to max (any size, for props like the lantern).
    // bottomShade darkens the lower corners a little: a cheap "contact shadow".
    addBox(min, max, col, { bottomShade = 0.8, skipBottom = true } = {}) {
        const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
        FACES.forEach((face, f) => {
            if (skipBottom && f === BOTTOM_FACE) return;   // the camera never sees under props
            const corners = [];
            const shades = [];
            for (const [su, sv] of CORNER_STEPS) {
                const unit = [0, 1, 2].map((a) =>
                    (face.normal[a] > 0 ? 1 : 0) + face.u[a] * su + face.v[a] * sv);
                corners.push([0, 1, 2].map((a) => min[a] + unit[a] * size[a]));
                shades.push(unit[1] === 0 ? bottomShade : 1);
            }
            this.addQuad(corners, face.normal, col, shades);
        });
    }

    build() {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
        geometry.setAttribute("normal", new THREE.Float32BufferAttribute(this.normals, 3));
        geometry.setAttribute("color", new THREE.Float32BufferAttribute(this.colors, 3));
        geometry.setIndex(this.indices);
        geometry.computeBoundingSphere();
        return geometry;
    }
}


// ---------- 3. Voxel grid + mesher (face culling + baked ambient occlusion) ----------
// A voxel grid is a 3D map of filled unit cubes. To turn it into a mesh we only
// emit the faces that touch empty space ("face culling"): faces between two
// filled cubes can never be seen, so we skip them. That removes most triangles.
//
// Ambient occlusion (AO) is the soft darkening in creases and corners. For each
// corner of a visible face we look at the 3 cubes touching that corner on the
// outside; the more of them are filled, the darker the corner. The GPU then
// blends between corners, which gives soft studio-like shadows for free.
const AO_SHADES = [0.52, 0.7, 0.86, 1];

class VoxelGrid {
    constructor() {
        this.cells = new Map();
    }

    static key(x, y, z) {
        return ((x + 256) * 512 + (y + 256)) * 512 + (z + 256);
    }

    set(x, y, z, col) {
        this.cells.set(VoxelGrid.key(x, y, z), { x, y, z, col });
    }

    has(x, y, z) {
        return this.cells.has(VoxelGrid.key(x, y, z));
    }

    // extraShade(cell, faceIndex, cornerX, cornerZ) lets the caller add baked
    // shade on top (used for soft shadows under the trees).
    meshInto(builder, extraShade = null) {
        for (const cell of this.cells.values()) {
            FACES.forEach((face, f) => {
                const n = face.normal;
                const ox = cell.x + n[0];
                const oy = cell.y + n[1];
                const oz = cell.z + n[2];
                if (this.has(ox, oy, oz)) return;          // hidden face: skip it

                const corners = [];
                const shades = [];
                for (const [su, sv] of CORNER_STEPS) {
                    const corner = [0, 1, 2].map((a) =>
                        (n[a] > 0 ? 1 : 0) + face.u[a] * su + face.v[a] * sv);
                    const p = [cell.x + corner[0], cell.y + corner[1], cell.z + corner[2]];
                    corners.push(p);

                    // the 3 outside neighbours that touch this corner
                    const du = su ? 1 : -1;
                    const dv = sv ? 1 : -1;
                    const side1 = this.has(ox + face.u[0] * du, oy + face.u[1] * du, oz + face.u[2] * du);
                    const side2 = this.has(ox + face.v[0] * dv, oy + face.v[1] * dv, oz + face.v[2] * dv);
                    const diag = this.has(
                        ox + face.u[0] * du + face.v[0] * dv,
                        oy + face.u[1] * du + face.v[1] * dv,
                        oz + face.u[2] * du + face.v[2] * dv);
                    const level = side1 && side2 ? 0 : 3 - (side1 + side2 + diag);
                    let shade = AO_SHADES[level];
                    if (extraShade) shade *= extraShade(cell, f, p[0], p[2]);
                    shades.push(shade);
                }
                builder.addQuad(corners, n, cell.col, shades);
            });
        }
    }
}


// ---------- 4. Soft round textures drawn on a <canvas> ----------
// Used for contact shadows (dark blob, soft edge) and the lantern glow.
function makeRadialTexture(stops) {
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    stops.forEach(([at, css]) => gradient.addColorStop(at, css));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

// A flat, soft shadow lying on the ground (a horizontal plane).
function makeShadowBlob(texture, tintHex, width, depth) {
    const material = new THREE.MeshBasicMaterial({
        map: texture,
        color: colour(tintHex),
        transparent: true,
        depthWrite: false
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.rotation.x = -Math.PI / 2;               // lie flat
    mesh.scale.set(width, depth, 1);
    mesh.renderOrder = -1;                        // draw before the props on top of it
    return mesh;
}


// ---------- 5. The island layout (all positions in island units) ----------
// Seen from above: trees on a raised back terrace, the big leaf on the left,
// Koko's hero spot front-centre, the stream on the right pouring off the edge.
const ISLAND = {
    radius: 18.5,         // average radius of the irregular outline
    terraceHeight: 2,     // the back terrace is 2 voxels higher
    rimDepth: 4,          // the earth "wall" at the rim: grass + 3 soil voxels
    maxDepth: 21          // how far the rocky underside hangs down at the centre
};

// Slow sine waves around the outline make it irregular but not noisy.
function edgeRadius(angle) {
    return ISLAND.radius
        + 1.3 * Math.sin(3 * angle + 0.6)
        + 0.8 * Math.sin(5 * angle + 2.1)
        + 0.45 * Math.sin(8 * angle + 4.0);
}

// The back terrace: everything behind a wavy line (stepped because it is voxels).
function isTerrace(x, z) {
    return z < -4.5 + 1.6 * Math.sin(x * 0.32 + 0.9);
}

// The stream's centre line, from a spring pool on the terrace to the edge.
const STREAM_POINTS = [
    [3.5, -8.5], [6.5, -6], [9.5, -3.5], [12.5, 0.5], [14.5, 4.5], [16.5, 8.5], [18.5, 12.5], [20.5, 16]
];

// Blossom trees: a twisty trunk (waypoints) and flat pads of blossom.
// Pad y = the bottom layer of the pad. rx / rz = pad radius across x / z.
const TREES = [
    {   // big tree, back left
        trunk: [[-10, 2, -10], [-10, 5, -10], [-9, 8, -9], [-9, 11, -9], [-8, 14, -10], [-8, 18, -10]],
        pads: [
            { x: -12.5, y: 8, z: -8.5, rx: 6.5, rz: 5.2 },
            { x: -4.5, y: 12, z: -10.5, rx: 5.2, rz: 4.4 },
            { x: -9, y: 17, z: -10, rx: 4.2, rz: 3.6 }
        ]
    },
    {   // medium tree, back right
        trunk: [[6, 2, -13], [6, 5, -13], [7, 8, -12], [7, 11, -12], [6, 14, -13]],
        pads: [
            { x: 8.5, y: 8, z: -12, rx: 4.8, rz: 4.0 },
            { x: 3.5, y: 13, z: -12.5, rx: 4.0, rz: 3.4 }
        ]
    }
];

const LANTERN_POS = [13, -5];           // [x, z] right side, by the stream (height is looked up)
const LEAF_STEM_POS = [-16, 7];          // [x, z] the big leaf's stem base, front-left
const LEAF_YAW = Math.PI;                // turn the blade (built along -x) so it reaches along +x
const HERO_POS = [4, 0, 8];              // Koko's hero spot (front, centre)
// The animator walks Koko straight along his own x axis (at most 6 voxels) to shelter,
// so the shelter is 6 voxels behind the hero spot, under the middle of the leaf blade.
const SHELTER_POS = [-2, 0, 8];

const STEPPING_STONES = [
    [11.0, 1.4], [13.3, 2.4], [15.6, 1.6]
];

// Flowers: [x, z]; the ground height is looked up automatically.
const FLOWERS = [
    [-8.5, 13.5], [-4.5, 14.5], [-13.5, 12.5], [12.5, -1.5], [16.5, 0.5], [16.5, -7.5],
    [-0.5, -7.5], [-3.5, -6.5], [11.5, 12.5], [7.5, 14.5], [-15.5, 1.5], [-12.5, -2.5]
];


// ---------- 6. Build the island (one merged, face-culled voxel mesh) ----------
function buildIslandData(random) {
    // 6a. Columns: for each (x, z) cell decide the ground height and how deep the rock hangs.
    const columns = new Map();      // "x,z" -> { x, z, top, bottom, water, waterY }
    const columnKey = (x, z) => x + "," + z;

    for (let x = -24; x < 24; x++) {
        for (let z = -24; z < 24; z++) {
            const cx = x + 0.5;
            const cz = z + 0.5;
            const angle = Math.atan2(cz, cx);
            const edge = edgeRadius(angle);
            const dist = Math.hypot(cx, cz);
            if (dist > edge) continue;

            const q = dist / edge;                           // 0 at centre, 1 at the edge
            let top = isTerrace(cx, cz) ? ISLAND.terraceHeight : 0;
            // a lower ledge around most of the rim gives the "stepped edge"
            const ledge = dist > edge - 1.7 && Math.sin(2 * angle + 1.3) > -0.55;
            if (ledge) top -= 1;

            // the underside: an upside-down stepped cone that tapers to a point.
            // A mostly straight slope keeps every step visible from the camera;
            // the (1 - q)^4 part sharpens the tip.
            const inner = 1 - q;
            const extra = ISLAND.maxDepth - ISLAND.rimDepth;
            const depth = ISLAND.rimDepth + extra * (0.76 * inner + 0.24 * Math.pow(inner, 4)) + (random() - 0.5) * 1.2;
            const bottom = -Math.round(depth);
            columns.set(columnKey(x, z), { x, z, top, bottom, water: false, waterY: 0 });
        }
    }

    // 6b. Carve the stream: cells close to the centre line become water.
    const streamCurve = new THREE.CatmullRomCurve3(
        STREAM_POINTS.map(([x, z]) => new THREE.Vector3(x, 0, z)));
    const samples = streamCurve.getSpacedPoints(240);
    for (const col of columns.values()) {
        const cx = col.x + 0.5;
        const cz = col.z + 0.5;
        let nearest = Infinity;
        let nearestIndex = 0;
        samples.forEach((p, i) => {
            const d = Math.hypot(p.x - cx, p.z - cz);
            if (d < nearest) { nearest = d; nearestIndex = i; }
        });
        // the first few samples form a slightly wider spring pool
        const width = nearestIndex < 20 ? 2.3 : 1.25;
        if (nearest < width) {
            const baseTop = isTerrace(cx, cz) ? ISLAND.terraceHeight : 0;
            col.water = true;
            col.top = baseTop - 1;                 // the stream bed is one voxel lower
            col.waterY = baseTop - 0.3;            // the water surface sits just under the grass
        }
    }

    // where the stream leaves the island: the last sample still over land
    let lip = samples[0];
    let lipIndex = 0;
    for (let i = 0; i < samples.length; i++) {
        const p = samples[i];
        if (!columns.has(columnKey(Math.floor(p.x), Math.floor(p.z)))) break;
        lip = p;
        lipIndex = i;
    }
    const flowDir = samples[Math.min(lipIndex + 1, samples.length - 1)].clone().sub(samples[lipIndex - 1] || samples[0]);
    flowDir.y = 0;
    flowDir.normalize();

    return { columns, columnKey, streamCurve, streamSamples: samples.slice(0, lipIndex + 1), lip, flowDir };
}

// The ground height (top surface) at any point, used for placing props and landing petals.
function groundHeightAt(data, x, z) {
    const col = data.columns.get(data.columnKey(Math.floor(x), Math.floor(z)));
    if (!col) return null;
    return col.water ? col.waterY : col.top;
}

// How strongly the trees, leaf and lantern shade the grass at (x, z): 1 = no shade.
function canopyShade(x, z) {
    let shade = 1;
    for (const tree of TREES) {
        const pad = tree.pads[0];
        const d2 = ((x - pad.x) / (pad.rx * 1.1)) ** 2 + ((z - pad.z) / (pad.rz * 1.1)) ** 2;
        shade *= 1 - 0.32 * Math.exp(-d2 * 1.6);
    }
    // the leaf blade's middle, on the ground: 9 voxels from the stem along the turned blade
    const leafX = LEAF_STEM_POS[0] - 9 * Math.cos(LEAF_YAW);
    const leafZ = LEAF_STEM_POS[1] + 9 * Math.sin(LEAF_YAW);
    const leafD2 = ((x - leafX) / 8) ** 2 + ((z - leafZ) / 5) ** 2;
    shade *= 1 - 0.2 * Math.exp(-leafD2 * 1.8);
    return shade;
}

function buildIsland(data, random, builder) {
    const grid = new VoxelGrid();

    // 6c. Fill each column with layers: grass on top, soil, a dark soil band, then stone.
    for (const col of data.columns.values()) {
        const topCell = col.top - 1;
        for (let y = col.bottom; y <= topCell; y++) {
            let c;
            if (y === topCell && !col.water) {
                c = pickGrassColour(col, random);
            } else if (y >= -4) {
                c = blend(PALETTE.soil, PALETTE.soilDark, random() * 0.18);
            } else if (y === -5) {
                c = blend(PALETTE.soilDark, PALETTE.soil, random() * 0.2);
            } else if (y === -9) {
                c = blend(PALETTE.stoneDark, PALETTE.stone, random() * 0.3);
            } else {
                c = blend(PALETTE.stone, PALETTE.stoneLight, random() * 0.2);
            }
            grid.set(col.x, y, col.z, c);
        }
    }

    // 6d. Tree trunks are voxels too, so they get the same AO where they meet the ground.
    for (const tree of TREES) addTrunk(grid, tree, random);

    // Soft shade under the canopies is baked into the grass tops.
    grid.meshInto(builder, (cell, face, x, z) => (face === TOP_FACE ? canopyShade(x, z) : 1));

    // 6e. Water: flat quads at the water level + little falls where the level drops.
    addWaterSurfaces(data, builder);
    return grid;
}

function pickGrassColour(col, random) {
    const cx = col.x + 0.5;
    const cz = col.z + 0.5;
    // a carpet of fallen petals under each tree (dense in the middle, sparse at the rim)
    for (const tree of TREES) {
        const pad = tree.pads[0];
        const d = Math.hypot((cx - pad.x) / pad.rx, (cz - pad.z) / pad.rz);
        const chance = d < 0.55 ? 0.9 : d < 0.95 ? 0.9 - (d - 0.55) * 2.0 : 0;
        if (random() < chance) {
            return blend(PALETTE.blossomLight, PALETTE.blossom, random() * 0.35);
        }
    }
    return blend(PALETTE.grassSoft, random() < 0.6 ? PALETTE.grassLight : PALETTE.grass, random() * 0.35);
}

function addTrunk(grid, tree, random) {
    const bark = () => blend(PALETTE.soilDark, PALETTE.soil, 0.25 + random() * 0.35);
    const points = tree.trunk;
    // trunk: a 2x2 column that follows the waypoints (so it twists a little)
    for (let i = 0; i < points.length - 1; i++) {
        const [ax, ay, az] = points[i];
        const [bx, by, bz] = points[i + 1];
        for (let y = ay; y < by; y++) {
            const t = (y - ay) / Math.max(1, by - ay);
            const x = Math.round(ax + (bx - ax) * t);
            const z = Math.round(az + (bz - az) * t);
            for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) grid.set(x + dx, y, z + dz, bark());
        }
    }
    // a little root flare at the base
    const [rx, ry, rz] = points[0];
    for (const [dx, dz] of [[-1, 0], [2, 1], [0, -1], [1, 2]]) grid.set(rx + dx, ry, rz + dz, bark());

    // branches: a 1-voxel line from the trunk to the middle of each pad, just under it
    for (const pad of tree.pads) {
        const y = pad.y - 1;
        let trunkX = points[0][0];
        let trunkZ = points[0][2];
        for (const p of points) {
            if (p[1] <= y) { trunkX = p[0]; trunkZ = p[2]; }
        }
        const steps = Math.max(Math.abs(pad.x - trunkX), Math.abs(pad.z - trunkZ)) * 0.6;
        for (let s = 0; s <= steps; s++) {
            const t = steps === 0 ? 0 : s / steps;
            grid.set(Math.round(trunkX + (pad.x - trunkX) * t), y, Math.round(trunkZ + (pad.z - trunkZ) * t), bark());
        }
    }
}

function addWaterSurfaces(data, builder) {
    const water = colour(PALETTE.water);
    const foam = colour(PALETTE.foam);
    const up = [0, 1, 0];
    for (const col of data.columns.values()) {
        if (!col.water) continue;
        const x0 = col.x;
        const z0 = col.z;
        const y = col.waterY;
        // slightly darker next to the banks, lighter in the middle of the stream
        let banks = 0;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const n = data.columns.get(data.columnKey(x0 + dx, z0 + dz));
            if (n && !n.water) banks += 1;
        }
        const shade = banks >= 2 ? 0.9 : banks === 1 ? 0.95 : 1;
        builder.addQuad([[x0, y, z0], [x0, y, z0 + 1], [x0 + 1, y, z0 + 1], [x0 + 1, y, z0]], up, water,
            [shade, shade, shade, shade]);

        // a mini waterfall where a neighbour's water is lower (the terrace step)
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const n = data.columns.get(data.columnKey(x0 + dx, z0 + dz));
            if (!n || !n.water || n.waterY >= y - 0.01) continue;
            addVerticalWaterFace(builder, x0, z0, dx, dz, n.waterY, y, foam);
        }
    }
}

// A vertical sheet of water on the side (dx, dz) of a cell, from yLow up to yHigh.
function addVerticalWaterFace(builder, x0, z0, dx, dz, yLow, yHigh, col) {
    let corners;
    if (dx === 1) corners = [[x0 + 1, yLow, z0], [x0 + 1, yHigh, z0], [x0 + 1, yHigh, z0 + 1], [x0 + 1, yLow, z0 + 1]];
    if (dx === -1) corners = [[x0, yLow, z0], [x0, yLow, z0 + 1], [x0, yHigh, z0 + 1], [x0, yHigh, z0]];
    if (dz === 1) corners = [[x0, yLow, z0 + 1], [x0 + 1, yLow, z0 + 1], [x0 + 1, yHigh, z0 + 1], [x0, yHigh, z0 + 1]];
    if (dz === -1) corners = [[x0, yLow, z0], [x0, yHigh, z0], [x0 + 1, yHigh, z0], [x0 + 1, yLow, z0]];
    builder.addQuad(corners, [dx, 0, dz], col, [0.85, 1, 1, 0.85]);
}


// ---------- 7. Small props: lantern, stepping stones, flower stems ----------
// Low-poly on purpose (like the reference props): a handful of boxes each.
function buildLantern(builder, [lx, ly, lz]) {
    const stone = colour(PALETTE.stone);
    const light = colour(PALETTE.stoneLight);
    const dark = colour(PALETTE.stoneDark);
    const box = (x0, y0, z0, x1, y1, z1, c) =>
        builder.addBox([lx + x0, ly + y0, lz + z0], [lx + x1, ly + y1, lz + z1], c);

    box(-1.6, 0, -1.6, 1.6, 0.7, 1.6, dark);          // base slab
    box(-0.6, 0.7, -0.6, 0.6, 3.4, 0.6, stone);        // post
    box(-1.3, 3.4, -1.3, 1.3, 4.0, 1.3, light);        // platform
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        // four corner pillars around the fire box (the glow shows between them)
        box(sx * 1.05 - 0.25, 4.0, sz * 1.05 - 0.25, sx * 1.05 + 0.25, 5.7, sz * 1.05 + 0.25, stone);
    }
    box(-2.0, 5.7, -2.0, 2.0, 6.3, 2.0, light);        // wide roof
    box(-1.3, 6.3, -1.3, 1.3, 6.8, 1.3, stone);        // upper roof step
    box(-0.4, 6.8, -0.4, 0.4, 7.5, 0.4, dark);         // finial
}

function buildSteppingStones(builder, data) {
    STEPPING_STONES.forEach(([x, z], i) => {
        const c = blend(PALETTE.stoneLight, PALETTE.stone, i % 2 ? 0.45 : 0.1);
        const ground = groundHeightAt(data, x, z) ?? 0;
        const w = i % 2 ? 1.0 : 1.2;
        builder.addBox([x - w, ground - 0.3, z - 0.9], [x + w, ground + 0.32, z + 0.9], c, { bottomShade: 0.9 });
    });
}

function buildFlowerStems(builder, data) {
    const stem = colour(PALETTE.grassDark);
    const flowers = [];
    FLOWERS.forEach(([x, z], i) => {
        const ground = groundHeightAt(data, x, z);
        if (ground === null) return;
        const height = 1.1 + (i % 3) * 0.35;
        builder.addBox([x - 0.15, ground, z - 0.15], [x + 0.15, ground + height, z + 0.15], stem, { bottomShade: 0.7 });
        flowers.push({ x, y: ground + height, z, kind: i % 3 });
    });
    return flowers;
}


// ---------- 8. Blossom pads: ONE InstancedMesh for every blossom voxel ----------
// InstancedMesh draws the same cube many times in a single draw call; each copy
// ("instance") gets its own position (matrix) and colour. Perfect for ~1,000 blossoms.
function buildBlossoms(random) {
    const cells = new Map();
    const key = (x, y, z) => x + "," + y + "," + z;

    for (const tree of TREES) {
        for (const pad of tree.pads) {
            // each pad = 3 flat layers: a slightly smaller underside, the full middle, a smaller top
            const layers = [
                { dy: 0, scale: 0.82, tone: "shade" },
                { dy: 1, scale: 1.0, tone: "mid" },
                { dy: 2, scale: 0.66, tone: "top" }
            ];
            const wobble = random() * TAU;
            for (const layer of layers) {
                const rx = pad.rx * layer.scale;
                const rz = pad.rz * layer.scale;
                for (let x = Math.floor(pad.x - rx - 1); x <= Math.ceil(pad.x + rx + 1); x++) {
                    for (let z = Math.floor(pad.z - rz - 1); z <= Math.ceil(pad.z + rz + 1); z++) {
                        const dx = (x + 0.5 - pad.x) / rx;
                        const dz = (z + 0.5 - pad.z) / rz;
                        const angle = Math.atan2(dz, dx);
                        const limit = 1 + 0.1 * Math.sin(3 * angle + wobble);
                        if (dx * dx + dz * dz > limit * limit) continue;
                        const y = pad.y + layer.dy;
                        if (!cells.has(key(x, y, z))) cells.set(key(x, y, z), { x, y, z, tone: layer.tone });
                    }
                }
            }
        }
    }

    // Skip voxels that are completely surrounded: nobody can ever see them.
    const visible = [];
    for (const c of cells.values()) {
        const hidden = cells.has(key(c.x + 1, c.y, c.z)) && cells.has(key(c.x - 1, c.y, c.z))
            && cells.has(key(c.x, c.y + 1, c.z)) && cells.has(key(c.x, c.y - 1, c.z))
            && cells.has(key(c.x, c.y, c.z + 1)) && cells.has(key(c.x, c.y, c.z - 1));
        if (!hidden) visible.push(c);
    }

    // One cube with a soft dark bottom edge (vertex colours) so each voxel reads crisply.
    const cube = new THREE.BoxGeometry(1, 1, 1);
    const shades = [];
    const pos = cube.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        const s = pos.getY(i) < 0 ? 0.84 : 1;
        shades.push(s, s, s);
    }
    cube.setAttribute("color", new THREE.Float32BufferAttribute(shades, 3));

    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    const mesh = new THREE.InstancedMesh(cube, material, visible.length);
    const matrix = new THREE.Matrix4();
    visible.forEach((c, i) => {
        matrix.makeTranslation(c.x + 0.5, c.y + 0.5, c.z + 0.5);
        mesh.setMatrixAt(i, matrix);
        mesh.setColorAt(i, blossomTone(c.tone, random));
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    return mesh;
}

// Layered colour: light on top (lit), mid in the middle, shade underneath.
function blossomTone(tone, random) {
    const r = random();
    if (tone === "top") return blend(PALETTE.blossomLight, PALETTE.blossom, r * 0.3);
    if (tone === "mid") return blend(PALETTE.blossom, PALETTE.blossomLight, r * 0.28);
    return blend(PALETTE.blossomShade, PALETTE.blossom, r * 0.3);
}


// ---------- 9. The big leaf (Koko's umbrella) ----------
// A tall stem with one broad, pointed blade that reaches out like an umbrella.
// The blade is one voxel thick and bends in whole-voxel steps (angular, like the trees).
// The group's origin is the stem base, so rotating props.leaf sways it from the ground.
const LEAF_LENGTH = 15;       // voxels from the heart-shaped base to the tip
const LEAF_HALF_WIDTH = 5.6;
const LEAF_HEIGHT = 16;       // blade height at its base

// Width of the blade along its length (t = 0 at the base, 1 at the tip).
function leafWidth(t) {
    if (t < 0.28) return 0.72 + 0.28 * (t / 0.28);      // the rounded lobes near the stem
    return 1 - Math.pow((t - 0.28) / 0.72, 1.5);         // then it narrows to a point
}

function buildLeaf(random, material) {
    const grid = new VoxelGrid();
    const stemColour = () => blend(PALETTE.grassDark, PALETTE.leafDark, random() * 0.5);

    // 9a. Stem: straight up, then a short stalk bends towards the blade (-x).
    for (let y = 0; y <= LEAF_HEIGHT - 2; y++) grid.set(0, y, 0, stemColour());
    for (const x of [-1, -2, -3]) grid.set(x, LEAF_HEIGHT - 1, 0, stemColour());

    // 9b. Blade: runs along -x from the stem. It lifts a little, then droops to the tip;
    //     its edges droop too, a bit more on the camera side (-z here, because the
    //     group is turned half a circle when it is placed on the island).
    const veins = [3, 6.5, 10, 13.5];
    for (let i = 0; i <= LEAF_LENGTH; i++) {
        const t = i / LEAF_LENGTH;
        const x = -2 - i;
        const half = LEAF_HALF_WIDTH * leafWidth(t);
        const lift = 2.0 * Math.sin(Math.PI * t) * (1 - t) - 2.6 * t * t;
        for (let z = -6; z <= 6; z++) {
            const across = Math.abs(z);
            if (across > half) continue;
            if (t < 0.09 && across < 1.6 * (1 - t / 0.09) + 0.2) continue;   // heart-shaped notch
            const y = Math.round(LEAF_HEIGHT + lift - (0.055 * z * z - 0.16 * z));

            const onRib = across < 0.5;
            const onVein = veins.some((v) => i > v && Math.abs((i - v) - across * 0.9) < 0.5);
            const onRim = across > half - 1;
            let c;
            if (onRib) c = colour(PALETTE.grassLight);
            else if (onVein) c = blend(PALETTE.grass, PALETTE.grassLight, 0.3);
            else if (onRim) c = blend(PALETTE.leafDark, PALETTE.grassDark, random() * 0.3);
            else c = blend(PALETTE.grassDark, PALETTE.grass, 0.25 + random() * 0.25);
            grid.set(x, y, z, c);
        }
    }

    const builder = new GeometryBuilder();
    grid.meshInto(builder);
    const mesh = new THREE.Mesh(builder.build(), material);
    // voxel (0, y, 0) spans 0..1; shift by half a voxel so the stem sits on the group's origin
    mesh.position.set(-0.5, 0, -0.5);
    const group = new THREE.Group();
    group.name = "leaf";
    group.add(mesh);
    return group;
}


// ---------- 10. The storm cloud (slate voxels) ----------
// A flat, dark base (where the rain comes from) with three stepped puffs on top.
// Each puff is a stack of shrinking ellipses, so it looks soft but stays angular.
const CLOUD_PUFFS = [
    { x: -4.5, z: 0, r: 5.2, h: 4 },
    { x: 3, z: 0.5, r: 6, h: 5 },
    { x: 9, z: -0.5, r: 3.6, h: 3 }
];

function buildStormCloud(random, material) {
    const grid = new VoxelGrid();
    const put = (x, y, z, hexA, hexB) => grid.set(x, y, z, blend(hexA, hexB, random() * 0.2));

    // the base: two wide, flat layers in deep slate
    for (let x = -13; x <= 13; x++) {
        for (let z = -7; z <= 7; z++) {
            const d = (x / 12.5) ** 2 + (z / 6.4) ** 2;
            if (d <= 1) put(x, 0, z, PALETTE.slate, PALETTE.cloudMid);
            if (d <= 0.82) put(x, 1, z, PALETTE.cloudMid, PALETTE.slate);
        }
    }
    // the puffs: lighter as they rise (the top catches the light)
    for (const puff of CLOUD_PUFFS) {
        for (let level = 0; level < puff.h; level++) {
            const r = puff.r * Math.sqrt(1 - (level / puff.h) ** 2);
            const top = level >= puff.h - 2;
            for (let x = Math.floor(puff.x - r); x <= Math.ceil(puff.x + r); x++) {
                for (let z = Math.floor(puff.z - r); z <= Math.ceil(puff.z + r); z++) {
                    if ((x - puff.x) ** 2 + ((z - puff.z) * 1.25) ** 2 > r * r) continue;
                    put(x, 2 + level, z, top ? PALETTE.cloudTop : PALETTE.cloudMid, PALETTE.cloudTop);
                }
            }
        }
    }

    const builder = new GeometryBuilder();
    grid.meshInto(builder);
    const mesh = new THREE.Mesh(builder.build(), material);
    const group = new THREE.Group();
    group.name = "storm-cloud";
    group.add(mesh);
    return group;
}


// ---------- 11. createGrove: put it all together ----------
export function createGrove({ renderer, reducedMotion = false, quality = "high" } = {}) {
    const random = makeRandom(20240611);
    const low = quality === "low";

    const scene = new THREE.Scene();
    scene.background = null;                      // transparent: the CSS backdrop shows through

    // 11a. Studio lighting: a warm, slightly low key from the upper left (late-afternoon
    //      sun), soft sky/floor fill, a gentle right fill and a back rim so the silhouette
    //      separates from the backdrop.
    const hemi = new THREE.HemisphereLight("#fff3ea", "#f0c2cb", 1.9);
    const key = new THREE.DirectionalLight("#ffe2bf", 1.9);
    key.position.set(-42, 44, 30);
    const fill = new THREE.DirectionalLight("#ffe6ec", 0.55);
    fill.position.set(45, 12, 20);
    const rim = new THREE.DirectionalLight("#fff6f0", 0.6);
    rim.position.set(15, 30, -50);
    scene.add(hemi, key, fill, rim);
    const LIGHT_BASE = { hemi: hemi.intensity, key: key.intensity, fill: fill.intensity, rim: rim.intensity };

    // The island and everything on it lives in one group, so it floats as one toy.
    const island = new THREE.Group();
    island.name = "island";
    scene.add(island);

    // 11b. The island mesh (ground, trunks, water, lantern stone, stepping stones, stems).
    const landMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
    const data = buildIslandData(random);
    const builder = new GeometryBuilder();
    buildIsland(data, random, builder);
    const lanternBase = [LANTERN_POS[0], groundHeightAt(data, LANTERN_POS[0], LANTERN_POS[1]) ?? 0, LANTERN_POS[1]];
    buildLantern(builder, lanternBase);
    buildSteppingStones(builder, data);
    const flowerHeads = buildFlowerStems(builder, data);
    const land = new THREE.Mesh(builder.build(), landMaterial);
    land.name = "land";
    island.add(land);

    // 11c. Blossoms (one InstancedMesh).
    const blossoms = buildBlossoms(random);
    blossoms.name = "blossoms";
    island.add(blossoms);

    // 11d. Flower heads: 5 tiny cubes each (a cross), one InstancedMesh.
    const flowers = buildFlowerHeads(flowerHeads, random);
    island.add(flowers);

    // 11e. Lantern glow: an unlit amber cube (always bright) + a soft additive halo.
    const lanternGlow = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 1.5, 1.5),
        new THREE.MeshBasicMaterial({ color: colour(PALETTE.lantern) }));
    lanternGlow.position.set(lanternBase[0], lanternBase[1] + 4.85, lanternBase[2]);
    // (normal blending, not additive: additive amber over green grass turns acid yellow)
    const haloTexture = makeRadialTexture([
        [0, "rgba(255, 200, 120, 0.7)"], [0.3, "rgba(255, 181, 71, 0.28)"], [1, "rgba(255, 181, 71, 0)"]
    ]);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: haloTexture, depthWrite: false, transparent: true
    }));
    halo.position.copy(lanternGlow.position);
    halo.scale.setScalar(7);
    island.add(lanternGlow, halo);

    // 11f. The big leaf.
    const leaf = buildLeaf(random, landMaterial);
    leaf.position.set(LEAF_STEM_POS[0], groundHeightAt(data, ...LEAF_STEM_POS) ?? 0, LEAF_STEM_POS[1]);
    leaf.rotation.y = LEAF_YAW;
    island.add(leaf);

    // 11g. Koko's spot, walk path and soft contact shadow.
    const shadowTexture = makeRadialTexture([
        [0, "rgba(255,255,255,0.55)"], [0.45, "rgba(255,255,255,0.28)"], [1, "rgba(255,255,255,0)"]
    ]);
    const walkPath = new THREE.CatmullRomCurve3([
        new THREE.Vector3(-6, 0, 7.6),
        new THREE.Vector3(SHELTER_POS[0], 0, SHELTER_POS[2]),
        new THREE.Vector3(HERO_POS[0], 0, HERO_POS[2]),
        new THREE.Vector3(9, 0, 8.8)
    ]);
    const homeU = nearestU(walkPath, new THREE.Vector3(...HERO_POS));
    const shelterU = nearestU(walkPath, new THREE.Vector3(...SHELTER_POS));

    const kokoSpot = new THREE.Group();
    kokoSpot.name = "kokoSpot";
    kokoSpot.position.copy(walkPath.getPointAt(homeU));
    kokoSpot.scale.setScalar(1);                  // 1 Koko voxel = 1 island voxel
    const kokoShadow = makeShadowBlob(shadowTexture, "#2c5a2e", 19, 8);
    kokoShadow.position.y = 0.05;
    kokoSpot.add(kokoShadow);
    island.add(kokoSpot);

    const shelterSpot = new THREE.Object3D();
    shelterSpot.name = "shelterSpot";
    shelterSpot.position.set(...SHELTER_POS);
    island.add(shelterSpot);

    // 11h. The soft contact shadow far below the floating island (on the studio "floor").
    const floorShadow = makeShadowBlob(shadowTexture, "#a85a6e", 44, 30);
    floorShadow.material.opacity = 0.75;
    floorShadow.position.set(1, -27, 1);
    scene.add(floorShadow);

    // 11i. Moving things: waterfall + stream glints, petals, rain, storm cloud.
    const waterfall = createWaterfall(data, low);
    island.add(waterfall.mesh);

    const petals = createPetals(low ? 40 : 80, 24);
    island.add(petals.mesh);

    const rain = createRain(low ? 70 : 150);
    island.add(rain.mesh);

    // petals land on, and rain stops at, the island top
    const ground = (x, z) => groundHeightAt(data, x, z);
    petals.ground = ground;
    rain.ground = ground;

    // the rain also stops on top of the big leaf, so Koko stays dry underneath
    const leafRoofAt = (x, z) => {
        const dx = x - leaf.position.x;
        const dz = z - leaf.position.z;
        // turn the point into the leaf's own space (undo the leaf's yaw)
        const lx = dx * Math.cos(LEAF_YAW) - dz * Math.sin(LEAF_YAW);
        const lz = dx * Math.sin(LEAF_YAW) + dz * Math.cos(LEAF_YAW);
        const t = (-lx - 2) / LEAF_LENGTH;
        if (t < 0 || t > 1 || Math.abs(lz) > LEAF_HALF_WIDTH * leafWidth(t)) return null;
        return leaf.position.y + LEAF_HEIGHT - 1;
    };
    rain.ground = (x, z) => leafRoofAt(x, z) ?? ground(x, z);

    const stormCloud = buildStormCloud(random, landMaterial);
    stormCloud.visible = false;
    island.add(stormCloud);

    // 11k. Warmth: a soft golden sun glow behind the island, upper left. It is far
    //      behind the island, so the island hides it where they overlap.
    const sunTexture = makeRadialTexture([
        [0, "rgba(255, 236, 196, 0.55)"], [0.35, "rgba(255, 206, 120, 0.22)"], [1, "rgba(255, 197, 61, 0)"]
    ]);
    const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: sunTexture, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true
    }));
    sunGlow.position.set(-33, 4, -27);
    sunGlow.scale.setScalar(78);
    sunGlow.raycast = () => {};                  // decoration only: never catches clicks
    scene.add(sunGlow);

    // 11j. Camera: narrow field of view from high up = almost isometric, like a product shot.
    const camera = new THREE.PerspectiveCamera(22, 1, 10, 1000);
    scene.add(camera);                           // so the foreground blossoms (its children) render

    // 11l. "Depth blur at the edges": a few big, pre-blurred blossoms close to the lens,
    //      near the frame corners. They hang on the camera, so they stay in the corners,
    //      and drift against the pointer a little (a different parallax depth).
    const foreground = createForegroundBlossoms(camera);
    const view = {
        azimuth: 32 * DEG,           // turned so we see Koko's side and a bit of the face
        elevation: 25 * DEG,
        distance: 200,
        target: new THREE.Vector3(1, 1, 0),
        orbitX: 0,                   // smoothed pointer parallax (radians)
        orbitY: 0,
        spin: 0                      // smoothed scroll rotation
    };

    // ---------- state ----------
    let reduced = reducedMotion;
    // value = what is on screen now; target = what was asked for. main.js ramps the
    // target smoothly itself; a sudden jump (0 -> 1) still eases over about 1.3 s here.
    const weather = { target: 0, value: 0, lastValue: 0, leaving: false, cloudX: 0 };
    // high enough that, on a phone, the cloud never covers Koko's face or bow
    const CLOUD_HOME = new THREE.Vector3(3, 24, 0);

    function placeCamera() {
        const az = view.azimuth + view.orbitX;
        const el = view.elevation + view.orbitY;
        camera.position.set(
            view.target.x + Math.sin(az) * Math.cos(el) * view.distance,
            view.target.y + Math.sin(el) * view.distance,
            view.target.z + Math.cos(az) * Math.cos(el) * view.distance);
        camera.lookAt(view.target);
    }

    // ---------- resize: fit the island and put Koko where the page asks ----------
    function resize(width, height, layout = {}) {
        const portrait = height >= width;
        const kokoX = layout.kokoX ?? (portrait ? 0.5 : 0.68);
        const kokoY = layout.kokoY ?? (portrait ? 0.7 : 0.62);
        camera.aspect = width / height;

        // How many pixels one island unit should cover: fit the width on phones,
        // the height on wide screens (whichever is tighter wins).
        const byWidth = (width * 0.9) / 40;
        const byHeight = (height * 0.74) / 58;
        const pixelsPerUnit = Math.min(byWidth, byHeight);
        const visibleHeight = height / pixelsPerUnit;
        view.distance = visibleHeight / (2 * Math.tan((camera.fov * DEG) / 2));
        camera.near = Math.max(1, view.distance * 0.2);   // close enough for the foreground blossoms
        camera.far = view.distance + 160;

        // Find where Koko's middle lands on screen with a centred camera...
        const saved = { x: view.orbitX, y: view.orbitY };
        view.orbitX = 0;
        view.orbitY = 0;
        placeCamera();
        camera.clearViewOffset();
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
        const kokoMiddle = kokoSpot.position.clone().add(new THREE.Vector3(0, 5, 0));
        const ndc = kokoMiddle.project(camera);
        const px = (ndc.x + 1) / 2 * width;
        const py = (1 - ndc.y) / 2 * height;
        // ...then slide the view (an "off-centre" projection) so Koko sits at (kokoX, kokoY).
        camera.setViewOffset(width, height, px - kokoX * width, py - kokoY * height, width, height);
        camera.updateProjectionMatrix();
        view.orbitX = saved.x;
        view.orbitY = saved.y;
        placeCamera();
        foreground.place(view.distance * 0.35);
    }

    // ---------- weather ----------
    function setWeather(t, { immediate = false } = {}) {
        weather.target = clamp01(t);
        if (immediate || reduced) {
            weather.value = weather.target;
            weather.lastValue = weather.value;
            applyWeather(0);
            rain.update(0, stormCloud.position);
        }
    }

    function applyWeather(dt) {
        // The cloud "condenses" in: it drifts in from the left while growing from small
        // to full size, then drifts on to the right and shrinks away when the sun returns.
        // Only its position and scale change (transforms), never its colour.
        if (weather.value > weather.lastValue + 1e-4) weather.leaving = false;
        if (weather.value < weather.lastValue - 1e-4) weather.leaving = true;
        weather.lastValue = weather.value;

        const grow = smooth01(weather.value / 0.75);              // 0 = gone, 1 = parked over the island
        const side = weather.leaving ? 1 : -1;                     // arrive from the left, leave to the right
        const goalX = CLOUD_HOME.x + side * (1 - grow) * 18;
        weather.cloudX = reduced || dt === 0 ? goalX : damp(weather.cloudX, goalX, 6, dt);
        stormCloud.visible = grow > 0.01;
        stormCloud.position.set(weather.cloudX, CLOUD_HOME.y + (1 - grow) * 4, CLOUD_HOME.z);
        stormCloud.scale.setScalar(0.15 + 0.85 * grow);

        // Light dims while it rains (light intensity only; material colours never change).
        const gloom = smooth01(weather.value);
        key.intensity = LIGHT_BASE.key * (1 - 0.75 * gloom);
        rim.intensity = LIGHT_BASE.rim * (1 - 0.6 * gloom);
        fill.intensity = LIGHT_BASE.fill * (1 - 0.3 * gloom);
        hemi.intensity = LIGHT_BASE.hemi * (1 - 0.4 * gloom);
        // the lantern feels brighter in the gloom: its halo grows (a transform, not a colour),
        // and the warm sun glow shrinks away behind the island while the cloud is over it
        halo.scale.setScalar(7 + 3 * gloom);
        sunGlow.scale.setScalar(78 * (1 - 0.65 * gloom));

        rain.amount = reduced ? 0 : smooth01((weather.value - 0.3) / 0.7);
    }

    // ---------- update: called every frame ----------
    const pointer = { x: 0, y: 0 };
    function update(dt, elapsed, input = {}) {
        dt = Math.min(Math.max(dt, 0), 0.1);
        const p = input.pointer || pointer;
        const scroll = input.scroll || 0;

        // weather moves at a steady pace (at most 0 -> 1 in about 1.3 s)
        weather.value = approach(weather.value, weather.target, dt * 0.75);
        applyWeather(dt);

        if (reduced) {
            island.position.y = 0;
            floorShadow.scale.set(44, 30, 1);
            placeCamera();
            updateShelterPoint();
            return;
        }

        // pointer parallax = a small orbit around the island (smoothed)
        view.orbitX = damp(view.orbitX, p.x * 5 * DEG, 3, dt);
        view.orbitY = damp(view.orbitY, p.y * 2.5 * DEG, 3, dt);
        // scrolling turns the island a few degrees
        view.spin = damp(view.spin, scroll * -8 * DEG, 4, dt);
        island.rotation.y = view.spin;
        placeCamera();

        // gentle float: 6 s up-and-down; the floor shadow tightens as the island rises
        const bob = Math.sin((elapsed * TAU) / 6);
        island.position.y = bob * 0.45;
        const shadowScale = 1 - bob * 0.035;
        floorShadow.scale.set(44 * shadowScale, 30 * shadowScale, 1);
        stormCloud.position.y += Math.sin((elapsed * TAU) / 4) * 0.3;   // a slow heave

        waterfall.update(dt, elapsed);
        petals.update(dt, elapsed, weather.value);
        rain.update(dt, stormCloud.position);
        foreground.update(elapsed, p);
        updateShelterPoint();
    }

    // The shelter under the leaf, in world space (the island floats, so it is refreshed every frame).
    const shelterPoint = new THREE.Vector3();
    function updateShelterPoint() {
        island.updateMatrixWorld();
        shelterSpot.getWorldPosition(shelterPoint);
    }

    // ---------- reduced motion: static pose, no petals, no rain ----------
    function setReducedMotion(on) {
        reduced = Boolean(on);
        petals.mesh.visible = !reduced;
        if (reduced) {
            view.orbitX = 0;
            view.orbitY = 0;
            island.rotation.y = 0;
            weather.value = weather.target;
            waterfall.update(0, 0);              // frozen in a nice-looking frame
            foreground.update(0, { x: 0, y: 0 }); // the blur blossoms stay, but hold still
        }
        applyWeather(0);
        rain.update(0, stormCloud.position);
    }

    // ---------- petal burst (e.g. when a coin is collected) ----------
    function burstPetals(worldPoint) {
        if (reduced || !worldPoint) return;
        island.updateMatrixWorld();
        const local = island.worldToLocal(worldPoint.clone());
        petals.burst(local);
    }

    // ---------- stats: for the budget check ----------
    function stats() {
        let triangles = 0;
        let drawCalls = 0;
        let instances = 0;
        scene.traverseVisible((obj) => {
            if (!obj.isMesh && !obj.isSprite) return;
            const geo = obj.geometry;
            const tris = geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
            const copies = obj.isInstancedMesh ? obj.count : 1;
            if (copies === 0) return;
            triangles += tris * copies;
            drawCalls += 1;
            if (obj.isInstancedMesh) instances += copies;
        });
        return { triangles: Math.round(triangles), drawCallsEstimate: drawCalls, instances };
    }

    function dispose() {
        scene.traverse((obj) => {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) obj.material.dispose();
        });
        shadowTexture.dispose();
        haloTexture.dispose();
        sunTexture.dispose();
        foreground.dispose();
    }

    setReducedMotion(reduced);
    resize(390, 844, {});
    updateShelterPoint();

    return {
        scene,
        camera,
        kokoSpot,
        walkPath,
        homeU,
        update,
        resize,
        setReducedMotion,
        burstPetals,
        setWeather,
        props: {
            island,
            leaf,
            lantern: lanternGlow,
            lanternHalo: halo,
            stormCloud,
            shelterSpot,                         // Object3D under the leaf (island space)
            shelterPoint,                        // the same spot as a world-space Vector3 (kept current)
            shelterU,                            // where the shelter is on walkPath
            sunGlow,
            waterfall: waterfall.mesh
        },
        stats,
        dispose,
        get weather() { return weather.value; }
    };
}

// The u (0..1) on a curve closest to a point (sampled; good enough for a short path).
function nearestU(curve, point) {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i <= 200; i++) {
        const u = i / 200;
        const d = curve.getPointAt(u).distanceToSquared(point);
        if (d < bestDist) { bestDist = d; best = u; }
    }
    return best;
}


// ---------- 12. Flower heads ----------
function buildFlowerHeads(heads, random) {
    const offsets = [[0, 0, 0], [0.42, 0, 0], [-0.42, 0, 0], [0, 0, 0.42], [0, 0, -0.42]];
    const mesh = new THREE.InstancedMesh(
        new THREE.BoxGeometry(0.42, 0.42, 0.42),
        new THREE.MeshLambertMaterial(),
        heads.length * offsets.length);
    const matrix = new THREE.Matrix4();
    let i = 0;
    heads.forEach((head) => {
        const petal = head.kind === 0 ? PALETTE.white : head.kind === 1 ? PALETTE.blossomLight : PALETTE.white;
        offsets.forEach(([ox, oy, oz], k) => {
            matrix.makeTranslation(head.x + ox, head.y + 0.2 + oy, head.z + oz);
            mesh.setMatrixAt(i, matrix);
            const c = k === 0 ? colour(head.kind === 2 ? PALETTE.blossom : PALETTE.gold) : blend(petal, PALETTE.blossomLight, random() * 0.2);
            mesh.setColorAt(i, c);
            i += 1;
        });
    });
    mesh.name = "flowers";
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    return mesh;
}


// ---------- 13. Waterfall: water voxels sliding off the edge ----------
// The stream itself is static; little "glints" slide along it, and at the edge
// voxels fall in a curve and shrink away into the mist. Only transforms move.
function createWaterfall(data, low) {
    const columns = 3;
    const rows = low ? 12 : 16;
    const glints = low ? 5 : 9;
    const fallCount = columns * rows;
    const mesh = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshLambertMaterial(),
        fallCount + glints);
    mesh.name = "waterfall";
    mesh.frustumCulled = false;                  // instances move, so skip the bounding-box test
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const tones = [PALETTE.water, PALETTE.waterLight, PALETTE.foam];
    for (let i = 0; i < fallCount; i++) mesh.setColorAt(i, colour(tones[(i * 7) % 3 === 2 ? 1 : (i % 3 === 0 ? 2 : 0)]));
    for (let i = 0; i < glints; i++) mesh.setColorAt(fallCount + i, colour(PALETTE.foam));
    mesh.instanceColor.needsUpdate = true;

    const lip = data.lip.clone();
    const dir = data.flowDir.clone();
    const side = new THREE.Vector3(-dir.z, 0, dir.x);   // across the stream
    const waterY = -0.3;
    const fallLength = 16;
    const path = data.streamSamples;
    const dummy = new THREE.Object3D();

    function update(dt, elapsed) {
        // falling voxels: each one has its own phase s (0 = at the lip, 1 = gone)
        for (let i = 0; i < fallCount; i++) {
            const column = i % columns;
            const row = Math.floor(i / columns);
            const s = (row / rows + elapsed * 0.32 + column * 0.13) % 1;
            const across = (column - 1) * 0.75;
            const out = 0.4 + 2.2 * Math.sqrt(s);             // arcs outward as it falls
            dummy.position.copy(lip)
                .addScaledVector(dir, out)
                .addScaledVector(side, across);
            dummy.position.y = waterY - s * s * fallLength - s * 2;
            const fade = s > 0.55 ? 1 - (s - 0.55) / 0.45 : 1;
            dummy.scale.set(0.8 * fade + 0.05, 1.3 * fade + 0.05, 0.8 * fade + 0.05);
            dummy.rotation.set(0, Math.atan2(dir.x, dir.z), 0);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
        }
        // glints sliding down the stream
        for (let g = 0; g < glints; g++) {
            const u = (g / glints + elapsed * 0.05) % 1;
            const p = path[Math.floor(u * (path.length - 1))];
            dummy.position.set(p.x + Math.sin(g * 2.3) * 0.4, data.columns.get(data.columnKey(Math.floor(p.x), Math.floor(p.z)))?.waterY + 0.06 || waterY, p.z);
            dummy.scale.set(0.7, 0.08, 0.35);
            dummy.rotation.set(0, Math.atan2(dir.x, dir.z), 0);
            dummy.updateMatrix();
            mesh.setMatrixAt(fallCount + g, dummy.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
    }
    update(0, 0.6);
    return { mesh, update };
}


// ---------- 14. Falling petals (+ a burst for coin collects) ----------
function createPetals(ambientCount, burstCount) {
    const total = ambientCount + burstCount;
    const mesh = new THREE.InstancedMesh(
        new THREE.BoxGeometry(0.62, 0.14, 0.48),
        new THREE.MeshLambertMaterial(),
        total);
    mesh.name = "petals";
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const random = makeRandom(77);
    const tones = [PALETTE.blossomLight, PALETTE.blossom, PALETTE.blossomLight, PALETTE.white];
    for (let i = 0; i < total; i++) mesh.setColorAt(i, colour(tones[i % tones.length]));
    mesh.instanceColor.needsUpdate = true;

    // where petals start: under the blossom pads
    const pads = TREES.flatMap((t) => t.pads);
    const p = [];
    for (let i = 0; i < total; i++) {
        p.push({ x: 0, y: -999, z: 0, vx: 0, vy: 0, vz: 0, spin: 0, phase: 0, life: 0, rest: 0, size: 1, burst: i >= ambientCount });
    }

    function respawn(petal, warm) {
        const pad = pads[Math.floor(random() * pads.length)];
        const a = random() * TAU;
        const r = Math.sqrt(random());
        petal.x = pad.x + Math.cos(a) * pad.rx * r;
        petal.z = pad.z + Math.sin(a) * pad.rz * r;
        petal.y = pad.y - 0.2 - (warm ? random() * (pad.y + 8) : random() * 1.5);
        petal.vy = 1.1 + random() * 0.9;               // falling speed (units per second)
        petal.phase = random() * TAU;
        petal.spin = 0.6 + random() * 1.4;
        petal.rest = 0;
        petal.size = 0.8 + random() * 0.4;
        petal.life = 1;
    }
    for (let i = 0; i < ambientCount; i++) respawn(p[i], true);

    const dummy = new THREE.Object3D();
    let clock = 0;

    function update(dt, elapsed, wet) {
        clock += dt;
        const rush = 1 + wet * 0.8;                     // rain knocks petals down faster
        for (let i = 0; i < total; i++) {
            const q = p[i];
            let scale = q.size;
            if (q.burst) {
                if (q.life <= 0) { hide(i); continue; }
                q.life -= dt / 1.4;
                q.vy -= 9 * dt;
                q.x += q.vx * dt;
                q.y += q.vy * dt;
                q.z += q.vz * dt;
                scale *= Math.min(1, q.life * 2.5);
            } else if (q.rest > 0) {
                // resting on the grass for a moment, then shrinking away
                q.rest -= dt;
                if (q.rest < 0.6) scale *= Math.max(0, q.rest / 0.6);
                if (q.rest <= 0) respawn(q, false);
            } else {
                q.y -= q.vy * rush * dt;
                q.x += Math.sin(clock * 1.3 + q.phase) * 0.9 * dt + 0.25 * dt;
                q.z += Math.cos(clock * 1.1 + q.phase) * 0.6 * dt;
                const ground = groundForPetal(q.x, q.z);
                if (ground !== null && q.y <= ground + 0.08 && q.y > ground - 1.5) {
                    q.y = ground + 0.08;
                    q.rest = 2.5 + random() * 3;
                } else if (q.y < -26) {
                    respawn(q, false);
                } else if (q.y < -20) {
                    scale *= (q.y + 26) / 6;
                }
            }
            const tumble = q.rest > 0 ? 0 : 1;
            dummy.position.set(q.x, q.y, q.z);
            dummy.rotation.set(
                tumble * Math.sin(clock * q.spin + q.phase) * 1.2,
                q.phase + clock * 0.4 * tumble,
                tumble * Math.cos(clock * q.spin * 0.8 + q.phase) * 0.9);
            dummy.scale.setScalar(Math.max(0.0001, scale));
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
    }

    function hide(i) {
        dummy.position.set(0, -999, 0);
        dummy.scale.setScalar(0.0001);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
    }

    function burst(point) {
        let made = 0;
        for (let i = ambientCount; i < total && made < burstCount; i++) {
            const q = p[i];
            const a = random() * TAU;
            const speed = 2.5 + random() * 3;
            q.x = point.x; q.y = point.y; q.z = point.z;
            q.vx = Math.cos(a) * speed;
            q.vz = Math.sin(a) * speed;
            q.vy = 4 + random() * 3.5;
            q.life = 1;
            q.size = 0.8 + random() * 0.5;
            q.phase = random() * TAU;
            q.spin = 2 + random() * 3;
            made += 1;
        }
    }

    // petals land on the island top; the ground lookup comes from the island data
    let groundForPetal = () => null;
    for (let i = 0; i < total; i++) hide(i);
    update(0, 0, 0);
    return {
        mesh, update, burst,
        set ground(fn) { groundForPetal = fn; }
    };
}


// ---------- 15. Rain streaks ----------
function createRain(maxCount) {
    const mesh = new THREE.InstancedMesh(
        new THREE.BoxGeometry(0.16, 3.0, 0.16),
        new THREE.MeshBasicMaterial({ color: colour(PALETTE.water), transparent: true, opacity: 0.8 }),
        maxCount);
    mesh.name = "rain";
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;

    const random = makeRandom(4242);
    const drops = [];
    for (let i = 0; i < maxCount; i++) drops.push({ x: 0, y: 0, z: 0, speed: 0, started: false });
    const dummy = new THREE.Object3D();
    const state = { amount: 0, mesh, update };

    function respawn(d, cloud, anywhere) {
        d.x = cloud.x + (random() - 0.5) * 19;
        d.z = cloud.z + (random() - 0.5) * 10;
        d.y = cloud.y - 0.5 - (anywhere ? random() * 40 : random() * 2);
        d.speed = 24 + random() * 8;
        d.started = true;
    }

    function update(dt, cloud) {
        const active = Math.round(maxCount * state.amount);
        mesh.count = active;
        mesh.visible = active > 0;
        for (let i = 0; i < active; i++) {
            const d = drops[i];
            if (!d.started) respawn(d, cloud, true);
            d.y -= d.speed * dt;
            d.x += 1.2 * dt;                         // a light breeze slants the rain
            const ground = state.ground ? state.ground(d.x, d.z) : null;
            if ((ground !== null && d.y < ground + 0.8 && d.y > ground - 2) || d.y < -24) respawn(d, cloud, false);
            dummy.position.set(d.x, d.y, d.z);
            dummy.rotation.set(0, 0, -0.05);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
    }
    return state;
}


// ---------- 16. Foreground blossoms ("depth blur at the edges") ----------
// Real depth of field needs post-processing, which is too heavy for phones. Instead we
// draw a few blossoms on a canvas and blur them there, once, at start-up. Close to the
// lens and out of focus, they make the island feel like a small object far away.
const FOREGROUND = [
    // nx, ny: where on screen (-1..1, y up); size: fraction of the frame height; drift phase
    { nx: -0.86, ny: -0.88, size: 0.3, kind: "cluster", phase: 0 },
    { nx: 0.94, ny: -0.7, size: 0.2, kind: "petal", phase: 1.7 },
    { nx: 0.97, ny: 0.93, size: 0.16, kind: "cluster", phase: 3.1 },
    { nx: -0.98, ny: -0.28, size: 0.12, kind: "petal", phase: 4.4 }
];

function makeBlurredBlossomTexture(kind) {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const blur = 16;

    // ctx.filter blurs everything drawn after it. Some browsers ignore it, so then we use
    // the classic trick instead: draw the shape off-canvas and keep only its blurred shadow.
    ctx.filter = "blur(" + blur + "px)";
    const canFilter = ctx.filter === "blur(" + blur + "px)";
    const shift = canFilter ? 0 : size * 2;
    if (!canFilter) {
        ctx.shadowBlur = blur * 2;
        ctx.shadowOffsetX = shift;
    }

    // angular petals (rotated squares), in the blossom pinks
    const petals = kind === "cluster"
        ? [[0.5, 0.5, 0.3, PALETTE.blossom], [0.3, 0.36, 0.24, PALETTE.blossomLight],
            [0.7, 0.32, 0.22, PALETTE.blossomLight], [0.32, 0.7, 0.2, PALETTE.blossomShade],
            [0.7, 0.68, 0.24, PALETTE.blossom]]
        : [[0.5, 0.5, 0.46, PALETTE.blossomLight], [0.6, 0.42, 0.22, PALETTE.blossom]];
    for (const [x, y, r, hex] of petals) {
        ctx.save();
        ctx.translate(x * size - shift, y * size);
        ctx.rotate(Math.PI / 4 + x * 0.6);
        ctx.fillStyle = hex;
        ctx.shadowColor = hex;
        ctx.fillRect(-r * size * 0.5, -r * size * 0.5, r * size, r * size);
        ctx.restore();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

function createForegroundBlossoms(camera) {
    const textures = {
        cluster: makeBlurredBlossomTexture("cluster"),
        petal: makeBlurredBlossomTexture("petal")
    };
    const sprites = FOREGROUND.map((spec) => {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: textures[spec.kind],
            transparent: true,
            opacity: 0.95,
            depthTest: false,                // always in front: they are "on the lens"
            depthWrite: false
        }));
        sprite.renderOrder = 20;
        sprite.raycast = () => {};
        sprite.userData = { spec, base: new THREE.Vector3(), frame: 1 };
        camera.add(sprite);
        return sprite;
    });

    // Put each blossom at its screen corner, `depth` units in front of the camera.
    // projectionMatrixInverse turns a screen point back into a direction from the camera,
    // which also respects setViewOffset (the off-centre view).
    function place(depth) {
        const frame = 2 * depth * Math.tan((camera.fov * DEG) / 2);   // frame height at that depth
        for (const sprite of sprites) {
            const { spec, base } = sprite.userData;
            base.set(spec.nx, spec.ny, 0.5).applyMatrix4(camera.projectionMatrixInverse);
            base.multiplyScalar(-depth / base.z);
            sprite.userData.frame = frame;
            sprite.position.copy(base);
            sprite.scale.setScalar(spec.size * frame);
        }
    }

    // A slow drift, and a nudge against the pointer: near things move more than far things.
    function update(elapsed, pointer) {
        for (const sprite of sprites) {
            const { spec, base, frame } = sprite.userData;
            const drift = Math.sin((elapsed * TAU) / 8 + spec.phase) * 0.006 * frame;
            sprite.position.set(
                base.x - pointer.x * 0.025 * frame,
                base.y - pointer.y * 0.02 * frame + drift,
                base.z);
        }
    }

    function dispose() {
        textures.cluster.dispose();
        textures.petal.dispose();
    }

    return { place, update, dispose, sprites };
}
