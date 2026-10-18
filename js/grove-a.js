// =========================================================
//  grove-a.js — Concept A "Wake-up": the golden blossom grove
// =========================================================
//  createGrove() builds the hero world for concept A: a low camera inside a
//  sunlit voxel cherry-blossom grove, a glossy river winding back into the
//  haze, round puffy canopies, flowers, falling petals and a warm sun bloom.
//
//  Everything is made in code (no image files): shapes are built from
//  voxels (little cubes) and textures are painted on a <canvas>.
//  The WebGL canvas is transparent, so the pink CSS gradient behind it is
//  our sky.
//
//  Budget for the whole hero (see the team SPEC): < 60 draw calls,
//  < 150k triangles, no post-processing. The tricks that keep us inside it:
//    - InstancedMesh: ONE draw call for thousands of identical blossom cubes
//    - a voxel "mesher" that only builds the cube faces you can actually see
//    - a mirrored copy of the scene under see-through water (cheap reflection)
//    - pre-blurred canvas sprites at the frame edges (fake depth of field)
// =========================================================
import * as THREE from "three";

// ---------- 1. Palette A (tokens from the team spec) ----------
const PALETTE = {
    haze: "#fff2ec",          // sky top / page background
    peach: "#ffd6c4",         // horizon haze
    blossom: "#f6a3bf",
    blossomShade: "#e46f96",
    blossomLight: "#ffd0de",
    rose: "#b8325e",          // deep accent, used very sparingly
    leaf: "#43b047",          // Koko's green: kept OUT of the world so Koko pops
    grass: "#7cc35b",
    grassDark: "#3f8f43",
    river: "#8fcfe0",
    riverDeep: "#4f9fbf",
    bark: "#6b4a3a",
    sun: "#fff4d6",
    gold: "#ffc53d"
};

// The fog colour is the CSS gradient's colour near the horizon line, so far
// things melt into the page background instead of showing a hard edge.
const FOG_COLOUR = "#ffe3d6";

function colour(nameOrHex) {
    return new THREE.Color(PALETTE[nameOrHex] || nameOrHex);
}

function mix(a, b, t) {
    return a.clone().lerp(b, t);
}

// A few in-between colours, all mixed from the tokens above.
const TONES = {
    grassLight: mix(colour("grass"), colour("sun"), 0.38),
    grassFar: mix(colour("grass"), colour("haze"), 0.55),
    grassSide: mix(colour("grassDark"), colour("grass"), 0.25),
    soil: mix(colour("bark"), colour("blossomShade"), 0.22),
    stone: mix(colour("haze"), colour("bark"), 0.16),
    shadow: new THREE.Color("#1f4a2c"),          // shadows on grass: deep green, never grey
    blossomWhite: mix(colour("blossomLight"), colour("haze"), 0.6)
};

// ---------- 2. Grove layout (the numbers you might want to tweak) ----------
const KOKO_SCALE = 0.1;       // 1 Koko voxel = 0.1 world units → Koko ≈ 1.6 long, 1.0 tall
const KOKO_HEIGHT = 1.15;     // Koko's on-screen height in world units (body + bow), for framing
const TERRAIN_VOXEL = 0.5;    // size of a ground block
const TREE_VOXEL = 0.4;       // size of a bark / blossom block
const MIRROR_Y = -0.5;        // reflections are mirrored around this height…
const WATER_Y = -0.47;        // …and the water surface sits just above it
const GRID = { minX: -22, maxX: 22, minZ: -52, maxZ: 16 };   // voxel ground area

const HOME = new THREE.Vector3(0.7, 0, 0.9);   // Koko's hero spot on the bank
const HOME_YAW = -0.35;                        // turn Koko a little towards the camera

// The river's centre line, from behind the camera back into the haze (x, z).
const RIVER_POINTS = [
    [-11, 18], [-6.4, 7.5], [-3.6, 2.6], [-1.3, -1.6], [2.3, -3.6], [4.4, -7.8],
    [2.6, -14.5], [-1.4, -22], [-3.2, -31], [-1.0, -41], [1.2, -52.5]
];

// The path Koko can walk along (on the bank, passing through HOME).
const WALK_POINTS = [
    [-0.4, 3.4], [0.15, 2.1], [0.7, 0.9], [1.5, -0.1], [2.7, -0.7], [3.9, -1.4]
];

// Big round blossom trees. x/z = trunk position, trunk = trunk height,
// rx/ry/rz = canopy radii, lobes = how many puffs make the cloud shape.
const TREES = [
    { x: -4.8, z: -4.6, trunk: 3.3, rx: 3.5, ry: 2.6, rz: 3.1, lobes: 6, lean: 0.5, seed: 11, wide: true },
    { x: 7.0, z: -11.5, trunk: 3.7, rx: 3.8, ry: 2.8, rz: 3.3, lobes: 7, lean: -0.6, seed: 23, wide: true },
    { x: -5.8, z: -19.5, trunk: 3.2, rx: 3.3, ry: 2.5, rz: 3.0, lobes: 6, lean: 0.4, seed: 37, wide: false },
    { x: 4.8, z: -27.5, trunk: 3.0, rx: 3.0, ry: 2.3, rz: 2.8, lobes: 5, lean: -0.4, seed: 41, wide: false },
    { x: -7.2, z: -36.5, trunk: 2.6, rx: 2.6, ry: 2.0, rz: 2.4, lobes: 5, lean: 0.3, seed: 53, wide: false }
];

// How many little things to scatter, per quality level.
const AMOUNTS = {
    high: { tufts: 520, flowerClusters: 22, petals: 120, burst: 28 },
    low: { tufts: 260, flowerClusters: 14, petals: 60, burst: 20 }
};

// Camera "shots": one for phones (portrait), one for desktop (landscape).
// fov = vertical field of view, kokoFraction = Koko's share of the frame
// height, yaw / pitch = where the camera stands around Koko (radians).
const SHOTS = {
    portrait: { fov: 50, kokoFraction: 0.165, yaw: 0.22, pitch: 0.1 },
    landscape: { fov: 36, kokoFraction: 0.145, yaw: 0.3, pitch: 0.085 }
};

// ---------- 3. Tiny helpers: seeded random numbers and smooth noise ----------
// A seeded random generator gives the SAME grove on every load
// (Math.random would scatter the flowers differently each time).
function makeRandom(seed) {
    let a = seed >>> 0;
    return function random() {
        a = (a + 0x6d2b79f5) >>> 0;          // "mulberry32", a tiny classic
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Value noise: random numbers on a grid of whole numbers, smoothly blended in
// between. Gives soft "patches" (colour variation, wobbly edges) in -1..1.
function makeNoise(seed) {
    function lattice(x, y, z) {
        let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440662683) ^ seed;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return (((h ^ (h >>> 16)) >>> 0) / 4294967295) * 2 - 1;
    }
    const ease = (t) => t * t * (3 - 2 * t);
    const lerp = THREE.MathUtils.lerp;
    return function noise(x, y, z) {
        const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
        const u = ease(x - xi), v = ease(y - yi), w = ease(z - zi);
        const x0 = lerp(lerp(lattice(xi, yi, zi), lattice(xi + 1, yi, zi), u),
            lerp(lattice(xi, yi + 1, zi), lattice(xi + 1, yi + 1, zi), u), v);
        const x1 = lerp(lerp(lattice(xi, yi, zi + 1), lattice(xi + 1, yi, zi + 1), u),
            lerp(lattice(xi, yi + 1, zi + 1), lattice(xi + 1, yi + 1, zi + 1), u), v);
        return lerp(x0, x1, w);
    };
}

// GLSL-style smoothstep: 0 below edge0, 1 above edge1, a soft S in between.
function smoothstep(edge0, edge1, x) {
    const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}

function pick(random, list) {
    return list[Math.floor(random() * list.length)];
}

// ---------- 4. Building meshes by hand (and the voxel mesher) ----------
// A "builder" collects vertices; at the end it becomes ONE BufferGeometry.
// One geometry = one draw call, however many little blocks it contains.
function createBuilder() {
    return { positions: [], normals: [], colours: [], indices: [] };
}

// Adds one four-cornered face. corners = 4 [x, y, z] in counter-clockwise
// order seen from the front, tints = 4 THREE.Color (one per corner).
function addQuad(builder, corners, normal, tints, flipDiagonal = false) {
    const start = builder.positions.length / 3;
    for (let i = 0; i < 4; i++) {
        builder.positions.push(corners[i][0], corners[i][1], corners[i][2]);
        builder.normals.push(normal[0], normal[1], normal[2]);
        builder.colours.push(tints[i].r, tints[i].g, tints[i].b);
    }
    // A square is drawn as two triangles; which diagonal we cut along changes
    // how the corner shading blends (see the ambient occlusion note below).
    if (flipDiagonal) {
        builder.indices.push(start + 1, start + 2, start + 3, start + 1, start + 3, start);
    } else {
        builder.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
    }
}

function finishGeometry(builder) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(builder.positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(builder.normals, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(builder.colours, 3));
    geometry.setIndex(builder.indices);
    geometry.computeBoundingSphere();
    return geometry;
}

// The 6 faces of a cube. For each face we list its 4 corners as 0/1 offsets,
// in counter-clockwise order when you look at the face from outside.
function faceCorners(axis, sign) {
    const u = (axis + 1) % 3;
    const w = (axis + 2) % 3;
    const order = sign > 0 ? [[0, 0], [1, 0], [1, 1], [0, 1]] : [[0, 0], [0, 1], [1, 1], [1, 0]];
    return order.map(([cu, cw]) => {
        const corner = [0, 0, 0];
        corner[axis] = sign > 0 ? 1 : 0;
        corner[u] = cu;
        corner[w] = cw;
        return corner;
    });
}

const FACES = [
    { name: "px", axis: 0, sign: 1 }, { name: "nx", axis: 0, sign: -1 },
    { name: "py", axis: 1, sign: 1 }, { name: "ny", axis: 1, sign: -1 },
    { name: "pz", axis: 2, sign: 1 }, { name: "nz", axis: 2, sign: -1 }
].map((face) => {
    const normal = [0, 0, 0];
    normal[face.axis] = face.sign;
    return { ...face, normal, corners: faceCorners(face.axis, face.sign) };
});

// Adds a box from min to max. Bottom corners get colourLow, top corners
// colourHigh (a vertical gradient, e.g. dark grass base → light blade tip).
function addBox(builder, min, max, colourLow, colourHigh, skip = []) {
    for (const face of FACES) {
        if (skip.includes(face.name)) continue;
        const corners = face.corners.map((c) => [
            c[0] ? max[0] : min[0], c[1] ? max[1] : min[1], c[2] ? max[2] : min[2]
        ]);
        const tints = face.corners.map((c) => (c[1] ? colourHigh : colourLow));
        addQuad(builder, corners, face.normal, tints);
    }
}

// A voxel set is a Map from a packed number (x, y, z) to a little object
// { x, y, z, top, side, group }: top/side are the face colours, group says
// which builder (mesh) the voxel's faces go into.
function voxelKey(x, y, z) {
    return (x + 2048) * 16777216 + (y + 2048) * 4096 + (z + 2048);
}

// Brightness for a corner touched by 0..3 neighbouring blocks (see below).
const AO_SHADE = [0.56, 0.72, 0.87, 1.0];

// THE VOXEL MESHER. Turns a voxel set into faces, with two classic tricks:
//  1. Face culling: a face touching another voxel can never be seen, so we
//     skip it. A solid wall of blocks costs only its outside skin.
//  2. Baked ambient occlusion ("AO"): corners tucked into a crease get less
//     sky light. For each corner of a face we count the blocks touching it
//     (side1, side2, corner) and darken the vertex colour. This is what
//     gives the soft, studio look at no runtime cost.
function meshVoxels(voxels, builders, { size, origin = [0, 0, 0], skip = [] }) {
    const has = (x, y, z) => voxels.has(voxelKey(x, y, z));
    for (const v of voxels.values()) {
        for (const face of FACES) {
            if (skip.includes(face.name)) continue;
            const n = face.normal;
            const fx = v.x + n[0], fy = v.y + n[1], fz = v.z + n[2];   // the cell in front of this face
            if (has(fx, fy, fz)) continue;                              // covered → invisible → skip

            const u = (face.axis + 1) % 3;
            const w = (face.axis + 2) % 3;
            const tint = face.name === "py" ? v.top : v.side;
            const corners = [];
            const tints = [];
            const ao = [];
            for (const c of face.corners) {
                const stepU = [0, 0, 0];
                const stepW = [0, 0, 0];
                stepU[u] = c[u] ? 1 : -1;
                stepW[w] = c[w] ? 1 : -1;
                const side1 = has(fx + stepU[0], fy + stepU[1], fz + stepU[2]);
                const side2 = has(fx + stepW[0], fy + stepW[1], fz + stepW[2]);
                const corner = has(fx + stepU[0] + stepW[0], fy + stepU[1] + stepW[1], fz + stepU[2] + stepW[2]);
                const level = side1 && side2 ? 0 : 3 - (side1 + side2 + corner);
                ao.push(level);
                corners.push([
                    (v.x + c[0]) * size + origin[0],
                    (v.y + c[1]) * size + origin[1],
                    (v.z + c[2]) * size + origin[2]
                ]);
                tints.push(tint.clone().multiplyScalar(AO_SHADE[level]));
            }
            // cut the square along its brighter diagonal so a dark corner stays a soft corner
            const flip = ao[0] + ao[2] < ao[1] + ao[3];
            addQuad(builders[v.group || 0], corners, n, tints, flip);
        }
    }
}

// ---------- 5. The river ----------
// The river is a smooth curve through RIVER_POINTS (Catmull-Rom = a spline
// that passes through every point). We sample it into many small points so
// we can ask "how far is (x, z) from the river, and on which bank?".
function createRiver() {
    const curve = new THREE.CatmullRomCurve3(
        RIVER_POINTS.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, "centripetal");
    const count = 600;
    const samples = curve.getSpacedPoints(count);
    const tangents = samples.map((p, i) => curve.getTangentAt(i / count));

    function halfWidthAt(z) {
        const near = smoothstep(-46, 4, z);                 // 0 far away … 1 close to us
        return 1.1 + 0.5 * near + 0.12 * Math.sin(z * 0.43 + 1.3);
    }

    // distance from the centre line, and side = +1 right bank / -1 left bank
    // (looking downstream, i.e. away from the camera)
    function query(x, z) {
        let best = Infinity;
        let bestIndex = 0;
        for (let i = 0; i < samples.length; i++) {
            const dz = z - samples[i].z;
            if (dz * dz >= best) continue;                  // cheap early-out
            const dx = x - samples[i].x;
            const d = dx * dx + dz * dz;
            if (d < best) {
                best = d;
                bestIndex = i;
            }
        }
        const s = samples[bestIndex];
        const t = tangents[bestIndex];
        const cross = t.z * (x - s.x) - t.x * (z - s.z);
        return { distance: Math.sqrt(best), side: cross < 0 ? 1 : -1, z: s.z };
    }

    function bankDistance(x, z) {
        const q = query(x, z);
        return { bank: q.distance - halfWidthAt(q.z), side: q.side };
    }

    return { curve, halfWidthAt, query, bankDistance };
}

// ---------- 6. Terrain: grass terraces, banks, and the flat ground beyond ----------
// The ground is a grid of columns of TERRAIN_VOXEL blocks. Where the river
// runs there is NO column at all, so we can look down through the water into
// the mirrored world below (the reflection, section 9).
function petalCarpet(x, z, noise) {
    // fallen petals under each tree tint the grass pink (and make Koko pop)
    let amount = 0;
    for (const tree of TREES) {
        const d = Math.hypot((x - tree.x) / 1.1, z - tree.z);
        amount = Math.max(amount, smoothstep(tree.rx * 1.35, tree.rx * 0.3, d));
    }
    return amount * (0.62 + 0.18 * noise(x * 0.35, 3.1, z * 0.35));
}

function buildTerrain(river, noise, random) {
    const cols = Math.round((GRID.maxX - GRID.minX) / TERRAIN_VOXEL);
    const rows = Math.round((GRID.maxZ - GRID.minZ) / TERRAIN_VOXEL);
    const levels = new Int8Array(cols * rows);           // blocks per column (0 = river)
    const bankOf = new Float32Array(cols * rows);
    const voxels = new Map();

    // 6a. decide how tall each column is
    for (let k = 0; k < rows; k++) {
        for (let i = 0; i < cols; i++) {
            const x = GRID.minX + (i + 0.5) * TERRAIN_VOXEL;
            const z = GRID.minZ + (k + 0.5) * TERRAIN_VOXEL;
            const { bank, side } = river.bankDistance(x, z);
            bankOf[i + k * cols] = bank;
            if (bank < 0) continue;                         // water: leave the column empty

            // terraces step up as we move away from the river (more on the left bank)
            const wobble = noise(x * 0.16, 0.5, z * 0.16) * 1.6;
            let steps = side < 0
                ? Math.floor(THREE.MathUtils.clamp((bank - 3.4 + wobble) / 2.8, 0, 3))
                : Math.floor(THREE.MathUtils.clamp((bank - 6.0 + wobble) / 3.4, 0, 2));
            // keep Koko's bank flat, and fade terraces out at the grid's edges
            const nearHome = Math.hypot(x - HOME.x, z - HOME.z);
            steps = Math.min(steps, Math.floor(Math.max(0, nearHome - 4.5) / 1.6));
            const edge = Math.min(x - GRID.minX, GRID.maxX - x, z - GRID.minZ, GRID.maxZ - z);
            steps = Math.min(steps, Math.floor(edge / 2.2));
            levels[i + k * cols] = 1 + Math.max(0, steps);
        }
    }

    // 6b. fill the columns with coloured voxels
    for (let k = 0; k < rows; k++) {
        for (let i = 0; i < cols; i++) {
            const level = levels[i + k * cols];
            if (level === 0) continue;
            const x = GRID.minX + (i + 0.5) * TERRAIN_VOXEL;
            const z = GRID.minZ + (k + 0.5) * TERRAIN_VOXEL;
            const bank = bankOf[i + k * cols];

            // grass colour: soft patches, darker at the water's edge, pink under trees,
            // lighter and airier far away (so the haze never turns it khaki)
            const patch = noise(x * 0.11, 9.0, z * 0.11);
            const top = mix(colour("grass"), TONES.grassLight, 0.3 + 0.28 * patch);
            top.lerp(colour("grassDark"), 0.32 * smoothstep(1.0, 0.0, bank));
            top.lerp(colour("blossomLight"), petalCarpet(x, z, noise));
            top.lerp(TONES.grassFar, 0.45 * smoothstep(-10, -40, z));
            top.multiplyScalar(0.985 + random() * 0.03);    // a whisper of per-block texture

            const group = bank < 2.6 ? 1 : 0;               // 1 = bank blocks (also reflected)
            for (let j = 0; j < level; j++) {
                const isTop = j === level - 1;
                voxels.set(voxelKey(i, j, k), {
                    x: i, y: j, z: k, group,
                    top,
                    side: isTop ? TONES.grassSide : TONES.soil
                });
            }
        }
    }

    // 6c. mesh: land and bank go into two meshes (only the bank is mirrored)
    const land = createBuilder();
    const bankBuilder = createBuilder();
    meshVoxels(voxels, [land, bankBuilder], {
        size: TERRAIN_VOXEL,
        origin: [GRID.minX, MIRROR_Y, GRID.minZ],
        skip: ["ny"]                                       // nobody looks at the ground from below
    });

    // 6d. flat outer ground beyond the grid (left, right, and behind the camera)
    const far = TONES.grassFar;
    const flat = (x0, z0, x1, z1) => addQuad(land,
        [[x0, 0, z0], [x0, 0, z1], [x1, 0, z1], [x1, 0, z0]], [0, 1, 0], [far, far, far, far]);
    flat(-160, GRID.minZ, GRID.minX, GRID.maxZ + 40);
    flat(GRID.maxX, GRID.minZ, 160, GRID.maxZ + 40);
    flat(GRID.minX, GRID.maxZ, GRID.maxX, GRID.maxZ + 40);

    // ground height at any (x, z): top of the column, or the water surface
    function groundY(x, z) {
        const i = Math.floor((x - GRID.minX) / TERRAIN_VOXEL);
        const k = Math.floor((z - GRID.minZ) / TERRAIN_VOXEL);
        if (i < 0 || k < 0 || i >= cols || k >= rows) return 0;
        const level = levels[i + k * cols];
        return level === 0 ? WATER_Y : MIRROR_Y + level * TERRAIN_VOXEL;
    }

    function isWater(x, z) {
        return groundY(x, z) === WATER_Y;
    }

    return {
        landGeometry: finishGeometry(land),
        bankGeometry: finishGeometry(bankBuilder),
        groundY,
        isWater
    };
}

// ---------- 7. Trees: chunky bark trunks + round puffy blossom canopies ----------
// Each canopy is a soft "cloud" made of a few overlapping squashed spheres
// (puffs), roughened with noise, then filled with blossom voxels.
function makeCanopyPuffs(tree, baseY, random) {
    const centre = new THREE.Vector3(tree.x + tree.lean * 0.8, baseY + tree.trunk + tree.ry * 0.45, tree.z);
    const puffs = [{ c: centre, r: new THREE.Vector3(tree.rx, tree.ry, tree.rz) }];
    for (let i = 0; i < tree.lobes; i++) {
        const angle = (i / tree.lobes) * Math.PI * 2 + random() * 0.9;
        const lift = -0.35 + random() * 1.0;               // a few droop, most sit higher
        const reach = 0.55 + random() * 0.25;
        const size = 0.42 + random() * 0.2;
        puffs.push({
            c: centre.clone().add(new THREE.Vector3(
                Math.cos(angle) * tree.rx * reach, lift * tree.ry * 0.65, Math.sin(angle) * tree.rz * reach)),
            r: new THREE.Vector3(tree.rx * size, tree.ry * size * 1.1, tree.rz * size)
        });
    }
    // a crown puff on top keeps the silhouette round and tall
    puffs.push({
        c: centre.clone().add(new THREE.Vector3(-tree.lean * 0.3, tree.ry * 0.5, 0)),
        r: new THREE.Vector3(tree.rx * 0.62, tree.ry * 0.62, tree.rz * 0.62)
    });
    const bottomY = centre.y - tree.ry * 0.62;               // cherry canopies have a flatter underside
    return { centre, puffs, bottomY, topY: centre.y + tree.ry * 1.15 };
}

function insideCanopy(shape, x, y, z, noise) {
    if (y < shape.bottomY) return false;
    let best = Infinity;
    for (const puff of shape.puffs) {
        const dx = (x - puff.c.x) / puff.r.x;
        const dy = (y - puff.c.y) / puff.r.y;
        const dz = (z - puff.c.z) / puff.r.z;
        best = Math.min(best, dx * dx + dy * dy + dz * dz);
    }
    return Math.sqrt(best) + noise(x * 0.42, y * 0.42, z * 0.42) * 0.16 < 1;
}

// Fills a canopy with voxels of the given size and keeps only the outer skin
// we can see. Our camera stays low in front of the trees, so a blossom block
// only matters if its underside, front or a side is open to the air.
function voxelizeCanopy(shape, size, noise) {
    const inside = new Set();
    const minI = Math.floor((shape.centre.x - 9) / size), maxI = Math.ceil((shape.centre.x + 9) / size);
    const minJ = Math.floor(shape.bottomY / size), maxJ = Math.ceil(shape.topY / size);
    const minK = Math.floor((shape.centre.z - 9) / size), maxK = Math.ceil((shape.centre.z + 9) / size);
    for (let i = minI; i <= maxI; i++) {
        for (let j = minJ; j <= maxJ; j++) {
            for (let k = minK; k <= maxK; k++) {
                if (insideCanopy(shape, (i + 0.5) * size, (j + 0.5) * size, (k + 0.5) * size, noise)) {
                    inside.add(voxelKey(i, j, k));
                }
            }
        }
    }
    const visible = [];
    for (let i = minI; i <= maxI; i++) {
        for (let j = minJ; j <= maxJ; j++) {
            for (let k = minK; k <= maxK; k++) {
                if (!inside.has(voxelKey(i, j, k))) continue;
                const open = !inside.has(voxelKey(i, j - 1, k)) || !inside.has(voxelKey(i, j, k + 1)) ||
                    !inside.has(voxelKey(i - 1, j, k)) || !inside.has(voxelKey(i + 1, j, k));
                if (open) visible.push(new THREE.Vector3((i + 0.5) * size, (j + 0.5) * size, (k + 0.5) * size));
            }
        }
    }
    return visible;
}

// Colour of one blossom block: deep pink underneath → light pink on top,
// soft patches from noise, a touch lighter on the sun side (left).
function blossomTint(p, shape, tree, noise, random) {
    const t = THREE.MathUtils.clamp((p.y - shape.bottomY) / (shape.topY - shape.bottomY), 0, 1);
    const tint = t < 0.42
        ? mix(colour("blossomShade"), colour("blossom"), t / 0.42)
        : mix(colour("blossom"), colour("blossomLight"), (t - 0.42) / 0.58);
    const patch = noise(p.x * 0.32 + 17, p.y * 0.32, p.z * 0.32);
    tint.lerp(patch > 0 ? colour("blossomLight") : colour("blossomShade"), Math.abs(patch) * 0.3);
    const sunSide = THREE.MathUtils.clamp((shape.centre.x - p.x) / tree.rx, 0, 1);
    tint.lerp(colour("blossomLight"), sunSide * t * 0.25);
    if (t > 0.55 && random() < 0.05) tint.lerp(TONES.blossomWhite, 0.6);   // sparkle
    return tint.multiplyScalar(0.96 + random() * 0.07);
}

// A cube that only has the faces our low camera can see: bottom, front, left
// and right (no top, no back) — a third fewer triangles per blossom block.
function makeBlossomBlockGeometry(size) {
    const builder = createBuilder();
    const white = new THREE.Color(1, 1, 1);
    const h = size / 2;
    addBox(builder, [-h, -h, -h], [h, h, h], white, white, ["py", "nz"]);
    return finishGeometry(builder);
}

function makeBlossomMesh(trees, size, noise, random) {
    const blocks = [];
    for (const tree of trees) {
        for (const p of voxelizeCanopy(tree.shape, size, noise)) {
            blocks.push({ p, tint: blossomTint(p, tree.shape, tree.def, noise, random) });
        }
    }
    const geometry = makeBlossomBlockGeometry(size);
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const mesh = new THREE.InstancedMesh(geometry, material, blocks.length);
    const matrix = new THREE.Matrix4();
    blocks.forEach((block, index) => {
        matrix.makeTranslation(block.p.x, block.p.y, block.p.z);
        mesh.setMatrixAt(index, matrix);
        mesh.setColorAt(index, block.tint);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    return mesh;
}

// Trunk: a chunky column of bark blocks that leans a little, with root flares
// at the bottom and a few branches climbing into the canopy.
function addTrunk(builder, tree, baseY, noise, random) {
    const voxels = new Map();
    const height = Math.round(tree.trunk / TREE_VOXEL) + 2;
    const half = tree.wide ? 1 : 0;                        // 3 blocks wide or 2 blocks wide
    const bark = colour("bark");
    const put = (x, y, z) => {
        const streak = noise(x * 0.9 + tree.seed, 0.3, z * 0.9) * 0.1;
        const shade = 0.92 + streak + (y / height) * 0.12 + random() * 0.04;
        const tint = bark.clone().multiplyScalar(shade);
        voxels.set(voxelKey(x, y, z), { x, y, z, top: tint, side: tint });
    };
    for (let y = 0; y < height; y++) {
        const lean = Math.round(tree.lean * 2 * (y / height) * (y / height));
        for (let x = -half; x <= 1; x++) {
            for (let z = -half; z <= 1; z++) put(x + lean, y, z);
        }
    }
    // root flares: one block sticking out on each side at the bottom
    for (const [dx, dz] of [[-half - 1, 0], [2, 1], [0, -half - 1], [1, 2], [-half - 1, 1]]) {
        put(dx, 0, dz);
        if (random() < 0.5) put(dx, 1, dz);
    }
    // branches: climb up and outwards into the canopy
    const branchStart = Math.round(height * 0.62);
    for (let b = 0; b < 3; b++) {
        const angle = b * 2.1 + tree.seed;
        const lean = Math.round(tree.lean * 2);
        for (let s = 1; s <= 5; s++) {
            const x = lean + Math.round(Math.cos(angle) * s * 0.9);
            const z = Math.round(Math.sin(angle) * s * 0.7);
            put(x, branchStart + s, z);
            if (s < 3) put(x, branchStart + s - 1, z);
        }
    }
    meshVoxels(voxels, [builder], {
        size: TREE_VOXEL,
        origin: [tree.x - TREE_VOXEL, baseY - TREE_VOXEL, tree.z - TREE_VOXEL],
        skip: ["ny"]
    });
}

// ---------- 8. Grass tufts, flowers and stepping stones ----------
function makeTuftGeometry() {
    const builder = createBuilder();
    const base = colour("grassDark");
    const tip = TONES.grassLight;
    const blades = [[-0.05, 0.02, 0.34], [0.045, -0.03, 0.26], [0.0, 0.06, 0.21], [0.07, 0.05, 0.16]];
    for (const [x, z, h] of blades) {
        addBox(builder, [x - 0.025, 0, z - 0.025], [x + 0.025, h, z + 0.025], base, tip, ["ny"]);
    }
    return finishGeometry(builder);
}

// A flower head: a little plus of 5 cubes. Petals are white here and get
// their real colour per instance; the centre is golden.
function makeFlowerGeometry() {
    const builder = createBuilder();
    const white = new THREE.Color(1, 1, 1);
    const centre = mix(colour("gold"), white, 0.25);
    const s = 0.045;
    for (const [x, z] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        addBox(builder, [x * s - s / 2, -s / 2, z * s - s / 2], [x * s + s / 2, s / 2, z * s + s / 2], white, white, ["ny"]);
    }
    addBox(builder, [-s / 2, -s / 2, -s / 2], [s / 2, s * 0.8, s / 2], centre, centre, ["ny"]);
    return finishGeometry(builder);
}

// A round pebble: a profile curve spun around the Y axis (LatheGeometry).
function makeStoneGeometry() {
    const profile = [[0.0, -0.16], [0.3, -0.14], [0.42, -0.02], [0.4, 0.08], [0.28, 0.16], [0.0, 0.19]]
        .map(([r, y]) => new THREE.Vector2(r, y));
    return new THREE.LatheGeometry(profile, 14);
}

function scatterGreenery(terrain, river, noise, random, amounts) {
    const tufts = [];
    const flowers = [];
    const nearPath = (x, z) => WALK_POINTS.some(([px, pz]) => Math.hypot(x - px, z - pz) < 0.55);

    // how much grass wants to grow here (0..1)
    function density(x, z) {
        const { bank } = river.bankDistance(x, z);
        let d = 0.12 + 0.75 * smoothstep(1.6, 0.1, bank);   // lush along the water
        for (const tree of TREES) d += 0.55 * smoothstep(2.6, 0.9, Math.hypot(x - tree.x, z - tree.z));
        d *= smoothstep(1.0, 2.2, Math.hypot(x - HOME.x, z - HOME.z));   // keep Koko's feet clear
        return d;
    }

    let attempts = 0;
    while (tufts.length < amounts.tufts && attempts < amounts.tufts * 30) {
        attempts++;
        const x = -13 + random() * 26;
        const z = 12 - Math.pow(random(), 1.35) * 46;        // more of them close to the camera
        if (terrain.isWater(x, z) || nearPath(x, z)) continue;
        if (random() > density(x, z)) continue;
        tufts.push({ x, y: terrain.groundY(x, z), z, scale: 0.75 + random() * 0.6, yaw: random() * 6.28 });
    }

    // flowers grow in small clusters, each flower standing on its own tuft
    const flowerColours = [
        [colour("gold"), 0.36], [colour("blossomLight"), 0.24], [colour("sun"), 0.18],
        [colour("blossom"), 0.16], [colour("rose"), 0.06]
    ];
    const pickFlowerColour = () => {
        let r = random();
        for (const [c, weight] of flowerColours) {
            if ((r -= weight) <= 0) return c;
        }
        return flowerColours[0][0];
    };
    let clusters = 0;
    attempts = 0;
    while (clusters < amounts.flowerClusters && attempts < 4000) {
        attempts++;
        const cx = -10 + random() * 20;
        const cz = 9 - Math.pow(random(), 1.2) * 34;
        if (terrain.isWater(cx, cz) || random() > density(cx, cz) * 1.3) continue;
        if (Math.hypot(cx - HOME.x, cz - HOME.z) < 1.8) continue;
        clusters++;
        const main = pickFlowerColour();
        const n = 4 + Math.floor(random() * 6);
        for (let f = 0; f < n; f++) {
            const x = cx + (random() - 0.5) * 1.3;
            const z = cz + (random() - 0.5) * 1.0;
            if (terrain.isWater(x, z) || nearPath(x, z)) continue;
            const y = terrain.groundY(x, z);
            const stem = 0.13 + random() * 0.12;
            flowers.push({ x, y: y + stem, z, yaw: random() * 6.28, scale: 0.85 + random() * 0.4,
                tint: random() < 0.8 ? main : pickFlowerColour() });
            tufts.push({ x, y, z, scale: stem / 0.3, yaw: random() * 6.28 });
        }
    }
    return { tufts, flowers };
}

function makeInstanced(geometry, material, items, tintOf) {
    const mesh = new THREE.InstancedMesh(geometry, material, items.length);
    const dummy = new THREE.Object3D();
    items.forEach((item, index) => {
        dummy.position.set(item.x, item.y, item.z);
        dummy.rotation.set(0, item.yaw || 0, 0);
        dummy.scale.set(item.sx || item.scale || 1, item.sy || item.scale || 1, item.sz || item.scale || 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
        if (tintOf) mesh.setColorAt(index, tintOf(item, index));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    return mesh;
}

// ---------- 9. Water, a tiny sky for reflections, and the mirror world ----------
// The water is a ribbon that follows the river, a little wider than the
// channel (the ground hides the extra). Deeper blue down the middle.
function makeWaterGeometry(river) {
    const builder = createBuilder();
    const steps = 180;
    const across = [-1, -0.5, 0, 0.5, 1];
    const rows = [];
    for (let s = 0; s <= steps; s++) {
        const p = river.curve.getPointAt(s / steps);
        const t = river.curve.getTangentAt(s / steps);
        const half = river.halfWidthAt(p.z) + 0.8;
        rows.push(across.map((a) => [p.x - t.z * a * half, WATER_Y, p.z + t.x * a * half]));
    }
    const tintAt = (a) => mix(colour("river"), colour("riverDeep"), (1 - Math.abs(a)) * 0.45);
    for (let s = 0; s < steps; s++) {
        for (let a = 0; a < across.length - 1; a++) {
            let corners = [rows[s][a], rows[s][a + 1], rows[s + 1][a + 1], rows[s + 1][a]];
            let tints = [tintAt(across[a]), tintAt(across[a + 1]), tintAt(across[a + 1]), tintAt(across[a])];
            // make sure the face points up (counter-clockwise seen from above)
            const e1x = corners[1][0] - corners[0][0], e1z = corners[1][2] - corners[0][2];
            const e2x = corners[2][0] - corners[0][0], e2z = corners[2][2] - corners[0][2];
            if (e1z * e2x - e1x * e2z < 0) {
                corners = corners.reverse();
                tints = tints.reverse();
            }
            addQuad(builder, corners, [0, 1, 0], tints);
        }
    }
    return finishGeometry(builder);
}

// An environment map = a picture of the surroundings that shiny materials
// reflect. We build a tiny sky (a gradient sphere + a bright sun spot) and
// let PMREMGenerator turn it into a reflection map for the water.
function makeSkyEnvironment(renderer) {
    const skyScene = new THREE.Scene();
    const sphere = new THREE.SphereGeometry(10, 32, 16);
    const top = colour("haze"), horizon = colour("peach"), below = colour("blossomLight");
    const tints = [];
    const position = sphere.attributes.position;
    for (let i = 0; i < position.count; i++) {
        const h = position.getY(i) / 10;                    // -1 bottom … 1 top
        const c = h > 0 ? mix(horizon, top, Math.pow(h, 0.6)) : mix(horizon, below, Math.min(1, -h * 2));
        tints.push(c.r, c.g, c.b);
    }
    sphere.setAttribute("color", new THREE.Float32BufferAttribute(tints, 3));
    const skyMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
    skyScene.add(new THREE.Mesh(sphere, skyMaterial));
    const sunGeometry = new THREE.SphereGeometry(1.4, 16, 8);
    const sunMaterial = new THREE.MeshBasicMaterial({ color: colour("sun").multiplyScalar(2.5) });
    const sunBall = new THREE.Mesh(sunGeometry, sunMaterial);
    sunBall.position.set(-5, 5.5, -6.5);
    skyScene.add(sunBall);

    // (PMREM renders with the page's renderer, so we put its clear colour back afterwards)
    const oldClear = renderer.getClearColor(new THREE.Color());
    const oldAlpha = renderer.getClearAlpha();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const target = pmrem.fromScene(skyScene, 0.02);
    pmrem.dispose();
    renderer.setClearColor(oldClear, oldAlpha);
    sphere.dispose();
    skyMaterial.dispose();
    sunGeometry.dispose();
    sunMaterial.dispose();
    return target;
}

// ---------- 10. Canvas textures: sun bloom, light shafts, shadows, haze, edge blur ----------
function makeCanvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return [canvas, canvas.getContext("2d")];
}

function canvasTexture(canvas) {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

// THREE.Color stores "linear" values for lighting maths; a <canvas> wants
// ordinary sRGB, so we convert back before building the CSS colour string.
function rgbaFromToken(nameOrHex, alpha) {
    const c = colour(nameOrHex).convertLinearToSRGB();
    return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${alpha})`;
}

function makeSunTexture() {
    const [canvas, ctx] = makeCanvas(256, 256);
    const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0.0, "rgba(255, 253, 246, 1)");
    g.addColorStop(0.1, "rgba(255, 250, 236, 0.95)");
    g.addColorStop(0.24, rgbaFromToken("sun", 0.55));
    g.addColorStop(0.45, "rgba(255, 222, 176, 0.22)");
    g.addColorStop(0.7, "rgba(255, 206, 178, 0.07)");
    g.addColorStop(1.0, "rgba(255, 206, 178, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    return canvasTexture(canvas);
}

// a long soft beam: transparent at the edges, fading out along its length
function makeShaftTexture() {
    const [canvas, ctx] = makeCanvas(64, 256);
    const across = ctx.createLinearGradient(0, 0, 64, 0);
    across.addColorStop(0, "rgba(255, 244, 214, 0)");
    across.addColorStop(0.5, "rgba(255, 244, 214, 1)");
    across.addColorStop(1, "rgba(255, 244, 214, 0)");
    ctx.fillStyle = across;
    ctx.fillRect(0, 0, 64, 256);
    ctx.globalCompositeOperation = "destination-in";
    const along = ctx.createLinearGradient(0, 0, 0, 256);
    along.addColorStop(0, "rgba(0, 0, 0, 0.0)");
    along.addColorStop(0.15, "rgba(0, 0, 0, 1)");
    along.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = along;
    ctx.fillRect(0, 0, 64, 256);
    return canvasTexture(canvas);
}

// a soft round blob, white in the middle: used as an alpha map for shadows
function makeBlobTexture() {
    const [canvas, ctx] = makeCanvas(128, 128);
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255, 255, 255, 1)");
    g.addColorStop(0.45, "rgba(170, 170, 170, 1)");
    g.addColorStop(1, "rgba(0, 0, 0, 1)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(canvas);
}

// horizon haze: fog colour at the bottom fading to nothing at the top
function makeHazeTexture() {
    const [canvas, ctx] = makeCanvas(4, 128);
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, rgbaFromToken(FOG_COLOUR, 0));
    g.addColorStop(0.55, rgbaFromToken(FOG_COLOUR, 0.55));
    g.addColorStop(0.8, rgbaFromToken(FOG_COLOUR, 0.92));
    g.addColorStop(1, rgbaFromToken(FOG_COLOUR, 0.92));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 4, 128);
    return canvasTexture(canvas);
}

// Blurring a canvas drawing: ctx.filter = "blur()" is the easy way. Older
// Safari ignores it, so there we shrink the picture and stretch it back up,
// which blurs it too (the browser smooths the enlarged pixels).
const CANVAS_FILTER_WORKS = (() => {
    try {
        const ctx = makeCanvas(1, 1)[1];
        ctx.filter = "blur(2px)";
        return ctx.filter === "blur(2px)";
    } catch (error) {
        return false;
    }
})();

function drawBlurred(ctx, source, x, y, size, radius) {
    if (CANVAS_FILTER_WORKS) {
        ctx.filter = `blur(${radius}px)`;
        ctx.drawImage(source, x, y, size, size);
        ctx.filter = "none";
        return;
    }
    const small = Math.max(8, Math.round(size / (radius * 0.9)));
    const [tiny, tinyCtx] = makeCanvas(small, small);
    tinyCtx.drawImage(source, 0, 0, small, small);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tiny, x, y, size, size);
}

// Paints the out-of-focus things that sit right in front of the lens:
// cell 0 = a pink blossom clump, cell 1 = golden flowers in grass,
// cell 2 = the edge of a canopy. Drawn sharp, then blurred into an atlas
// (one texture holding several pictures side by side).
function makeEdgeAtlas(random) {
    const cell = 256;
    const [atlas, actx] = makeCanvas(cell * 3, cell);
    const [paint, pctx] = makeCanvas(cell, cell);

    const blossomInks = ["blossomLight", "blossom", "blossom", "blossomShade", "blossomLight"];
    function clump(cx, cy, rx, ry, count, minR, maxR, inks) {
        for (let i = 0; i < count; i++) {
            const a = random() * Math.PI * 2;
            const d = Math.sqrt(random());
            pctx.fillStyle = rgbaFromToken(pick(random, inks), 0.95);
            pctx.beginPath();
            pctx.arc(cx + Math.cos(a) * d * rx, cy + Math.sin(a) * d * ry, minR + random() * (maxR - minR), 0, Math.PI * 2);
            pctx.fill();
        }
    }

    // cell 0: pink blossom clump
    pctx.clearRect(0, 0, cell, cell);
    clump(128, 140, 74, 58, 46, 12, 26, blossomInks);
    drawBlurred(actx, paint, 0, 0, cell, 9);

    // cell 1: golden flowers in out-of-focus grass
    pctx.clearRect(0, 0, cell, cell);
    for (let i = 0; i < 16; i++) {
        pctx.save();
        pctx.translate(60 + random() * 140, 230);
        pctx.rotate((random() - 0.5) * 0.9);
        pctx.fillStyle = rgbaFromToken(random() < 0.5 ? "grass" : "grassDark", 0.9);
        pctx.fillRect(-7, -120 - random() * 60, 14, 160);
        pctx.restore();
    }
    for (const [fx, fy, r] of [[92, 118, 26], [150, 92, 22], [128, 160, 20], [70, 176, 16], [186, 150, 18]]) {
        for (let p = 0; p < 5; p++) {
            const a = (p / 5) * Math.PI * 2;
            pctx.fillStyle = rgbaFromToken(random() < 0.7 ? "gold" : "#ffa25a", 1);
            pctx.beginPath();
            pctx.arc(fx + Math.cos(a) * r * 0.55, fy + Math.sin(a) * r * 0.55, r * 0.5, 0, Math.PI * 2);
            pctx.fill();
        }
        pctx.fillStyle = rgbaFromToken("rose", 0.9);
        pctx.beginPath();
        pctx.arc(fx, fy, r * 0.22, 0, Math.PI * 2);
        pctx.fill();
    }
    drawBlurred(actx, paint, cell, 0, cell, 8);

    // cell 2: canopy edge (big soft pink mass)
    pctx.clearRect(0, 0, cell, cell);
    clump(150, 110, 90, 80, 60, 16, 30, ["blossomLight", "blossom", "blossomLight", "blossomShade"]);
    drawBlurred(actx, paint, cell * 2, 0, cell, 11);

    return canvasTexture(atlas);
}

// ---------- 11. Falling petals ----------
// One InstancedMesh holds every petal: the ambient ones that drift down all
// the time, plus a small pool used for bursts (coin collects).
function makePetalGeometry() {
    const shape = new THREE.Shape();
    shape.moveTo(0, -0.065);
    shape.quadraticCurveTo(0.065, -0.02, 0.04, 0.05);
    shape.lineTo(0, 0.032);                                 // the little notch at the tip
    shape.lineTo(-0.04, 0.05);
    shape.quadraticCurveTo(-0.065, -0.02, 0, -0.065);
    return new THREE.ShapeGeometry(shape, 3);
}

function createPetals(amounts, random) {
    const ambient = amounts.petals;
    const pool = amounts.burst;
    const geometry = makePetalGeometry();
    const material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
    const mesh = new THREE.InstancedMesh(geometry, material, ambient + pool);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);   // we rewrite these every frame
    mesh.frustumCulled = false;                             // petals move, so skip the bounds test
    const tints = [colour("blossomLight"), colour("blossom"), TONES.blossomWhite, colour("blossomLight")];
    for (let i = 0; i < ambient + pool; i++) mesh.setColorAt(i, pick(random, tints));

    // the box petals fall through, around Koko and towards the camera
    const box = { x: HOME.x - 1.0, y: 4.2, z: HOME.z - 2.5, hx: 6.5, hy: 4.2, hz: 8 };
    const petals = [];
    for (let i = 0; i < ambient; i++) {
        petals.push({
            x: box.x + (random() * 2 - 1) * box.hx,
            y: box.y + (random() * 2 - 1) * box.hy,
            z: box.z + (random() * 2 - 1) * box.hz,
            speed: 0.32 + random() * 0.3,
            sway: 0.2 + random() * 0.35,
            swayRate: 0.7 + random() * 0.9,
            phase: random() * 6.28,
            spin: [0.6 + random() * 1.4, 0.4 + random() * 1.2, 0.3 + random()]
        });
    }
    const bursts = [];
    for (let i = 0; i < pool; i++) bursts.push({ life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, phase: random() * 6.28 });

    const dummy = new THREE.Object3D();
    let density = 0.7;                                       // share of ambient petals in the air
    let wind = 0.25;

    function write(index, x, y, z, rx, ry, rz, scale) {
        dummy.position.set(x, y, z);
        dummy.rotation.set(rx, ry, rz);
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
    }

    function update(dt, elapsed) {
        const active = Math.round(ambient * density);
        petals.forEach((p, i) => {
            if (i >= active) {
                write(i, 0, -50, 0, 0, 0, 0, 0);             // parked out of sight
                return;
            }
            p.y -= p.speed * (0.8 + density * 0.4) * dt;
            p.x += (wind + Math.sin(elapsed * p.swayRate + p.phase) * p.sway) * dt;
            p.z += Math.cos(elapsed * p.swayRate * 0.7 + p.phase) * p.sway * 0.4 * dt;
            if (p.y < -0.2) {                                // landed: start again at the top
                p.y = box.y + box.hy;
                p.x = box.x + (random() * 2 - 1) * box.hx;
                p.z = box.z + (random() * 2 - 1) * box.hz;
            }
            if (p.x > box.x + box.hx) p.x -= box.hx * 2;     // blown out of the box: wrap around
            const t = elapsed + p.phase;
            write(i, p.x, p.y, p.z, t * p.spin[0], t * p.spin[1], t * p.spin[2], 1);
        });
        bursts.forEach((b, i) => {
            const index = ambient + i;
            if (b.life <= 0) {
                write(index, 0, -50, 0, 0, 0, 0, 0);
                return;
            }
            b.life -= dt;
            b.vy -= 2.2 * dt;                                // gravity
            b.vx *= 1 - 1.5 * dt;                            // air drag
            b.vz *= 1 - 1.5 * dt;
            b.vy *= 1 - 0.8 * dt;
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            b.z += b.vz * dt;
            const t = elapsed * 3 + b.phase;
            write(index, b.x, b.y, b.z, t, t * 0.7, t * 0.4, Math.min(1, b.life * 2.5) * 1.2);
        });
        mesh.instanceMatrix.needsUpdate = true;
    }

    function burst(point) {
        let launched = 0;
        for (const b of bursts) {
            if (b.life > 0 || launched >= 16) continue;
            const a = random() * Math.PI * 2;
            const speed = 0.8 + random() * 1.4;
            Object.assign(b, {
                life: 1.0 + random() * 0.6,
                x: point.x, y: point.y, z: point.z,
                vx: Math.cos(a) * speed, vy: 1.2 + random() * 1.4, vz: Math.sin(a) * speed
            });
            launched++;
        }
    }

    function setWeather(t) {
        density = 0.7 + 0.3 * THREE.MathUtils.clamp(t, 0, 1);
        wind = 0.25 + 0.5 * THREE.MathUtils.clamp(t, 0, 1);
    }

    return { mesh, update, burst, setWeather, geometry, material };
}

// ---------- 12. Camera framing ----------
// Where does the screen point (ndcX, ndcY) land at 'depth' units in front of
// the camera? (NDC = -1..1 across the screen.) Returns camera-local coords.
function viewPoint(camera, ndcX, ndcY, depth) {
    const p = new THREE.Vector3(ndcX, ndcY, 0.5).applyMatrix4(camera.projectionMatrixInverse);
    return p.multiplyScalar(-depth / p.z);
}

// Things painted relative to the camera's rest pose: the sun bloom, light
// shafts and the blurred foreground sprites. [ndcX, ndcY, depth, size]
// with size = fraction of the frame's smaller side at that depth.
const EDGE_LAYOUT = {
    portrait: [
        { cell: 0, at: [0.82, -1.02], depth: 2.6, size: 0.95 },
        { cell: 1, at: [-0.98, -0.92], depth: 2.9, size: 0.75 },
        { cell: 2, at: [1.08, 1.0], depth: 3.4, size: 0.8 }
    ],
    landscape: [
        { cell: 0, at: [0.9, -1.04], depth: 3.4, size: 0.62 },
        { cell: 1, at: [-0.95, -0.95], depth: 3.6, size: 0.5 },
        { cell: 2, at: [1.03, 1.04], depth: 4.2, size: 0.55 }
    ]
};
const SUN_AT = { portrait: [-0.62, 0.8], landscape: [-0.72, 0.78] };

// ---------- 13. createGrove: put it all together ----------
export function createGrove({ renderer, reducedMotion = false, quality = "high" } = {}) {
    const amounts = AMOUNTS[quality] || AMOUNTS.high;
    const noise = makeNoise(7);
    const disposables = [];
    const keep = (thing) => {
        disposables.push(thing);
        return thing;
    };

    const scene = new THREE.Scene();
    scene.background = null;                                 // transparent: the CSS gradient is the sky
    scene.fog = new THREE.Fog(FOG_COLOUR, 7, 62);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 240);

    // 13a. light: warm sun from the upper left + a soft pink sky/ground fill
    const hemi = new THREE.HemisphereLight("#fff0f0", "#f2c2ae", 1.9);
    scene.add(hemi);
    const sunLight = new THREE.DirectionalLight("#ffe8cc", 2.3);
    sunLight.position.set(-6, 10, 5);
    scene.add(sunLight);

    // 13b. ground, banks and river
    const river = createRiver();
    const terrain = buildTerrain(river, noise, makeRandom(5));
    const groundMaterial = keep(new THREE.MeshLambertMaterial({ vertexColors: true }));
    const land = new THREE.Mesh(keep(terrain.landGeometry), groundMaterial);
    const bank = new THREE.Mesh(keep(terrain.bankGeometry), groundMaterial);
    scene.add(land, bank);

    // 13c. trees
    const trees = TREES.map((def) => {
        const baseY = terrain.groundY(def.x, def.z);
        return { def, baseY, shape: makeCanopyPuffs(def, baseY, makeRandom(def.seed)) };
    });
    const barkBuilder = createBuilder();
    trees.forEach((tree) => addTrunk(barkBuilder, tree.def, tree.baseY, noise, makeRandom(tree.def.seed + 1)));
    const barkMaterial = keep(new THREE.MeshLambertMaterial({ vertexColors: true }));
    const trunks = new THREE.Mesh(keep(finishGeometry(barkBuilder)), barkMaterial);
    const blossoms = makeBlossomMesh(trees, TREE_VOXEL, noise, makeRandom(99));
    keep(blossoms.geometry);
    keep(blossoms.material);
    scene.add(trunks, blossoms);

    // 13d. grass, flowers, stepping stones
    const greenery = scatterGreenery(terrain, river, noise, makeRandom(31), amounts);
    const plantMaterial = keep(new THREE.MeshLambertMaterial({ vertexColors: true }));
    const grassTint = [new THREE.Color(1, 1, 1), new THREE.Color(0.92, 0.97, 0.9), new THREE.Color(1.04, 1.02, 0.92)];
    const tufts = makeInstanced(keep(makeTuftGeometry()), plantMaterial, greenery.tufts,
        (item, i) => grassTint[i % grassTint.length]);
    const flowers = makeInstanced(keep(makeFlowerGeometry()), plantMaterial, greenery.flowers,
        (item) => item.tint);
    scene.add(tufts, flowers);

    const stoneItems = [];
    {
        // stepping stones crossing the river behind Koko
        const u = 0.315;
        const p = river.curve.getPointAt(u);
        const t = river.curve.getTangentAt(u);
        const half = river.halfWidthAt(p.z);
        const stoneRandom = makeRandom(77);
        for (const a of [-0.78, -0.26, 0.26, 0.78]) {
            stoneRandom();
            stoneItems.push({
                x: p.x - t.z * a * half + (stoneRandom() - 0.5) * 0.25,
                y: WATER_Y + 0.07,
                z: p.z + t.x * a * half + (stoneRandom() - 0.5) * 0.25,
                yaw: stoneRandom() * 6.28,
                sx: 0.9 + stoneRandom() * 0.35, sy: 0.9 + stoneRandom() * 0.3, sz: 0.85 + stoneRandom() * 0.3
            });
        }
    }
    const stoneMaterial = keep(new THREE.MeshLambertMaterial({ color: 0xffffff }));
    const stoneShades = [TONES.stone, mix(TONES.stone, colour("blossomLight"), 0.3), TONES.stone.clone().multiplyScalar(0.94)];
    const stones = makeInstanced(keep(makeStoneGeometry()), stoneMaterial, stoneItems,
        (item, i) => stoneShades[i % stoneShades.length]);
    scene.add(stones);

    // 13e. water + reflections.
    // CHEAP PLANAR REFLECTION: a copy of the bank, trunks, stones and a
    // low-detail copy of the blossoms, flipped upside down (scale.y = -1)
    // around the water line. The ground hides it everywhere except where the
    // river cuts through, so through the see-through water it looks exactly
    // like a reflection. Costs a few draw calls, no extra render pass.
    const envTarget = renderer ? keep(makeSkyEnvironment(renderer)) : null;
    const waterMaterial = keep(new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.12,
        metalness: 0.0,
        envMap: envTarget ? envTarget.texture : null,
        envMapIntensity: 1.1,
        transparent: true,
        opacity: 0.58,
        depthWrite: false
    }));
    const water = new THREE.Mesh(keep(makeWaterGeometry(river)), waterMaterial);
    scene.add(water);

    const mirror = new THREE.Group();
    mirror.name = "reflection";
    mirror.scale.y = -1;
    mirror.position.y = 2 * MIRROR_Y;
    const mirrorBlossoms = makeBlossomMesh(trees, TREE_VOXEL * 2, noise, makeRandom(98));
    keep(mirrorBlossoms.geometry);
    keep(mirrorBlossoms.material);
    mirror.add(new THREE.Mesh(terrain.bankGeometry, groundMaterial), new THREE.Mesh(trunks.geometry, barkMaterial),
        mirrorBlossoms, stones.clone());
    scene.add(mirror);

    // 13f. soft contact shadows: blurry dark-green blobs on the ground
    const blobTexture = keep(makeBlobTexture());
    const shadowMaterial = keep(new THREE.MeshBasicMaterial({
        color: TONES.shadow, alphaMap: blobTexture, transparent: true, opacity: 0.32,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2
    }));
    const blobGeometry = keep(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    const blobItems = [];
    trees.forEach(({ def, baseY, shape }) => {
        blobItems.push({ x: shape.centre.x, y: baseY + 0.02, z: def.z, sx: def.rx * 2.3, sy: 1, sz: def.rz * 1.9 });
        blobItems.push({ x: def.x + 0.2, y: baseY + 0.025, z: def.z + 0.2, sx: 2.4, sy: 1, sz: 2.0 });
    });
    const treeShadows = makeInstanced(blobGeometry, shadowMaterial, blobItems);
    scene.add(treeShadows);

    // 13g. far away: a soft voxel hill, then a haze card that melts the
    // horizon into the CSS gradient
    const hillVoxels = new Map();
    const hillTop = mix(colour("blossomLight"), colour("peach"), 0.45);
    const hillSide = mix(colour("blossom"), colour("peach"), 0.55);
    for (let i = -34; i <= 34; i++) {
        for (let k = 0; k < 6; k++) {
            const x = i * 2;
            const h = 9 * Math.exp(-Math.pow((x + 9) / 15, 2)) + 5.5 * Math.exp(-Math.pow((x - 22) / 11, 2)) +
                2 + noise(x * 0.2, 0, k) * 1.2 - k * 0.6;
            for (let j = 0; j < Math.max(1, Math.round(h / 2)); j++) {
                hillVoxels.set(voxelKey(i, j, k), { x: i, y: j, z: k, top: hillTop, side: hillSide });
            }
        }
    }
    const hillBuilder = createBuilder();
    meshVoxels(hillVoxels, [hillBuilder], { size: 2, origin: [0, -2, -82], skip: ["ny", "nz"] });
    const hillMaterial = keep(new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }));
    const hill = new THREE.Mesh(keep(finishGeometry(hillBuilder)), hillMaterial);
    scene.add(hill);

    const hazeMaterial = keep(new THREE.MeshBasicMaterial({
        map: keep(makeHazeTexture()), transparent: true, depthWrite: false, fog: false
    }));
    const haze = new THREE.Mesh(keep(new THREE.PlaneGeometry(320, 16)), hazeMaterial);
    haze.position.set(0, 6.5, -47);
    scene.add(haze);

    // 13h. Koko's spot, the walk path and Koko's own soft shadow
    const walkPath = new THREE.CatmullRomCurve3(WALK_POINTS.map(([x, z]) => new THREE.Vector3(x, terrain.groundY(x, z), z)));
    let homeU = 0;
    {
        let best = Infinity;
        for (let i = 0; i <= 400; i++) {
            const d = walkPath.getPointAt(i / 400).distanceToSquared(HOME);
            if (d < best) {
                best = d;
                homeU = i / 400;
            }
        }
    }
    const kokoSpot = new THREE.Group();
    kokoSpot.name = "kokoSpot";
    kokoSpot.position.copy(walkPath.getPointAt(homeU));
    kokoSpot.rotation.y = HOME_YAW;
    kokoSpot.scale.setScalar(KOKO_SCALE);                    // Koko is built in voxel units (1 = one voxel)
    scene.add(kokoSpot);
    const kokoShadowMaterial = keep(shadowMaterial.clone());
    kokoShadowMaterial.opacity = 0.42;
    const kokoShadow = new THREE.Mesh(blobGeometry, kokoShadowMaterial);
    kokoShadow.scale.set(21, 1, 10);                         // in Koko voxels
    kokoShadow.position.y = 0.2;
    kokoShadow.name = "kokoShadow";
    kokoSpot.add(kokoShadow);

    // 13i. sun bloom + light shafts + blurred foreground (camera-relative)
    const lensGroup = new THREE.Group();                     // follows the camera's REST pose
    lensGroup.name = "lens";
    scene.add(lensGroup);
    const sunMaterial = keep(new THREE.SpriteMaterial({
        map: keep(makeSunTexture()), transparent: true, depthWrite: false, depthTest: false, fog: false
    }));
    const sunSprite = new THREE.Sprite(sunMaterial);
    sunSprite.renderOrder = 5;                               // over the canopies: light wraps their edges
    lensGroup.add(sunSprite);

    const shaftMaterial = keep(new THREE.MeshBasicMaterial({
        map: keep(makeShaftTexture()), transparent: true, opacity: 0.22, depthWrite: false, fog: false
    }));
    const shafts = [0, 1, 2].map(() => {
        const mesh = new THREE.Mesh(blobGeometry.clone().rotateX(Math.PI / 2), shaftMaterial);
        keep(mesh.geometry);
        mesh.renderOrder = 4;
        return mesh;
    });
    const shaftGroup = new THREE.Group();
    shafts.forEach((s) => shaftGroup.add(s));
    lensGroup.add(shaftGroup);

    const edgeMaterial = keep(new THREE.MeshBasicMaterial({
        map: keep(makeEdgeAtlas(makeRandom(4))), transparent: true, depthWrite: false, fog: false
    }));
    const edgeSprites = [0, 1, 2].map((cell) => {
        const geometry = keep(new THREE.PlaneGeometry(1, 1));
        const uv = geometry.attributes.uv;
        for (let i = 0; i < uv.count; i++) uv.setX(i, (cell + uv.getX(i)) / 3);   // pick the atlas cell
        const mesh = new THREE.Mesh(geometry, edgeMaterial);
        mesh.renderOrder = 10;
        lensGroup.add(mesh);
        return mesh;
    });

    // 13j. falling petals (+ one "hero" petal the story can drop onto Koko's tongue)
    const petals = createPetals(amounts, makeRandom(123));
    keep(petals.geometry);
    keep(petals.material);
    scene.add(petals.mesh);
    const heroPetal = new THREE.Mesh(petals.geometry, petals.material);
    heroPetal.name = "heroPetal";
    heroPetal.scale.setScalar(1.3);
    heroPetal.visible = false;
    scene.add(heroPetal);

    // ---------- camera rig: rest pose from resize(), parallax in update() ----------
    const rig = {
        target: new THREE.Vector3(),
        rest: new THREE.Vector3(),
        distance: 7,
        right: new THREE.Vector3(),
        up: new THREE.Vector3(),
        forward: new THREE.Vector3(),
        pointer: new THREE.Vector2(),                        // smoothed pointer
        scroll: 0
    };

    function placeLensThings(shape) {
        const w = viewPoint(camera, 1, 0, 1).x - viewPoint(camera, -1, 0, 1).x;
        const h = viewPoint(camera, 0, 1, 1).y - viewPoint(camera, 0, -1, 1).y;
        const smaller = Math.min(w, h);                         // frame size at depth 1

        EDGE_LAYOUT[shape].forEach((item, index) => {
            const sprite = edgeSprites[index];
            sprite.position.copy(viewPoint(camera, item.at[0], item.at[1], item.depth));
            sprite.scale.setScalar(smaller * item.depth * item.size);
        });

        const sunDepth = 90;
        const sunAt = SUN_AT[shape];
        sunSprite.position.copy(viewPoint(camera, sunAt[0], sunAt[1], sunDepth));
        sunSprite.scale.setScalar(smaller * sunDepth * (shape === "portrait" ? 1.15 : 0.85));

        // shafts: long thin quads fanning down-right from the sun
        const shaftDepth = 40;
        const origin = viewPoint(camera, sunAt[0], sunAt[1], shaftDepth);
        const length = h * shaftDepth * 1.1;
        [[0.55, 0.06], [0.72, 0.035], [0.9, 0.05]].forEach(([angle, width], index) => {
            const shaft = shafts[index];
            shaft.scale.set(w * shaftDepth * width, length, 1);
            shaft.rotation.set(0, 0, angle);          // tilt: the beam runs down and to the right
            // move it so the beam's top end starts at the sun
            shaft.position.set(origin.x + Math.sin(angle) * length * 0.5, origin.y - Math.cos(angle) * length * 0.5, origin.z);
        });
    }

    function resize(width, height, layout) {
        const aspect = width / Math.max(1, height);
        const shape = aspect < 1 ? "portrait" : "landscape";
        const k = smoothstep(0.7, 1.4, aspect);              // 0 = phone, 1 = desktop: blend the two shots
        const lerp = THREE.MathUtils.lerp;
        const fov = lerp(SHOTS.portrait.fov, SHOTS.landscape.fov, k);
        const fraction = lerp(SHOTS.portrait.kokoFraction, SHOTS.landscape.kokoFraction, k);
        const yaw = lerp(SHOTS.portrait.yaw, SHOTS.landscape.yaw, k);
        const pitch = lerp(SHOTS.portrait.pitch, SHOTS.landscape.pitch, k);
        const spot = layout || (shape === "portrait" ? { kokoX: 0.5, kokoY: 0.7 } : { kokoX: 0.68, kokoY: 0.62 });

        // distance so Koko fills 'fraction' of the frame height
        rig.distance = KOKO_HEIGHT / (fraction * 2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
        rig.target.set(HOME.x, HOME.y + 0.5, HOME.z);
        rig.rest.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
            .multiplyScalar(rig.distance).add(rig.target);

        camera.fov = fov;
        camera.aspect = aspect;
        // setViewOffset shifts the picture like a tilt-shift lens: the camera
        // still aims at Koko, but Koko lands at (kokoX, kokoY) on screen.
        camera.setViewOffset(width, height, (0.5 - spot.kokoX) * width, (0.5 - spot.kokoY) * height, width, height);
        camera.updateProjectionMatrix();

        camera.position.copy(rig.rest);
        camera.lookAt(rig.target);
        camera.updateMatrixWorld();
        rig.right.setFromMatrixColumn(camera.matrixWorld, 0);
        rig.up.setFromMatrixColumn(camera.matrixWorld, 1);
        rig.forward.copy(rig.target).sub(rig.rest).normalize();

        lensGroup.position.copy(camera.position);
        lensGroup.quaternion.copy(camera.quaternion);
        placeLensThings(shape);
        applyCamera();
    }

    function applyCamera() {
        const motion = reducedMotion ? 0 : 1;
        camera.position.copy(rig.rest)
            .addScaledVector(rig.right, rig.pointer.x * 0.2 * motion)
            .addScaledVector(rig.up, rig.pointer.y * 0.09 * motion)
            .addScaledVector(rig.forward, rig.scroll * rig.distance * 0.12 * motion);
        camera.lookAt(rig.target);
    }

    function update(dt, elapsed, input = {}) {
        dt = Math.min(Math.max(dt || 0, 0), 0.1);
        const pointer = input.pointer || { x: 0, y: 0 };
        // ease towards the pointer (a critically-damped-ish follow, frame-rate independent)
        const follow = 1 - Math.exp(-dt * 3.5);
        rig.pointer.x += (THREE.MathUtils.clamp(pointer.x, -1, 1) - rig.pointer.x) * follow;
        rig.pointer.y += (THREE.MathUtils.clamp(pointer.y, -1, 1) - rig.pointer.y) * follow;
        rig.scroll += (THREE.MathUtils.clamp(input.scroll || 0, 0, 1) - rig.scroll) * follow;
        applyCamera();
        if (!reducedMotion) petals.update(dt, elapsed || 0);
    }

    function setReducedMotion(value) {
        reducedMotion = Boolean(value);
        petals.mesh.visible = !reducedMotion;
        applyCamera();
    }

    function stats() {
        let triangles = 0;
        let drawCallsEstimate = 0;
        let instances = 0;
        scene.traverseVisible((object) => {
            if (!object.isMesh && !object.isSprite) return;
            const geometry = object.geometry;
            const count = geometry.index ? geometry.index.count : geometry.attributes.position.count;
            const copies = object.isInstancedMesh ? object.count : 1;
            triangles += (count / 3) * copies;
            drawCallsEstimate += 1;
            if (object.isInstancedMesh) instances += object.count;
        });
        return { triangles: Math.round(triangles), drawCallsEstimate, instances };
    }

    function dispose() {
        disposables.forEach((thing) => thing.dispose && thing.dispose());
        scene.clear();
    }

    setReducedMotion(reducedMotion);
    petals.update(0, 0);
    resize(390, 844);

    return {
        scene,
        camera,
        kokoSpot,
        walkPath,
        homeU,
        update,
        resize,
        setReducedMotion,
        burstPetals: (point) => {
            if (!reducedMotion) petals.burst(point);
        },
        setWeather: (t) => petals.setWeather(t),
        props: {
            heroPetal,                                       // hidden petal mesh the story can animate
            water,
            river: river.curve,                              // centre line of the river (world space)
            sun: sunSprite,
            sunDirection: sunLight.position.clone().normalize(),
            groundY: terrain.groundY                          // (x, z) → ground height
        },
        stats,
        dispose
    };
}
