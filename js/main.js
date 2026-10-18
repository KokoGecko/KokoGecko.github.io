// js/main.js — starts the 3D blossom grove in the hero and connects it to the page.
//
// The page already works without this file: script.js draws the pixel Koko and runs the coins.
// This module only ADDS the 3D version on top. If anything goes wrong (no WebGL, a file fails to
// load, an error while drawing) we stop, and the pixel Koko simply stays.
//
// Who does what:
//   js/grove-b.js                  builds the island, camera and lights  (createGrove)
//   js/koko-model.js               builds the voxel Koko                 (buildKoko)
//   js/koko-anim.js                moves Koko: idle, hop, look around…   (createKokoAnimator)
//   this file                      renderer, frame loop, pointer/scroll input, page buttons

// ---------- 1. Settings ----------
const params = new URLSearchParams(location.search);
const captureMode = params.get("capture") === "1";           // screenshots: no loop, step by hand

const MAX_DT = 0.1;              // never advance more than 0.1 s in one frame (after a tab switch, etc.)
const POINTER_EASE = 4;          // how quickly the parallax follows the pointer (bigger = snappier)
const RAIN_COOLDOWN_MS = 2500;   // the RAIN button can make it rain at most this often
let introMax = 7;                // seconds of animation: show "Hi." by then even if the intro never says it's done
const LOOK_DISTANCE = 0.4;       // the "look plane" sits 40% of the way from Koko to the camera
const BUBBLE_TAIL = { x: 10, y: 12 };   // where the bubble's tail tip is, from its bottom-left corner (px)

const html = document.documentElement;
const hero = document.querySelector(".hero");
const canvas = document.getElementById("grove");
const stage = document.getElementById("stage");
const walker = stage.querySelector(".walker");
const bubble = document.getElementById("bubble");
const kokoHit = document.getElementById("koko-hit");
const rainButton = document.querySelector(".rain-btn");
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

// Capture mode: screenshot scripts wait for window.__koko.ready, then drive frames themselves.
let resolveReady;
const ready = new Promise((resolve) => { resolveReady = resolve; });
if (captureMode) {
    window.__koko = { ready };
}

// ---------- 2. Can this browser draw 3D? ----------
// three.js needs WebGL 2. We ask a throwaway canvas for it, then give the context back.
function hasWebGL2() {
    try {
        const testCanvas = document.createElement("canvas");
        const gl = testCanvas.getContext("webgl2");
        if (!gl) return false;
        const loseContext = gl.getExtension("WEBGL_lose_context");
        if (loseContext) loseContext.loseContext();
        return true;
    } catch (error) {
        return false;
    }
}

// ---------- 3. Load the 3D code ----------
// import() loads a module only when we ask, so phones without WebGL never download three.js.
// Paths are relative to this file (js/), and "three" comes from the import map in index.html.
async function loadModules() {
    const [THREE, model, anim, groveModule] = await Promise.all([
        import("three"),
        import("./koko-model.js"),
        import("./koko-anim.js"),
        import("./grove-b.js")
    ]);
    return { THREE, model, anim, groveModule };
}

// Everything the running grove needs lives in this one object (filled in by start()).
const world = {
    THREE: null,
    renderer: null,
    grove: null,
    koko: null,
    animator: null,
    kokoBox: null,           // Koko's size as a box, measured once at rest (root-local)
    elapsed: 0,              // seconds of animation so far
    failed: false
};

// The page state the frame loop reads
const view = {
    width: 1,
    height: 1,
    heroTop: 0,              // the hero's top edge, in page pixels (so we never measure while scrolling)
    stageX: 0,               // the stage's top-left corner, inside the hero
    stageY: 0,
    bubbleH: 0,
    hitW: 0,
    hitH: 0,
    visible: true,           // is the hero on screen?
    reducedMotion: reducedMotionQuery.matches
};

const input = {
    pointer: { x: 0, y: 0 },         // smoothed parallax, -1..1 (x right, y up) — what the grove gets
    scroll: 0                        // 0 at the top of the hero … 1 when it has scrolled away
};
const pointerTarget = { x: 0, y: 0 };    // where the pointer really is, -1..1
let pointerClient = null;                // last pointer position in window pixels, or null
let pointerMoved = false;                // did it move since the last frame?

// ---------- 4. The renderer ----------
function createRenderer(THREE) {
    const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: true                      // transparent: the CSS pink gradient shows through
    });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Tone mapping squeezes very bright light into the colours a screen can show, like a camera.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    // Phones can have 3x screens; 2x looks the same and costs far less.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    return renderer;
}

// "low" quality for touch phones and narrow screens: fewer petals, no realtime shadows, etc.
function pickQuality() {
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    return coarse || window.innerWidth < 768 ? "low" : "high";
}

// ---------- 5. Build the world: grove + Koko + animator ----------
function buildWorld({ THREE, model, anim, groveModule }) {
    world.THREE = THREE;
    world.renderer = createRenderer(THREE);

    world.grove = groveModule.createGrove({
        renderer: world.renderer,
        reducedMotion: view.reducedMotion,
        quality: pickQuality()
    });

    world.koko = model.buildKoko({ bow: "ribbon" });

    // Measure Koko once, standing still, before placing him: this box is in his own (root) space.
    world.koko.root.updateMatrixWorld(true);
    world.kokoBox = new THREE.Box3().setFromObject(world.koko.root);

    world.grove.kokoSpot.add(world.koko.root);
    if (world.koko.cloud) {
        world.grove.scene.add(world.koko.cloud.root);    // the rain cloud floats free; the animator moves it
    }

    world.animator = anim.createKokoAnimator(world.koko, { reducedMotion: view.reducedMotion });

    // The monsoon story: the animator says when the rain starts and stops, the island makes the weather.
    // (setWeather eases the change itself, so a plain 1 or 0 is enough.)
    world.animator.on("rain-start", () => world.grove.setWeather(1));
    world.animator.on("rain-stop", () => world.grove.setWeather(0));
    world.animator.on("intro-done", () => world.grove.setWeather(0));   // in case the intro was cut short

    // The animator publishes its timings; give the intro half a second more before the safety net.
    const timing = anim.KOKO_TIMING && anim.KOKO_TIMING.introMonsoon;
    if (timing && timing.duration) introMax = timing.duration + 0.5;
}

// ---------- 6. Layout: where is the stage, how big is the hero? ----------
// The CSS decides where Koko stands (the pixel sprite's spot in .stage). We tell the grove, so the
// 3D Koko lands in the same place as the pixel one would.
function measureLayout() {
    const heroBox = hero.getBoundingClientRect();
    const stageBox = stage.getBoundingClientRect();
    // The pixel sprite is hidden in 3D mode but keeps its place, so it marks where Koko stands.
    const spriteBox = walker.getBoundingClientRect();

    view.width = Math.max(1, Math.round(heroBox.width));
    view.height = Math.max(1, Math.round(heroBox.height));
    view.heroTop = heroBox.top + window.scrollY;
    view.stageX = stageBox.left - heroBox.left;
    view.stageY = stageBox.top - heroBox.top;
    view.bubbleH = bubble.offsetHeight;

    // Koko's middle goes where the pixel sprite's middle is (0..1 across the hero, y down)
    return {
        kokoX: (spriteBox.left + spriteBox.width / 2 - heroBox.left) / view.width,
        kokoY: (spriteBox.top + spriteBox.height / 2 - heroBox.top) / view.height
    };
}

function resize() {
    if (!world.grove || world.failed) return;
    const layout = measureLayout();
    world.renderer.setSize(view.width, view.height, false);   // false: CSS already sizes the canvas
    world.grove.resize(view.width, view.height, layout);
    measureKokoHit();
    // A resize clears the canvas. If no loop is running (reduced motion, capture), draw once now.
    if (!isLooping()) renderFrame();
}

// ---------- 7. Pointer and scroll input ----------
function onPointerMove(event) {
    pointerClient = { x: event.clientX, y: event.clientY };
    pointerMoved = true;
    // -1..1 across the hero; y is flipped so up is positive (like three.js)
    const top = view.heroTop - window.scrollY;
    pointerTarget.x = clamp((event.clientX / view.width) * 2 - 1, -1, 1);
    pointerTarget.y = clamp(-(((event.clientY - top) / view.height) * 2 - 1), -1, 1);
}

function onPointerLeave() {
    pointerClient = null;
    pointerTarget.x = 0;
    pointerTarget.y = 0;
    if (world.animator) world.animator.lookAt(null);   // relax: stop following
}

function updateInput(dt) {
    // Ease the parallax towards the pointer. 1 - e^(-k·dt) gives the same feel at any frame rate.
    const ease = 1 - Math.exp(-POINTER_EASE * dt);
    input.pointer.x += (pointerTarget.x - input.pointer.x) * ease;
    input.pointer.y += (pointerTarget.y - input.pointer.y) * ease;
    input.scroll = clamp((window.scrollY - view.heroTop) / view.height, 0, 1);

    // Koko looks at the pointer (only when it moved, so he can still doze off when you stop).
    // With reduced motion he keeps still.
    if (pointerMoved && pointerClient && !view.reducedMotion) {
        const target = screenToWorld(pointerClient.x, pointerClient.y, LOOK_DISTANCE);
        if (target) world.animator.lookAt(target);
        pointerMoved = false;
    }
}

// Turn a point on the screen into a point in the 3D world:
// shoot a ray from the camera through that pixel and see where it crosses a flat plane that faces
// the camera. towardCamera = 0 puts the plane through Koko; 0.4 puts it 40% of the way to the camera.
function screenToWorld(clientX, clientY, towardCamera) {
    const THREE = world.THREE;
    const camera = world.grove.camera;
    const top = view.heroTop - window.scrollY;
    const ndc = new THREE.Vector2(
        (clientX / view.width) * 2 - 1,
        -((clientY - top) / view.height) * 2 + 1
    );

    const kokoCentre = new THREE.Vector3();
    world.kokoBox.getCenter(kokoCentre);
    world.koko.root.localToWorld(kokoCentre);

    const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
    const facing = camera.getWorldDirection(new THREE.Vector3());      // where the camera looks
    const planePoint = kokoCentre.clone().lerp(cameraPosition, towardCamera);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(facing, planePoint);

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray.intersectPlane(plane, new THREE.Vector3());   // null if it misses
}

// ---------- 8. Page overlays that follow Koko: the "Hi." bubble and the click area ----------
// We project 3D points to screen pixels (Vector3.project gives -1..1 "normalised device coords").
function toHeroPixels(worldPoint) {
    const p = worldPoint.clone().project(world.grove.camera);
    return { x: (p.x + 1) / 2 * view.width, y: (1 - p.y) / 2 * view.height };
}

// Koko's resting box (8 corners) on screen → the click area's size. Measured on resize only.
function kokoScreenBox(useRestPose) {
    const THREE = world.THREE;
    const box = world.kokoBox;
    // At rest we use the parent (kokoSpot), so hops and wiggles don't change the result.
    const space = useRestPose ? world.koko.root.parent : world.koko.root;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < 8; i++) {
        const corner = new THREE.Vector3(
            i & 1 ? box.max.x : box.min.x,
            i & 2 ? box.max.y : box.min.y,
            i & 4 ? box.max.z : box.min.z
        );
        const p = toHeroPixels(space.localToWorld(corner));
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function measureKokoHit() {
    world.grove.scene.updateMatrixWorld(true);
    world.grove.camera.updateMatrixWorld(true);
    const box = kokoScreenBox(true);
    view.hitW = Math.max(44, Math.round(box.w));     // never smaller than a 44px tap target
    view.hitH = Math.max(44, Math.round(box.h));
    kokoHit.style.width = view.hitW + "px";
    kokoHit.style.height = view.hitH + "px";
}

let lastBubble = "";
let lastHit = "";

function placeOverlays() {
    const THREE = world.THREE;
    const koko = world.koko;

    // Bubble: its tail points at a spot just above Koko's head, at rest (it doesn't hop with him).
    const anchor = (koko.anchors.bowTop || koko.anchors.headTop).clone().add(new THREE.Vector3(1, 2, 0));
    const tip = toHeroPixels(koko.root.parent.localToWorld(anchor));
    const bx = Math.round(tip.x - view.stageX - BUBBLE_TAIL.x);
    const by = Math.round(tip.y - view.stageY - view.bubbleH - BUBBLE_TAIL.y);
    const bubbleTransform = `translate3d(${bx}px, ${by}px, 0)`;
    if (bubbleTransform !== lastBubble) {           // only touch the page when something changed
        bubble.style.transform = bubbleTransform;
        lastBubble = bubbleTransform;
    }

    // Click area: centred on Koko's current screen box (this one follows the hop)
    const box = kokoScreenBox(false);
    const hx = Math.round(box.x + box.w / 2 - view.hitW / 2 - view.stageX);
    const hy = Math.round(box.y + box.h / 2 - view.hitH / 2 - view.stageY);
    const hitTransform = `translate3d(${hx}px, ${hy}px, 0)`;
    if (hitTransform !== lastHit) {
        kokoHit.style.transform = hitTransform;
        lastHit = hitTransform;
    }
}

// ---------- 9. Page events: Koko, coins, the RAIN button ----------
function play(name, opts) {
    if (!world.animator || world.failed) return;
    if (name === "intro-monsoon") opts = Object.assign(monsoonOptions(), opts);
    world.animator.play(name, opts);
    if (view.reducedMotion) renderStill();          // no loop: show the new pose right away
}

function onKokoClick() {
    play("hop");
}

// script.js sends "koko:coin" with the coin's screen position
function onCoin(event) {
    if (!world.animator) return;
    const target = screenToWorld(event.detail.x, event.detail.y, 0);
    if (!target) return;
    play("collect", { target });
    if (!view.reducedMotion) world.grove.burstPetals(target);
}

let lastRain = -Infinity;
function onRainHint() {
    const now = performance.now();
    if (now - lastRain < RAIN_COOLDOWN_MS) return;
    lastRain = now;
    play("rain");            // just a little show: the link still works as normal
}

function listenToPage() {
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerdown", onPointerMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
    kokoHit.addEventListener("click", onKokoClick);
    document.addEventListener("koko:coin", onCoin);
    if (rainButton) {
        rainButton.addEventListener("pointerenter", onRainHint);
        rainButton.addEventListener("focus", onRainHint);
    }
    canvas.addEventListener("webglcontextlost", (event) => {
        event.preventDefault();
        fail(new Error("WebGL context lost"));
    });
}

// ---------- 10. The opening scene (once per page load) ----------
// "intro-monsoon": the sky turns, Koko scurries under the big leaf, then shakes off when the sun returns.
// The animator needs to know where the shelter is, as a point in the world.
function monsoonOptions() {
    const props = world.grove.props || {};
    const shelter = props.shelterPoint || props.shelterSpot;
    const opts = { leaf: props.leaf };
    if (shelter) {
        world.grove.scene.updateMatrixWorld(true);
        // shelterPoint may be a Vector3 already, or an Object3D we ask for its world position
        opts.shelterPoint = shelter.isObject3D
            ? shelter.getWorldPosition(new world.THREE.Vector3())
            : shelter.clone();
    }
    return opts;
}

function showBubble() {
    html.classList.remove("intro-playing");
}

function playIntro() {
    if (view.reducedMotion || captureMode) return;

    // "Hi." waits until Koko has finished his entrance (or introMax seconds, see step())
    html.classList.add("intro-playing");
    world.animator.on("intro-done", showBubble);

    play("intro-monsoon");
}

// ---------- 11. The frame loop ----------
// requestAnimationFrame calls tick() before every screen refresh (about 60 times a second).
let rafId = 0;
let lastTime = 0;

function step(dt) {
    dt = clamp(dt, 0, MAX_DT);
    world.elapsed += dt;
    if (world.elapsed > introMax) showBubble();       // safety net, in animation time (not wall-clock)
    updateInput(dt);
    world.animator.update(dt, world.elapsed);
    world.grove.update(dt, world.elapsed, input);
}

function renderFrame() {
    if (!world.grove || world.failed) return;
    world.renderer.render(world.grove.scene, world.grove.camera);
    placeOverlays();
}

// Reduced motion: one still frame whenever something changes, never a loop
function renderStill() {
    if (!world.grove || world.failed || isLooping() || captureMode) return;
    safely(() => {
        step(0);
        renderFrame();
    });
}

function tick(now) {
    rafId = requestAnimationFrame(tick);
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    safely(() => {
        step(dt);
        renderFrame();
    });
}

function shouldLoop() {
    return !captureMode && !world.failed && !view.reducedMotion && view.visible && !document.hidden;
}
function isLooping() {
    return rafId !== 0;
}

// Start or stop the loop to match the situation (tab hidden, hero scrolled away, reduced motion)
function updateLoop() {
    if (shouldLoop() && !isLooping()) {
        lastTime = performance.now();
        rafId = requestAnimationFrame(tick);
    } else if (!shouldLoop() && isLooping()) {
        cancelAnimationFrame(rafId);
        rafId = 0;
    }
}

function watchVisibility() {
    document.addEventListener("visibilitychange", updateLoop);
    // IntersectionObserver tells us when the hero enters or leaves the screen
    const observer = new IntersectionObserver((entries) => {
        view.visible = entries[entries.length - 1].isIntersecting;
        updateLoop();
    });
    observer.observe(hero);
    // ResizeObserver tells us when the hero changes size (rotation, window resize)
    new ResizeObserver(() => safely(resize)).observe(hero);
}

// ---------- 12. Reduced motion (live: it can change while the page is open) ----------
function applyReducedMotion(on) {
    view.reducedMotion = on;
    world.animator.setReducedMotion(on);
    world.grove.setReducedMotion(on);
    if (on) world.grove.setWeather(0, { immediate: true });   // no storm in a still picture
    updateLoop();
    renderStill();
}

// ---------- 13. Capture mode: step frames by hand (for screenshots) ----------
function exposeCaptureApi() {
    Object.assign(window.__koko, {
        ready,
        renderer: world.renderer,
        step(dt = 1 / 60) { step(dt); },
        render() { renderFrame(); },
        // x, y in -1..1 (x right, y up). Jumps straight there, no easing.
        setPointer(x, y) {
            pointerTarget.x = input.pointer.x = clamp(x, -1, 1);
            pointerTarget.y = input.pointer.y = clamp(y, -1, 1);
            const top = view.heroTop - window.scrollY;
            pointerClient = { x: (x + 1) / 2 * view.width, y: top + (1 - y) / 2 * view.height };
            pointerMoved = true;
        },
        play(name, opts) { play(name, opts); },
        // a still pose, e.g. pose("hero") or pose("idle", 1.5) = the idle loop at 1.5 s
        pose(name, t) { world.animator.pose(name, t); }
    });
}

// ---------- 14. Start, and the safety net ----------
function safely(fn) {
    try {
        fn();
    } catch (error) {
        fail(error);
    }
}

// Something broke: stop drawing and give the page back to the pixel Koko.
function fail(error) {
    if (world.failed) return;
    world.failed = true;
    console.warn("3D grove is off; showing the pixel Koko instead.", error);
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    html.classList.remove("has-3d");
    kokoHit.hidden = true;
    bubble.style.transform = "";
    if (world.renderer) world.renderer.dispose();
    resolveReady(false);
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

async function start() {
    if (!hasWebGL2()) {
        resolveReady(false);
        return;                                   // no WebGL 2: keep the pixel Koko
    }
    try {
        const modules = await loadModules();
        buildWorld(modules);
        measureLayout();
        resize();

        // First frame: if this works, switch the page over to 3D
        step(0);
        renderFrame();
        html.classList.add("has-3d");             // CSS hides the pixel Koko and shows the canvas
        kokoHit.hidden = false;
        resize();                                 // the bubble moved into its 3D spot: measure again

        listenToPage();
        reducedMotionQuery.addEventListener("change", (event) => applyReducedMotion(event.matches));
        if (captureMode) exposeCaptureApi();
        watchVisibility();
        playIntro();
        updateLoop();
        resolveReady(true);
    } catch (error) {
        fail(error);
    }
}

start();
