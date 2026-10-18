// script.js — the pixel Koko and the coins.
// This file works on its own. If the 3D grove (js/main.js) cannot run,
// everything here still does: pixel Koko jumps, coins fill the counter.

// ---------- 1. Draw the pixel gecko from a text map ----------
// Each character is one pixel. The letter picks the colour.
const art = [
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

const colours = {
    G: "#43b047",   // body green
    L: "#8be28b",   // light belly / face
    D: "#2e8b3a",   // dark spots
    W: "#ffffff",   // eye white
    K: "#2b2b3a",   // pupil
    P: "#ff8fab"    // cheek blush
};

function drawGecko(target) {
    const rows = art.length;
    const cols = art[0].length;
    let rects = "";
    art.forEach((row, y) => {
        [...row].forEach((ch, x) => {
            if (colours[ch]) {
                rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${colours[ch]}"/>`;
            }
        });
    });
    // aria-hidden: the button around it already says "Make Koko jump"
    target.innerHTML =
        `<svg viewBox="0 0 ${cols} ${rows}" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
}

const gecko = document.getElementById("gecko");
drawGecko(gecko);

// ---------- 2. Click (or press Enter / Space on) the gecko to make it jump ----------
// Restarting a CSS animation: remove the class, force the browser to notice, add it back.
function restartAnimation(element, className) {
    element.classList.remove(className);
    void element.offsetWidth;            // reading a size makes the browser apply the removal now
    element.classList.add(className);
}

gecko.addEventListener("click", () => restartAnimation(gecko, "jump"));
gecko.addEventListener("animationend", () => gecko.classList.remove("jump"));

// ---------- 3. Collect coins ----------
const counter = document.getElementById("coin-count");
const score = document.getElementById("score");
const COIN_RETURN_MS = 1800;            // a collected coin comes back after this long
let coins = 0;

function collectCoin(btn) {
    if (btn.classList.contains("collected")) return;   // already gone, wait for it to return

    coins += 1;
    counter.textContent = String(coins).padStart(2, "0");
    btn.classList.add("collected");
    restartAnimation(score, "got");                   // the little coin in the nav pops

    // Tell anyone listening (the 3D grove in js/main.js) where the coin was,
    // in screen pixels, so Koko can look at it and petals can burst there.
    const box = btn.getBoundingClientRect();
    document.dispatchEvent(new CustomEvent("koko:coin", {
        detail: { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    }));

    // the coin comes back after a moment, so you can keep playing
    setTimeout(() => btn.classList.remove("collected"), COIN_RETURN_MS);
}

document.querySelectorAll(".coin-wrap").forEach((btn) => {
    btn.addEventListener("click", () => collectCoin(btn));
});
