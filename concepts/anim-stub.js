// anim-stub.js — TEMPORARY crude Koko made of plain boxes.
// It has exactly the same rig (group names, parents and pivots) as the contract for js/koko-model.js,
// so the animator can be built and tested before the real voxel model exists. Delete once the real model ships.
import * as THREE from "three";

// ---------- 1. Tiny helpers ----------
const materials = new Map();

function mat(colour) {
    if (!materials.has(colour)) {
        materials.set(colour, new THREE.MeshStandardMaterial({ color: colour, roughness: 0.55 }));
    }
    return materials.get(colour);
}

// Add a box (centred at x, y, z in the group's own space) to a group.
function box(group, w, h, d, x, y, z, colour) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(colour));
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
}

// A pivot is just an empty Group placed where a part should bend; the part's boxes hang off it.
function pivot(parent, x, y, z) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    return g;
}

// ---------- 2. Build the stub ----------
export function buildKoko({ bow = "round", withCloud = true } = {}) {
    const G = "#43b047", L = "#8be28b", D = "#2e8b3a", K = "#2b2b3a", P = "#ff8fab";

    const root = new THREE.Group();
    root.name = "koko-root";

    // body: pivot at the torso centre (4 above the ground)
    const body = pivot(root, 1, 4, 0);
    box(body, 10, 4, 5, 0, 0, 0, G);
    box(body, 8, 1, 4.6, 0.5, -1.2, 0.3, L);          // belly stripe
    box(body, 1, 1, 0.2, -1.5, -1.5, 2.55, D);       // spots
    box(body, 1, 1, 0.2, 5.5, -1.5, 2.55, D);

    // head: pivot at the neck
    const head = pivot(body, 1.5, 1.5, 0);
    box(head, 7, 4, 5, 2.5, 2.5, 0, G);
    box(head, 5, 2.4, 5.2, 3.0, 2.2, 0, L);
    box(head, 2, 1, 0.2, 5.5, 1.5, 2.65, P);         // blush

    function makeEye(side) {
        const z = side * 2.62;
        const eye = pivot(head, 2.5, 3.0, z);
        box(eye, 2, 1.2, 0.2, 0, 0, 0, "#ffffff");
        const pupil = pivot(eye, 0.5, 0, side * 0.12);
        box(pupil, 1, 1, 0.15, 0, 0, 0, K);
        eye.userData.pupil = pupil;
        // lid: pivot on the TOP edge, plate hangs down, so scale.y shrinks it up into the brow
        const lid = pivot(head, 2.5, 3.65, side * 2.78);
        box(lid, 2.2, 1.3, 0.15, 0, -0.65, 0, G);
        lid.scale.y = 0.001;
        lid.visible = false;
        return { eye, lid };
    }
    const er = makeEye(1);
    const el = makeEye(-1);

    // tongue: pivot at the mouth, sticks out along +X
    const tongue = pivot(head, 6.0, 1.0, 0);
    box(tongue, 4, 0.45, 0.7, 2, 0, 0, "#ff6f91");
    tongue.scale.x = 0.0001;
    tongue.visible = false;

    // bow: knot on top of the head near the eye, loops either side along X
    const bowG = pivot(head, 1.6, 4.5, 1.2);
    box(bowG, 1, 1, 1, 0, 0.5, 0, "#ff8fab");
    const loopL = pivot(bowG, -0.5, 0.5, 0);
    const loopR = pivot(bowG, 0.5, 0.5, 0);
    const loopLen = bow === "ribbon" ? 2 : 1.5;
    box(loopL, loopLen, 1.5, 1, -loopLen / 2, 0.3, 0, "#ff8fab");
    box(loopR, loopLen, 1.5, 1, loopLen / 2, 0.3, 0, "#ff8fab");

    // tail chain
    const t0 = pivot(body, -5, 0.3, 0);
    box(t0, 2.5, 2.2, 2.4, -1.25, 0, 0, G);
    const t1 = pivot(t0, -2.5, 0.1, 0);
    box(t1, 2, 1.6, 1.8, -1, 0, 0, G);
    const t2 = pivot(t1, -2, 0.1, 0);
    box(t2, 2, 1.1, 1.2, -1, 0, 0, D);
    t2.rotation.z = -0.3;

    // legs: pivot at the hip / shoulder, 2 voxels long so the feet touch y = 0
    function leg(x, z) {
        const g = pivot(body, x, -2, z);
        box(g, 1.6, 2, 1.6, 0, -1, 0, G);
        return g;
    }
    const legs = { fl: leg(3.5, -1.6), fr: leg(3.5, 1.6), bl: leg(-2.8, -1.6), br: leg(-2.8, 1.6) };

    // cloud (not parented to root)
    let cloud = null;
    if (withCloud) {
        const croot = new THREE.Group();
        croot.name = "koko-cloud";
        const puff = pivot(croot, 0, 0, 0);
        box(puff, 7, 2, 3.4, 0, 0, 0, "#ffffff");
        box(puff, 4, 1.5, 3, -0.5, 1.4, 0, "#ffffff");
        box(puff, 2, 1, 2.6, 1.5, 2.2, 0, "#ffffff");
        const drops = [];
        for (let i = 0; i < 4; i++) {
            const d = pivot(croot, -2.4 + i * 1.6, -1.6, 0);
            box(d, 0.5, 0.8, 0.5, 0, 0, 0, "#5aa9ff");
            drops.push(d);
        }
        cloud = { root: croot, puff, drops };
    }

    const anchors = {
        mouth: new THREE.Vector3(8.5, 6.5, 0),
        headTop: new THREE.Vector3(5, 10, 0),
        bowTop: new THREE.Vector3(4.1, 11.5, 1.2),
        cloudHome: new THREE.Vector3(2, 15.5, 0)
    };

    return {
        root,
        rig: {
            body, head,
            eyes: { l: el.eye, r: er.eye },
            lids: { l: el.lid, r: er.lid },
            tongue,
            tail: [t0, t1, t2],
            legs,
            bow: bowG,
            bowLoops: { l: loopL, r: loopR }
        },
        cloud,
        anchors,
        size: { length: 16, height: 10, depth: 5 },
        stats: { voxels: 0, triangles: 0, meshes: 0 },
        dispose() {}
    };
}
