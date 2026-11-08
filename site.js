// site.js: the page. Uses the engine in scanline.js.
// 1. wordmark, 2. the BB84 bench (you play Eve), 3. "stardust", 4. project loops (one per cartridge).

let COL = palette();
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { COL = palette(); });

// ---------- 1. Wordmark ----------
(function wordmark() {
    const c = document.getElementById("wordmark");
    const w = textWidth("KokoGecko", 3), h = 7 * 3;
    const ctx = setupCanvas(c, w, h);
    const draw = () => { ctx.clearRect(0, 0, w, h); fillRects(ctx, textRects("KokoGecko", 0, 0, 3), COL.ink); };
    draw();
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);
})();

// ---------- 2. The bench ----------
(function bench() {
    const W = 960, H = 568;
    const canvas = document.getElementById("bench");
    const ctx = setupCanvas(canvas, W, H);
    const dark = new Darkness(W, H);
    const cam = new Camera(480, 220, 120, 26, 45);
    const rand = rng(8);                               // fixed seed: the same photons every visit
    const SLOT = 12;                                   // frames per photon (1 s)
    const FIBRE = 410, X_A = 88, X_B = 872, GROUND = 548;
    const KEY_LEN = 24;

    // --- the gecko (Eve): the old site's pixel gecko, now drawn in scanlines ---
    const ART = [
        "..........GGGGG.", ".........GLLLLLG", ".........GLWKLLG", "...GG....GLLLPPG", "..GGGG.GGGGGGGG.",
        ".GGLLGGGGLLLLLG.", "GGLLLLLLLLLLLG..", ".GGGDGGGGGGDGG..", "..GG.G....GG.G..", "..GG.GG...GG.GG.",
    ];
    const PX = 5, GW = 16 * PX, GH = ART.length * PX;
    // Body pixels become rules (ink); the eye is left open so it reads at this size
    function geckoRects(x, y, facing, frame) {
        const out = [];
        ART.forEach((row, ry) => {
            // legs swap every other frame while walking
            const r = ry >= 8 && frame % 2 ? ART[ry === 8 ? 9 : 8] : row;
            for (let rx = 0; rx < 16; rx++) {
                const ch = r[facing > 0 ? rx : 15 - rx];
                if ("GLDP".includes(ch)) out.push([x + rx * PX, y + ry * PX, PX, PX - 1]);
            }
        });
        return out;
    }
    const eve = { x: 300, y: GROUND - GH, vy: 0, facing: 1, walk: 0, idle: true, dir: 1 };
    const keys = new Set();

    // --- state ---
    let photon = null, frame = 0, ghost = [], staticRects = null, flash = null;
    let stats = { sent: 0, sifted: 0, errors: 0, caught: 0 }, key = [];

    function newPhoton() {
        const aBit = rand() < 0.5 ? 0 : 1, aBasis = rand() < 0.5 ? 0 : 1, bBasis = rand() < 0.5 ? 0 : 1;
        return { aBit, aBasis, bBasis, state: prepare(aBit, aBasis), pol: POL[`${aBasis},${aBit}`], k: 0, eve: null, trail: [] };
    }
    const phi = (k) => (2 * Math.PI * k) / (SLOT - 1);  // one full turn by the time Bob measures
    const photonX = (k) => X_A + ((k + 0.5) / (SLOT - 1)) * (X_B - X_A - 20);

    function sphereArt() {
        dark.clear();
        dark.shadeSphere(cam, 0.3);
        const ring = [];
        for (let i = 0; i <= 120; i++) { const t = (i / 120) * 2 * Math.PI; ring.push([cam.cx + cam.radius * Math.cos(t), cam.cy + cam.radius * Math.sin(t)]); }
        dark.line(ring, 2.2, 0.9);
        dark.curve(cam, greatCircle("z"), 2, 0.85, 0.3);
        dark.curve(cam, greatCircle("y"), 2.4, 0.8, 0.1);
        dark.curve(cam, greatCircle("x"), 2.4, 0.8, 0.1);
        for (const a of AXES.concat([[0, 1, 0]])) dark.curve(cam, [-1.22, -0.6, 0, 0.6, 1.22].map((s) => scale(a, s)), 2.2, 0.75, 0.1);
        const rects = dark.scan(cam.cy - cam.radius - 40, cam.cy + cam.radius + 40);
        for (const [t, p, dx] of [["|0⟩", [0, 0, 1.3], 16], ["|1⟩", [0, 0, -1.3], 16], ["|+⟩", [1.55, 0, 0], 0], ["|−⟩", [-1.55, 0, 0], 0]]) {
            const [x, y] = cam.project(p);
            rects.push(...textRects(t, Math.round(dx ? x + dx : x - textWidth(t, 3) / 2), Math.round(y - 10), 3));
        }
        return rects;
    }

    function vectorArt(r, trail, measured) {
        dark.clear();
        if (!measured && Math.abs(r[2]) < 0.98) dark.curve(cam, latitude(r[2]), 1.4, 0.38, 0.18, true);
        if (!measured) {
            const pts = trail.concat([r]);
            for (let i = 0; i < pts.length - 1; i++) {
                const arc = [];
                for (let s = 0; s <= 10; s++) arc.push(precess(pts[i], (s / 10) * phi(1)));
                dark.curve(cam, arc, 3, 0.3 + 0.2 * (i + 4 - pts.length), 0.15);
            }
        }
        const shaft = [];
        for (let s = 0; s <= 20; s++) shaft.push(scale(r, (s / 20) * 0.94));
        dark.curve(cam, shaft, 5, 1, 0.7);
        return dark.scan(cam.cy - cam.radius - 10, cam.cy + cam.radius + 10);
    }

    function tick() {
        frame++;
        if (!photon) photon = newPhoton();
        const p = photon;

        // --- Eve moves ---
        const left = keys.has("ArrowLeft") || keys.has("a"), right = keys.has("ArrowRight") || keys.has("d");
        let vx = 0;
        if (left) vx = -16;
        if (right) vx = 16;
        if (eve.idle) {                                   // before anyone plays, she paces the floor
            vx = 8 * eve.dir;
            if (eve.x < 160 || eve.x > 736) eve.dir *= -1;
        }
        if (vx) { eve.facing = Math.sign(vx); eve.walk++; }
        eve.x = Math.max(40, Math.min(W - 40 - GW, eve.x + vx));
        eve.vy += 9;                                      // gravity, per frame
        eve.y = Math.min(GROUND - GH, eve.y + eve.vy);
        const airborne = eve.y < GROUND - GH;

        // --- the photon flies; Eve may intercept it ---
        const x = photonX(p.k);
        const r = precess(p.state, phi(p.k));
        if (p.k < SLOT - 1 && !p.eve && airborne &&
            x + 20 > eve.x + 8 && x < eve.x + GW - 8 && FIBRE + 14 > eve.y && FIBRE - 14 < eve.y + GH) {
            // Intercept-resend: Eve measures in a random basis and sends on what she found
            const eBasis = rand() < 0.5 ? 0 : 1;
            const m = measure(r, eBasis, phi(p.k), rand);
            p.state = precess(m.state, -phi(p.k));
            p.pol = POL[`${eBasis},${m.bit}`];
            p.eve = eBasis;
            stats.caught++;
            flash = { k: 3 };
        }

        let measured = false;
        if (p.k === SLOT - 1) {
            // Bob measures in his random basis (co-rotating frame), then they compare bases in public
            const m = measure(r, p.bBasis, phi(p.k), rand);
            measured = true;
            p.bBit = m.bit;
            p.after = m.state;
            stats.sent++;
            const sifted = p.aBasis === p.bBasis;
            const error = sifted && m.bit !== p.aBit;
            if (sifted) stats.sifted++;
            if (error) stats.errors++;
            key.push({ bit: m.bit, sifted, error });
            if (key.length > KEY_LEN) key.shift();
        }

        draw(p, measured ? p.after : r, measured, x, airborne);
        if (!measured) p.trail = p.trail.concat([r]).slice(-3);
        p.k++;
        if (p.k >= SLOT) photon = null;
        if (flash && --flash.k <= 0) flash = null;
    }

    function draw(p, r, measured, x, airborne) {
        if (!staticRects) staticRects = sphereArt();
        const moving = vectorArt(r, p.trail, measured);
        const [tx, ty] = cam.project(r);
        moving.push([Math.round(tx - 5), Math.round(ty - 5), 10, 10]);
        const photonRects = p.k < SLOT - 1 ? textRects(p.pol, Math.round(x), FIBRE - 14, 4) : [];
        const eveRects = geckoRects(Math.round(eve.x), Math.round(eve.y), eve.facing, airborne ? 0 : eve.walk);

        ctx.fillStyle = COL.paper;
        ctx.fillRect(0, 0, W, H);
        ghostRects(ctx, ghost, COL.acc, COL.ghost);
        fillRects(ctx, staticRects, COL.ink);
        fillRects(ctx, moving, COL.ink);
        fillRects(ctx, photonRects, p.eve !== null ? COL.acc : COL.ink);
        fillRects(ctx, eveRects, flash ? COL.acc : COL.ink);

        // fibre, ends, floor
        const dots = [];
        for (let fx = X_A; fx < X_B; fx += 12) dots.push([fx, FIBRE - 1, 4, 2]);
        fillRects(ctx, dots, COL.faint);
        fillRects(ctx, [[48, FIBRE - 8, 16, 16], [896, FIBRE - 8, 16, 16]], COL.ink);
        fillRects(ctx, [[900, FIBRE - 4, 8, 8]], measured && p.aBasis === p.bBasis ? COL.acc : COL.paper);
        const floor = [];
        for (let fx = 48; fx < 912; fx += 8) floor.push([fx, GROUND + 4, 4, 2]);
        fillRects(ctx, floor, COL.faint);

        // labels and live readouts, 3 px pixel type
        fillRects(ctx, textRects("alice", 48, 372, 3), COL.faint);
        fillRects(ctx, textRects("bob", 912 - textWidth("bob", 3), 372, 3), COL.faint);
        fillRects(ctx, textRects(`${BASIS[p.aBasis]} ${KET[`${p.aBasis},${p.aBit}`]}`, 48, 434, 3), COL.ink);
        if (p.k >= 4) {
            const bob = measured ? `${p.bBit} ${BASIS[p.bBasis]}` : BASIS[p.bBasis];
            fillRects(ctx, textRects(bob, 912 - textWidth(bob, 3), 434, 3), COL.ink);
        }
        if (p.eve !== null) {
            const e = `eve ${BASIS[p.eve]}`;
            fillRects(ctx, textRects(e, 480 - textWidth(e, 3) / 2, 434, 3), COL.acc);
        }

        // raw key along the top: kept bits underlined, dropped bits struck, errors in accent
        fillRects(ctx, textRects("raw key", 48, 28, 3), COL.faint);
        key.forEach((b, i) => {
            const kx = 200 + i * 20, rects = textRects(String(b.bit), kx, 24, 3);
            const col = b.error ? COL.acc : b.sifted ? COL.ink : COL.faint;
            fillRects(ctx, rects, col);
            fillRects(ctx, [b.sifted ? [kx, 24 + 25, 15, 2] : [kx - 2, 24 + 9, 19, 2]], col);
        });
        const qber = stats.sifted ? stats.errors / stats.sifted : 0;
        const read = `qber ${qber.toFixed(2)}`;
        fillRects(ctx, textRects(read, 912 - textWidth(read, 3), 28, 3), qber > 0.11 ? COL.acc : COL.ink);

        ghost = moving.concat(photonRects, eveRects);
        if (frame % 6 === 0) liveText(qber);
    }

    // Screen readers get the numbers as text, politely, a few times a second at most
    const live = document.getElementById("bench-status");
    const resetCount = document.getElementById("reset-n");   // the number on the "Reset count" button
    function liveText(qber) {
        live.textContent = `${stats.sent} photons sent, ${stats.sifted} kept, ${stats.caught} read by the gecko. Error rate ${Math.round(qber * 100)}%.`;
        resetCount.textContent = stats.caught;
    }

    // --- controls ---
    const jump = () => { if (eve.y >= GROUND - GH) eve.vy = -44; };
    const wake = () => { eve.idle = false; running = true; };
    canvas.addEventListener("keydown", (e) => {
        const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        if (["ArrowLeft", "ArrowRight", "a", "d"].includes(k)) { keys.add(k); wake(); e.preventDefault(); }
        if ([" ", "ArrowUp", "w"].includes(k)) { jump(); wake(); e.preventDefault(); }
        if (k === "r") reset();
    });
    canvas.addEventListener("keyup", (e) => keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));
    canvas.addEventListener("blur", () => keys.clear());

    // Drag on the sphere turns it; a tap anywhere else makes the gecko jump
    let drag = null;
    canvas.addEventListener("pointerdown", (e) => {
        const b = canvas.getBoundingClientRect(), sx = W / b.width;
        const px = (e.clientX - b.left) * sx, py = (e.clientY - b.top) * sx;
        if (Math.hypot(px - cam.cx, py - cam.cy) < cam.radius + 20) {
            drag = { x: e.clientX, y: e.clientY, azim: cam.azim, elev: cam.elev, sx };
            canvas.setPointerCapture(e.pointerId);
        } else { eve.x = Math.max(40, Math.min(W - 40 - GW, px - GW / 2)); jump(); wake(); }
    });
    canvas.addEventListener("pointermove", (e) => {
        if (!drag) return;
        cam.set(Math.max(5, Math.min(70, drag.elev + (e.clientY - drag.y) * drag.sx * 0.3)),
                drag.azim - (e.clientX - drag.x) * drag.sx * 0.4);
        staticRects = null;
        if (!running) tick();
    });
    canvas.addEventListener("pointerup", () => { drag = null; });

    const hold = (id, k) => {
        const b = document.getElementById(id);
        b.addEventListener("pointerdown", () => { keys.add(k); wake(); });
        for (const ev of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(ev, () => keys.delete(k));
    };
    hold("btn-left", "ArrowLeft");
    hold("btn-right", "ArrowRight");
    document.getElementById("btn-jump").addEventListener("click", () => { jump(); wake(); });
    function reset() { stats = { sent: 0, sifted: 0, errors: 0, caught: 0 }; key = []; liveText(0); }
    document.getElementById("btn-reset").addEventListener("click", reset);

    // Reduced motion: one still frame until the visitor presses a control
    let running = !reduceMotion.matches;
    const onScreen = visibleFlag(canvas);
    tick();
    liveText(0);
    stepper(tick, () => running && onScreen());
    // ?debug exposes the bench so its logic can be stepped by hand from the console
    if (location.search.includes("debug")) window.bench = { tick, jump, wake, eve, stats: () => stats, key: () => key };
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => setTimeout(() => { if (!running) tick(); }));
})();

// ---------- 3. "stardust", typed once in scanline type ----------
(function stardust() {
    const c = document.getElementById("stardust");
    const PXL = 10, W = textWidth("stardust", PXL) + 6 * PXL, H = 7 * PXL + 12;
    const ctx = setupCanvas(c, W, H);
    let n = reduceMotion.matches ? 8 : 0, blink = 0, started = false;
    function draw() {
        ctx.clearRect(0, 0, W, H);
        fillRects(ctx, scanTextRects("stardust".slice(0, n), 0, 0, PXL), COL.ink);
        const cursorOn = n < 8 || blink < 10 ? blink % 2 === 0 : true;  // blink five times, then hold
        if (cursorOn) {
            const x = n * ADVANCE * PXL;
            fillRects(ctx, [[x, 6 * PXL + 1, 5 * PXL, 3], [x, 6 * PXL + 6, 5 * PXL, 3]], COL.acc);
        }
    }
    draw();
    if (reduceMotion.matches) return;
    let t = 0;
    new IntersectionObserver(([e]) => {
        if (!e.isIntersecting || started) return;
        started = true;
        const id = setInterval(() => {
            t++;
            if (n < 8 && t % 3 === 0) n++;               // a letter every quarter second
            if (n === 8 && t % 6 === 0) blink++;
            draw();
            if (blink >= 10) clearInterval(id);
        }, 1000 / 12);
    }).observe(c);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => setTimeout(draw));
})();

// ---------- 4. Small loops beside each project ----------
function loop(id, W, H, drawFrame) {
    const c = document.getElementById(id);
    const ctx = setupCanvas(c, W, H);
    let k = 0, ghost = [];
    const run = () => {
        const { rects, moving, accent } = drawFrame(k++);
        ctx.clearRect(0, 0, W, H);
        ghostRects(ctx, ghost, COL.acc, COL.ghost);
        fillRects(ctx, rects, COL.ink);
        if (accent) fillRects(ctx, accent, COL.acc);
        ghost = moving;
    };
    run();
    if (!reduceMotion.matches) stepper(run, visibleFlag(c));
}

// Trade Gecko: a sampled price walk scrolling left; a gold tick where it crosses up through its moving average
(function () {
    const r = rng(3), N = 60, prices = [];
    let p = 0;
    for (let i = 0; i < 400; i++) { p += (r() - 0.5) * 6 + Math.sin(i / 23) * 0.8; prices.push(p); }
    loop("loop-trade", 240, 80, (k) => {
        const win = prices.slice(k % 300, (k % 300) + N);
        const lo = Math.min(...win), hi = Math.max(...win);
        const y = (v) => Math.round(70 - ((v - lo) / (hi - lo || 1)) * 60);
        const rects = [], accent = [];
        const ma = (i) => win.slice(Math.max(0, i - 10), i + 1).reduce((a, b) => a + b, 0) / Math.min(i + 1, 11);
        let cooldown = 0;
        win.forEach((v, i) => {
            rects.push([i * 4, y(v), 3, 3]);
            if (i % 2 === 0) rects.push([i * 4, y(ma(i)), 2, 1]);
            // signal: price closes above its average after being below it (at most one per 8 samples)
            cooldown--;
            if (i > 10 && cooldown <= 0 && win[i - 1] < ma(i - 1) && v > ma(i)) {
                accent.push([i * 4, y(v) + 6, 3, 8]);
                cooldown = 8;
            }
        });
        return { rects, moving: rects.slice(-6), accent };
    });
})();

// Gecko Web: rain falling in steps onto a ground line, with a splash where each drop lands
(function () {
    const r = rng(5);
    const drops = Array.from({ length: 16 }, () => ({ x: Math.floor(r() * 58) * 4, y: Math.floor(r() * 70), v: 6 + Math.floor(r() * 3) * 2 }));
    loop("loop-rain", 240, 80, () => {
        const rects = [[0, 74, 240, 2]], accent = [];
        for (const d of drops) {
            d.y += d.v;
            if (d.y > 72) { accent.push([d.x - 4, 70, 3, 2], [d.x + 3, 70, 3, 2]); d.y = -10; d.x = Math.floor(r() * 58) * 4; }
            rects.push([d.x, d.y, 2, 3], [d.x, d.y + 5, 2, 2]);
        }
        return { rects, moving: rects.slice(1), accent };
    });
})();

// Poli Studio: three frogs (the team of 3) hop in turn while a block tower builds up beside them
(function () {
    const FROG = ["GG....GG", "G.GGGG.G", "GGGGGGGG", ".GGGGGG.", "G.G..G.G"];
    const SPOTS = [24, 76, 128];
    loop("loop-poli", 240, 80, (k) => {
        const rects = [[0, 74, 240, 2]], accent = [];
        SPOTS.forEach((sx, i) => {
            const t = (k - i * 6) % 24, hop = t >= 0 && t < 8 ? Math.round(12 * Math.sin((t / 8) * Math.PI)) : 0;
            FROG.forEach((row, ry) => [...row].forEach((ch, rx) => {
                if (ch === "G") rects.push([sx + rx * 4, 54 - hop + ry * 4, 4, 3]);
            }));
        });
        const built = Math.floor(k / 12) % 7;          // 0..6 blocks, then the tower resets
        for (let b = 0; b < Math.min(built, 5); b++) accent.push([188 + (b % 2) * 4, 62 - b * 12, 24, 10]);
        return { rects, moving: rects.slice(1), accent };
    });
})();

// Bellypie: a pixel pie for the team of 3, baked one slice at a time; the newest slice glows gold
(function () {
    const CX = 120, CY = 38, R = 32, STEP = 4, SLICE = (2 * Math.PI) / 3;
    loop("loop-bellypie", 240, 80, (k) => {
        const rects = [[0, 74, 240, 2]], accent = [];
        const baked = Math.floor(k / 12) % 5;          // 0..3 slices filled, a beat on the whole pie, then reset
        for (let y = CY - R; y <= CY + R; y += STEP) {
            for (let x = CX - R; x <= CX + R; x += STEP) {
                const dx = x + 1.5 - CX, dy = y + 1.5 - CY, d = Math.hypot(dx, dy);
                if (d > R) continue;
                const a = (Math.atan2(dy, dx) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI);
                const s = Math.floor(a / SLICE);
                const crust = d > R - STEP;
                if (crust) rects.push([x, y, 3, 3]);                       // the crust is always there
                else if (s < Math.min(baked, 3)) (s === Math.min(baked, 3) - 1 && baked < 4 ? accent : rects).push([x, y, 3, 3]);
            }
        }
        return { rects, moving: accent, accent };
    });
})();

// kokogecko.dev: the gecko walks across and hops a photon
(function () {
    const ART = ["....GGG.", "...GLKLG", ".GGGGGGG", "GLLLLLG.", ".G.G.G.G"];
    loop("loop-site", 240, 80, (k) => {
        const x = (k * 6) % 280 - 30, hop = x > 96 && x < 136 ? Math.round(14 * Math.sin(((x - 96) / 40) * Math.PI)) : 0;
        const rects = [[0, 74, 240, 2]];
        ART.forEach((row, ry) => [...row].forEach((ch, rx) => {
            if (ch !== "." && ch !== "K") rects.push([x + rx * 4, 50 - hop + ry * 4, 4, 3]);
        }));
        const photon = textRects("⟋", 120, 52, 3);
        return { rects, moving: rects.slice(1), accent: photon };
    });
})();

// Profile README: a small Bloch sphere; the state vector precesses and its tip glows gold
(function () {
    const ring = [];
    for (let i = 0; i < 28; i++) { const t = (i / 28) * 2 * Math.PI; ring.push([Math.round(120 + 30 * Math.cos(t)), Math.round(38 + 30 * Math.sin(t)), 3, 3]); }
    for (let x = 90; x < 150; x += 6) ring.push([x, 38, 3, 1]);      // the equator, dashed
    loop("loop-profile", 240, 80, (k) => {
        const a = k / 8, shaft = [];
        for (let s = 1; s <= 8; s++) shaft.push([Math.round(120 + s * 3.4 * Math.cos(a)), Math.round(38 - s * 2 * Math.sin(a) - s * 1.2), 3, 3]);
        const tip = [[Math.round(120 + 28 * Math.cos(a)) - 1, Math.round(38 - 16 * Math.sin(a) - 10) - 1, 5, 5]];
        return { rects: ring.concat(shaft), moving: shaft, accent: tip };
    });
})();

// Koko Planner: the frog hops through the week, one day at a time; today's cell fills gold
(function () {
    const FROG = ["GG....GG", "G.GGGG.G", "GGGGGGGG", ".GGGGGG."];
    const week = [];
    for (let d = 0; d < 7; d++) week.push([12 + d * 32, 66, 26, 2], [12 + d * 32, 46, 2, 22], [36 + d * 32, 46, 2, 22]);
    loop("loop-planner", 240, 80, (k) => {
        const day = Math.floor(k / 10) % 7, t = k % 10;
        const hop = Math.round(18 * Math.sin((t / 10) * Math.PI)), fx = 12 + day * 32 + Math.round((t / 10) * 32) - 2;
        const frog = [];
        FROG.forEach((row, ry) => [...row].forEach((ch, rx) => { if (ch === "G") frog.push([fx + rx * 4, 26 - hop + ry * 4, 4, 3]); }));
        return { rects: week.concat(frog), moving: frog, accent: [[16 + day * 32, 54, 18, 8]] };
    });
})();

// Lina OS: a month of posts; one more gets planned every beat, the newest in gold
(function () {
    const slots = [];
    for (let i = 0; i < 28; i++) slots.push([60 + (i % 7) * 18, 6 + Math.floor(i / 7) * 18]);
    loop("loop-lina", 240, 80, (k) => {
        const n = Math.floor(k / 4) % 30;                       // 0..28 planned, then a beat, then a fresh month
        const rects = [], accent = [];
        slots.forEach(([x, y], i) => {
            rects.push([x, y + 14, 14, 1]);                     // each day's baseline
            if (i < Math.min(n, 28)) (i === n - 1 ? accent : rects).push([x + 3, y + 4, 8, 8]);
        });
        return { rects, moving: accent, accent };
    });
})();
