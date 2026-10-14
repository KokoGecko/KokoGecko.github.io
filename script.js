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
    target.innerHTML =
        `<svg viewBox="0 0 ${cols} ${rows}" shape-rendering="crispEdges" aria-label="pixel gecko">${rects}</svg>`;
}

const gecko = document.getElementById("gecko");
drawGecko(gecko);

// ---------- 2. Click the gecko to make it jump ----------
gecko.addEventListener("click", () => {
    gecko.classList.remove("jump");
    void gecko.offsetWidth;            // restart the animation
    gecko.classList.add("jump");
});

// ---------- 3. Collect coins ----------
const counter = document.getElementById("coin-count");
let coins = 0;

document.querySelectorAll(".coin-wrap").forEach((btn) => {
    btn.addEventListener("click", () => {
        coins += 1;
        counter.textContent = String(coins).padStart(2, "0");
        btn.classList.add("collected");
        // the coin comes back after a moment, so you can keep playing
        setTimeout(() => btn.classList.remove("collected"), 1800);
    });
});
