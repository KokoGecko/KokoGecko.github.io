// scanline.js: the shared engine.
// 1. a 5x7 pixel font, 2. a seeded random generator, 3. Bloch-sphere physics,
// 4. a camera, 5. the scanline renderer that turns a drawing into thick black rules.
// No libraries; every page script builds on these.

// ---------- 1. Pixel font: each glyph is rows of 5 characters, "#" = inked pixel ----------
const GLYPHS = {
    " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
    a: [".....", ".....", ".###.", "....#", ".####", "#...#", ".####"],
    b: ["#....", "#....", "####.", "#...#", "#...#", "#...#", "####."],
    c: [".....", ".....", ".####", "#....", "#....", "#....", ".####"],
    d: ["....#", "....#", ".####", "#...#", "#...#", "#...#", ".####"],
    e: [".....", ".....", ".###.", "#...#", "#####", "#....", ".####"],
    f: ["..##.", ".#...", "####.", ".#...", ".#...", ".#...", ".#..."],
    g: [".....", ".....", ".####", "#...#", "#...#", "#...#", ".####", "....#", ".###."],
    h: ["#....", "#....", "####.", "#...#", "#...#", "#...#", "#...#"],
    i: ["..#..", ".....", ".##..", "..#..", "..#..", "..#..", ".###."],
    j: ["...#.", ".....", "..##.", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
    k: ["#....", "#....", "#..#.", "#.#..", "##...", "#.#..", "#..#."],
    l: [".##..", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
    m: [".....", ".....", "##.#.", "#.#.#", "#.#.#", "#.#.#", "#.#.#"],
    n: [".....", ".....", "####.", "#...#", "#...#", "#...#", "#...#"],
    o: [".....", ".....", ".###.", "#...#", "#...#", "#...#", ".###."],
    p: [".....", ".....", "####.", "#...#", "#...#", "#...#", "####.", "#....", "#...."],
    q: [".....", ".....", ".####", "#...#", "#...#", "#...#", ".####", "....#", "....#"],
    r: [".....", ".....", "#.##.", "##..#", "#....", "#....", "#...."],
    s: [".....", ".....", ".####", "#....", ".###.", "....#", "####."],
    t: [".#...", ".#...", "####.", ".#...", ".#...", ".#..#", "..##."],
    u: [".....", ".....", "#...#", "#...#", "#...#", "#..##", ".##.#"],
    v: [".....", ".....", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
    w: [".....", ".....", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."],
    x: [".....", ".....", "#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
    y: [".....", ".....", "#...#", "#...#", "#...#", "#...#", ".####", "....#", ".###."],
    z: [".....", ".....", "#####", "...#.", "..#..", ".#...", "#####"],
    K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
    G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
    0: [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
    1: ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
    2: [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
    3: ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
    4: ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
    5: ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
    6: ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
    7: ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
    8: [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
    9: [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
    "|": ["..#..", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
    "⟩": ["#....", ".#...", "..#..", "...#.", "..#..", ".#...", "#...."],
    "+": [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."],
    "−": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
    "-": [".....", ".....", ".....", ".###.", ".....", ".....", "....."],
    "×": [".....", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "....."],
    "/": ["....#", "....#", "...#.", "..#..", ".#...", "#....", "#...."],
    ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
    ":": [".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."],
    "·": [".....", ".....", ".....", "..#..", ".....", ".....", "....."],
    "█": ["#####", "#####", "#####", "#####", "#####", "#####", "#####"],
    // polarisation of a photon: H, V, D, A
    "⎯": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
    "⏐": ["..#..", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
    "⟋": ["....#", "....#", "...#.", "..#..", ".#...", "#....", "#...."],
    "⟍": ["#....", "#....", ".#...", "..#..", "...#.", "....#", "....#"],
};
const ADVANCE = 6; // 5 px glyph + 1 px gap

function textWidth(text, px) {
    return ([...text].length * ADVANCE - 1) * px;
}

// Rectangles [x, y, w, h] for text with its top-left at (x, y); runs of pixels merge into one rect.
function textRects(text, x, y, px) {
    const out = [];
    [...text].forEach((ch, i) => {
        const rows = GLYPHS[ch] || GLYPHS[ch.toLowerCase()] || GLYPHS[" "];
        const gx = x + i * ADVANCE * px;
        rows.forEach((row, ry) => {
            let run = -1;
            for (let rx = 0; rx <= 5; rx++) {
                const on = row[rx] === "#";
                if (on && run < 0) run = rx;
                if (!on && run >= 0) { out.push([gx + run * px, y + ry * px, (rx - run) * px, px]); run = -1; }
            }
        });
    });
    return out;
}

// The same type drawn as scanlines: each pixel row becomes two thin horizontal rules.
function scanTextRects(text, x, y, px) {
    const line = Math.max(1, Math.round(px * 0.3)), gap = px / 2;
    return textRects(text, x, y, px).flatMap(([rx, ry, rw]) => [
        [rx, ry + (gap - line) / 2, rw, line],
        [rx, ry + gap + (gap - line) / 2, rw, line],
    ]);
}

// ---------- 2. Seeded random numbers (mulberry32): same seed, same run ----------
function rng(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---------- 3. Physics on the Bloch sphere ----------
// |ψ⟩ = cos(θ/2)|0⟩ + e^{iφ} sin(θ/2)|1⟩  ↔  r = (sin θ cos φ, sin θ sin φ, cos θ)
// basis 0 = "+" (z axis: |0⟩, |1⟩), basis 1 = "×" (x axis: |+⟩, |−⟩)
const AXES = [[0, 0, 1], [1, 0, 0]];
const BASIS = ["+", "×"];
const KET = { "0,0": "|0⟩", "0,1": "|1⟩", "1,0": "|+⟩", "1,1": "|−⟩" };
const POL = { "0,0": "⎯", "0,1": "⏐", "1,0": "⟋", "1,1": "⟍" };

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (v, s) => [v[0] * s, v[1] * s, v[2] * s];

// Alice's state: +axis for bit 0, −axis for bit 1
const prepare = (bit, basis) => scale(AXES[basis], 1 - 2 * bit);

// H = (ħω/2)σz turns r about z by φ = ωt; z is unchanged
function precess(r, phi) {
    const c = Math.cos(phi), s = Math.sin(phi);
    return [c * r[0] - s * r[1], s * r[0] + c * r[1], r[2]];
}

// Measurement along an axis that co-rotates with H (the receiver undoes the known rotation)
function measure(r, basis, phi, rand) {
    const n = precess(AXES[basis], phi);
    const pPlus = (1 + dot(r, n)) / 2;          // Born rule: P(+n) = (1 + r·n) / 2
    const bit = rand() < pPlus ? 0 : 1;
    return { bit, state: scale(n, 1 - 2 * bit) }; // collapse onto the eigenstate found
}

// ---------- 4. Orthographic camera for the sphere ----------
class Camera {
    constructor(cx, cy, radius, elev, azim) {
        this.cx = cx; this.cy = cy; this.radius = radius;
        this.set(elev, azim);
    }
    set(elev, azim) {
        const e = elev * Math.PI / 180, a = azim * Math.PI / 180;
        this.elev = elev; this.azim = azim;
        this.d = [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)]; // toward the viewer
        this.right = [-Math.sin(a), Math.cos(a), 0];
        const d = this.d, r = this.right;
        this.up = [d[1] * r[2] - d[2] * r[1], d[2] * r[0] - d[0] * r[2], d[0] * r[1] - d[1] * r[0]];
    }
    // Bloch-space point -> [screen x, screen y, depth]; depth > 0 is the front half
    project(p) {
        return [this.cx + this.radius * dot(p, this.right), this.cy - this.radius * dot(p, this.up), dot(p, this.d)];
    }
}

// ---------- 5. Scanline renderer ----------
// Draw with ink (any canvas calls) into a "darkness" canvas, then sample it in bands:
// each PITCH-tall band is cut into CELL-wide cells, and a cell's mean darkness sets the
// thickness of a black rule (0..MAX_LINE px). Equal neighbours merge into one rectangle.
const PITCH = 6, CELL = 4, MAX_LINE = 5, GAMMA = 0.7;

class Darkness {
    constructor(w, h) {
        this.w = w; this.h = h;
        this.canvas = document.createElement("canvas");
        this.canvas.width = w; this.canvas.height = h;
        this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
        this.ctx.lineCap = "round";
        this.ctx.lineJoin = "round";
    }
    clear() { this.ctx.clearRect(0, 0, this.w, this.h); }
    line(points, width, dark) {
        const c = this.ctx;
        c.strokeStyle = `rgba(0,0,0,${dark})`;
        c.lineWidth = width;
        c.beginPath();
        points.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
        c.stroke();
    }
    // A 3D polyline; segments behind the sphere centre use the lighter `back` darkness
    curve(cam, pts, width, front, back, dashed = false) {
        const p = pts.map((q) => cam.project(q));
        for (let i = 0; i < p.length - 1; i++) {
            if (dashed && Math.floor(i / 3) % 2) continue;
            this.line([p[i], p[i + 1]], width, p[i][2] + p[i + 1][2] >= 0 ? front : back);
        }
    }
    // Glass-like shading: clear in the middle, darker toward the rim
    shadeSphere(cam, rim) {
        const g = this.ctx.createRadialGradient(cam.cx, cam.cy, 0, cam.cx, cam.cy, cam.radius);
        g.addColorStop(0, "rgba(0,0,0,0)");
        g.addColorStop(0.72, "rgba(0,0,0,0)");
        g.addColorStop(1, `rgba(0,0,0,${rim})`);
        this.ctx.fillStyle = g;
        this.ctx.beginPath();
        this.ctx.arc(cam.cx, cam.cy, cam.radius, 0, Math.PI * 2);
        this.ctx.fill();
    }
    // Sample the drawing into scanline rectangles (only rows y0..y1 to save work)
    scan(y0 = 0, y1 = this.h) {
        const rows0 = Math.floor(y0 / PITCH), rows1 = Math.ceil(y1 / PITCH);
        const cols = Math.floor(this.w / CELL);
        const data = this.ctx.getImageData(0, rows0 * PITCH, cols * CELL, (rows1 - rows0) * PITCH).data;
        const rowLen = cols * CELL * 4, out = [];
        for (let r = 0; r < rows1 - rows0; r++) {
            let runStart = -1, runT = 0;
            for (let c = 0; c <= cols; c++) {
                let t = 0;
                if (c < cols) {
                    let sum = 0;
                    for (let yy = 0; yy < PITCH; yy++) {
                        const base = (r * PITCH + yy) * rowLen + c * CELL * 4 + 3; // alpha channel = ink
                        for (let xx = 0; xx < CELL; xx++) sum += data[base + xx * 4];
                    }
                    // brightness -> rule thickness, quantised to whole pixels
                    t = Math.round(MAX_LINE * Math.pow(sum / (255 * PITCH * CELL), GAMMA));
                }
                if (t !== runT) {
                    if (runT > 0) {
                        const y = (rows0 + r) * PITCH + Math.floor((PITCH - runT) / 2); // centre the rule in its band
                        out.push([runStart * CELL, y, (c - runStart) * CELL, runT]);
                    }
                    runStart = c; runT = t;
                }
            }
        }
        return out;
    }
}

// Unit circles and the precession path
function greatCircle(normal, n = 120) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const t = (i / n) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
        pts.push(normal === "z" ? [c, s, 0] : normal === "x" ? [0, c, s] : [c, 0, s]);
    }
    return pts;
}
function latitude(z, n = 90) {
    const rho = Math.sqrt(Math.max(0, 1 - z * z)), pts = [];
    for (let i = 0; i <= n; i++) {
        const t = (i / n) * Math.PI * 2;
        pts.push([rho * Math.cos(t), rho * Math.sin(t), z]);
    }
    return pts;
}

// ---------- Drawing helpers on the visible canvas ----------
// A crisp canvas sized in logical pixels, sharp on high-DPI screens.
function setupCanvas(canvas, w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    return ctx;
}
function fillRects(ctx, rects, color, alpha = 1) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    for (const [x, y, w, h] of rects) ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
}
// The faint glow of the previous frame: blurred, in the accent colour
function ghostRects(ctx, rects, color, alpha) {
    if (!rects.length) return;
    ctx.save();
    ctx.filter = "blur(2.5px)";
    fillRects(ctx, rects, color, alpha);
    ctx.restore();
}

// Theme colours come from CSS custom properties, so dark mode is one stylesheet change.
function palette() {
    const s = getComputedStyle(document.documentElement);
    const v = (n) => s.getPropertyValue(n).trim();
    return { paper: v("--paper"), ink: v("--ink"), faint: v("--faint"), acc: v("--accent"), ghost: parseFloat(v("--ghost")) };
}

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// Run `tick` at 12 fps (stepped, never smoothed) while `isOn()` is true.
function stepper(tick, isOn) {
    const STEP = 1000 / 12;
    let last = 0, acc = 0;
    function loop(t) {
        if (isOn()) {
            acc += Math.min(t - last, 250);
            if (acc >= STEP) { acc %= STEP; tick(); }
        }
        last = t;
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
}

// Pause animations that are scrolled out of view or in a background tab.
function visibleFlag(el) {
    let seen = false;
    new IntersectionObserver(([e]) => { seen = e.isIntersecting; }).observe(el);
    return () => seen && !document.hidden;
}
