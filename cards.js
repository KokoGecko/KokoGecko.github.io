// cards.js: the motion layer for the project cartridges. No libraries.
// 1. cartridges slide in as they scroll into view, 2. a small launch burst when a link is opened,
// 3. optional media slots (Claude Motion / Seedance clips, Higgsfield stills) over the scanline loops.
// Only transform and opacity animate. With reduced motion, nothing moves: cards are simply there.

(function cards() {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const deck = document.querySelector(".deck");
    if (!deck) return;
    const carts = [...deck.querySelectorAll(".cart")];

    // ---------- 1. Slide in on scroll ----------
    // The hidden start state only applies once JS has added .motion, so the cards never vanish without JS.
    if (!reduce.matches && "IntersectionObserver" in window) {
        deck.classList.add("motion");
        if (window.matchMedia("(min-width: 768px)").matches)       // two columns: the right one lands a beat later
            carts.forEach((c, i) => c.style.setProperty("--stagger", `${(i % 2) * 60}ms`));
        const io = new IntersectionObserver((entries) => {
            for (const e of entries) {
                if (!e.isIntersecting) continue;
                e.target.classList.add("in");
                io.unobserve(e.target);
            }
        }, { rootMargin: "0px 0px -10% 0px" });
        carts.forEach((c) => io.observe(c));
    }

    // ---------- 2. Launch burst ----------
    // Eight pixels fly out from the link like a coin pop. Purely visual; the link navigates as normal.
    deck.addEventListener("click", (e) => {
        const a = e.target.closest(".go a");
        if (!a || reduce.matches) return;
        const r = a.getBoundingClientRect();
        // Mouse clicks burst from the pointer; keyboard "clicks" (detail 0) from the link's left edge
        const x = e.detail ? e.clientX : r.left + 8, y = e.detail ? e.clientY : r.top + r.height / 2;
        const burst = document.createElement("span");
        burst.className = "burst";
        burst.setAttribute("aria-hidden", "true");
        burst.style.left = `${x}px`;
        burst.style.top = `${y}px`;
        for (let i = 0; i < 8; i++) {
            const p = document.createElement("i");
            const ang = (i / 8) * 2 * Math.PI;
            p.style.setProperty("--dx", `${Math.round(Math.cos(ang) * 28)}px`);
            p.style.setProperty("--dy", `${Math.round(Math.sin(ang) * 28)}px`);
            burst.appendChild(p);
        }
        document.body.appendChild(burst);
        setTimeout(() => burst.remove(), 400);
    });

    // ---------- 3. Media slots ----------
    // <canvas data-clip="media/x.mp4" data-still="media/x.webp">: loaded lazily when the card is near.
    // A clip plays only without reduced motion; the still is used otherwise. If a file is missing, the canvas stays.
    const slots = deck.querySelectorAll("canvas[data-clip], canvas[data-still]");
    if (!slots.length || !("IntersectionObserver" in window)) return;
    // Clips only decode while on screen and while the tab is visible
    const clips = new Map();
    const sync = (v) => (clips.get(v) && !document.hidden ? v.play().catch(() => {}) : v.pause());
    const seen = new IntersectionObserver((entries) => {
        for (const e of entries) { clips.set(e.target, e.isIntersecting); sync(e.target); }
    });
    const watch = (v) => { clips.set(v, true); seen.observe(v); };
    document.addEventListener("visibilitychange", () => clips.forEach((_, v) => sync(v)));
    const swap = (canvas, el) => { el.className = "slot"; el.setAttribute("aria-hidden", "true"); canvas.replaceWith(el); };
    const load = (canvas) => {
        const clip = canvas.dataset.clip, still = canvas.dataset.still;
        if (clip && !reduce.matches) {
            const v = document.createElement("video");
            Object.assign(v, { muted: true, loop: true, playsInline: true, autoplay: true, preload: "metadata" });
            if (still) v.poster = still;
            v.addEventListener("loadeddata", () => { swap(canvas, v); watch(v); }, { once: true });
            v.src = clip;
        } else if (still) {
            const img = new Image();
            img.alt = "";
            img.decoding = "async";
            img.addEventListener("load", () => swap(canvas, img), { once: true });
            img.src = still;
        }
    };
    const near = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) { load(e.target); near.unobserve(e.target); }
    }, { rootMargin: "200px" });
    slots.forEach((s) => near.observe(s));
})();

// The Claude Code buddy walks the footer strip at 12 fps, like the gecko upstairs: 3 px a step,
// turns at the ends, stops for a look around now and then. Only transform changes. Still with reduced motion.
(function buddy() {
    const b = document.querySelector(".buddy"), strip = document.querySelector(".walk");
    if (!b || !strip) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let x = 0, dir = 1, rest = 0, k = 0, onScreen = false;
    new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; }).observe(strip);
    setInterval(() => {
        if (!onScreen || document.hidden) return;
        k++;
        const max = strip.clientWidth - 33;
        if (rest > 0) { rest--; b.classList.remove("step"); return; }
        x += 3 * dir;
        if (x >= max || x <= 0) { x = Math.max(0, Math.min(max, x)); dir *= -1; rest = 8; }
        else if (k % 60 === 0) rest = 12;                  // every ~5 s, a short pause
        b.classList.toggle("step", k % 2 === 0);
        b.style.transform = `translateX(${x}px)`;
    }, 1000 / 12);
})();
