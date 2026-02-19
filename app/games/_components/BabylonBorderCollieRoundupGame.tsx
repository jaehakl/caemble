"use client";

import { useEffect, useRef, useState } from "react";
import { loadGameSave, saveGameSave } from "@/app/lib/save-protocol";
import styles from "./BabylonBorderCollieRoundupGame.module.css";

const GAME_SLUG = "phaser-border-collie-roundup";
const GAME_TITLE = "Border Collie Roundup 3D";

const ROUND_SECONDS = 90;
const SHEEP_COUNT = 12;
const FIELD_HALF = 38;
const DOG_SPEED = 16;
const SHEEP_MAX_SPEED = 8.8;
const SHEEP_SCARE_RADIUS = 12;
const PEN_CENTER = { x: 25, z: -24 };
const PEN_SIZE = 14;
const PEN_HALF = PEN_SIZE / 2;

type BabylonRuntime = typeof import("@babylonjs/core");

type SheepAgent = {
  mesh: import("@babylonjs/core").Mesh;
  material: import("@babylonjs/core").StandardMaterial;
  velocity: import("@babylonjs/core").Vector3;
  wanderTime: number;
  captured: boolean;
  penSlot: import("@babylonjs/core").Vector3;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function randomInRange(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function isInsidePen(x: number, z: number) {
  return (
    x >= PEN_CENTER.x - PEN_HALF &&
    x <= PEN_CENTER.x + PEN_HALF &&
    z >= PEN_CENTER.z - PEN_HALF &&
    z <= PEN_CENTER.z + PEN_HALF
  );
}

function createPenSlots(B: BabylonRuntime) {
  const slots: import("@babylonjs/core").Vector3[] = [];
  const startX = PEN_CENTER.x - PEN_HALF + 2.2;
  const startZ = PEN_CENTER.z - PEN_HALF + 2.2;
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      slots.push(new B.Vector3(startX + col * 3.1, 0.85, startZ + row * 3.1));
    }
  }
  return slots;
}

export function BabylonBorderCollieRoundupGame() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [runId, setRunId] = useState(0);
  const [status, setStatus] = useState("Running");
  const [herded, setHerded] = useState(0);
  const [timeLeft, setTimeLeft] = useState(ROUND_SECONDS);
  const [isRoundOver, setIsRoundOver] = useState(false);
  const [bestHerded, setBestHerded] = useState(() => {
    if (typeof window === "undefined") return 0;
    const saved = loadGameSave<{ bestHerded?: number }>(GAME_SLUG);
    if (saved?.data && typeof saved.data.bestHerded === "number") {
      return Math.max(0, Math.floor(saved.data.bestHerded));
    }
    return 0;
  });
  const [bestClearTime, setBestClearTime] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const saved = loadGameSave<{ bestClearTime?: number }>(GAME_SLUG);
    if (saved?.data && typeof saved.data.bestClearTime === "number") {
      const value = Math.floor(saved.data.bestClearTime);
      return value > 0 ? value : null;
    }
    return null;
  });

  useEffect(() => {
    saveGameSave(GAME_SLUG, GAME_TITLE, { bestHerded, bestClearTime });
  }, [bestClearTime, bestHerded]);

  useEffect(() => {
    if (!mountRef.current) {
      return;
    }

    let disposed = false;
    let cleanup: (() => void) | null = null;

    const start = async () => {
      const B = await import("@babylonjs/core");
      if (disposed || !mountRef.current) {
        return;
      }

      setStatus("Running");
      setHerded(0);
      setTimeLeft(ROUND_SECONDS);
      setIsRoundOver(false);

      const canvas = document.createElement("canvas");
      canvas.className = styles.canvas;
      mountRef.current.innerHTML = "";
      mountRef.current.appendChild(canvas);

      const engine = new B.Engine(canvas, true, {
        preserveDrawingBuffer: true,
        stencil: true,
      });
      const scene = new B.Scene(engine);
      scene.clearColor = new B.Color4(0.72, 0.89, 0.98, 1);

      const camera = new B.ArcRotateCamera(
        "camera",
        -Math.PI / 2,
        1.1,
        52,
        new B.Vector3(0, 0.7, 0),
        scene,
      );
      camera.attachControl(canvas, true);
      camera.lowerRadiusLimit = 38;
      camera.upperRadiusLimit = 70;
      camera.lowerBetaLimit = 0.8;
      camera.upperBetaLimit = 1.35;
      camera.wheelDeltaPercentage = 0.02;

      const sun = new B.DirectionalLight("sun", new B.Vector3(-0.35, -1, -0.25), scene);
      sun.intensity = 1.15;
      const sky = new B.HemisphericLight("sky", new B.Vector3(0, 1, 0), scene);
      sky.intensity = 0.65;

      const ground = B.MeshBuilder.CreateGround("ground", { width: 120, height: 120 }, scene);
      const groundMat = new B.StandardMaterial("ground-mat", scene);
      groundMat.diffuseColor = new B.Color3(0.3, 0.58, 0.28);
      groundMat.specularColor = B.Color3.Black();
      ground.material = groundMat;

      const fieldMat = new B.StandardMaterial("field-mat", scene);
      fieldMat.diffuseColor = new B.Color3(0.26, 0.5, 0.24);
      fieldMat.specularColor = B.Color3.Black();
      const field = B.MeshBuilder.CreateGround("field", { width: FIELD_HALF * 2, height: FIELD_HALF * 2 }, scene);
      field.position.y = 0.02;
      field.material = fieldMat;

      const fenceMat = new B.StandardMaterial("fence-mat", scene);
      fenceMat.diffuseColor = new B.Color3(0.49, 0.31, 0.17);
      fenceMat.specularColor = B.Color3.Black();
      const fenceHeight = 1.6;
      const fenceWidth = FIELD_HALF * 2 + 1;
      const topFence = B.MeshBuilder.CreateBox("fence-top", { width: fenceWidth, height: fenceHeight, depth: 0.5 }, scene);
      topFence.position.set(0, fenceHeight / 2, -FIELD_HALF);
      topFence.material = fenceMat;
      const bottomFence = topFence.clone("fence-bottom");
      if (bottomFence) {
        bottomFence.position.z = FIELD_HALF;
      }
      const leftFence = B.MeshBuilder.CreateBox("fence-left", { width: 0.5, height: fenceHeight, depth: fenceWidth }, scene);
      leftFence.position.set(-FIELD_HALF, fenceHeight / 2, 0);
      leftFence.material = fenceMat;
      const rightFence = leftFence.clone("fence-right");
      if (rightFence) {
        rightFence.position.x = FIELD_HALF;
      }

      const penFloor = B.MeshBuilder.CreateGround("pen-floor", { width: PEN_SIZE, height: PEN_SIZE }, scene);
      penFloor.position.set(PEN_CENTER.x, 0.04, PEN_CENTER.z);
      const penMat = new B.StandardMaterial("pen-mat", scene);
      penMat.diffuseColor = new B.Color3(0.56, 0.66, 0.2);
      penMat.specularColor = B.Color3.Black();
      penFloor.material = penMat;

      const penFenceMat = new B.StandardMaterial("pen-fence-mat", scene);
      penFenceMat.diffuseColor = new B.Color3(0.94, 0.8, 0.25);
      penFenceMat.emissiveColor = new B.Color3(0.1, 0.08, 0.01);
      const penFenceHeight = 2.1;
      const penFenceDepth = 0.4;
      const penTop = B.MeshBuilder.CreateBox("pen-top", { width: PEN_SIZE, height: penFenceHeight, depth: penFenceDepth }, scene);
      penTop.position.set(PEN_CENTER.x, penFenceHeight / 2, PEN_CENTER.z - PEN_HALF);
      penTop.material = penFenceMat;
      const penBottom = penTop.clone("pen-bottom");
      if (penBottom) {
        penBottom.position.z = PEN_CENTER.z + PEN_HALF;
      }
      const penLeft = B.MeshBuilder.CreateBox("pen-left", { width: penFenceDepth, height: penFenceHeight, depth: PEN_SIZE }, scene);
      penLeft.position.set(PEN_CENTER.x - PEN_HALF, penFenceHeight / 2, PEN_CENTER.z);
      penLeft.material = penFenceMat;
      const penRight = penLeft.clone("pen-right");
      if (penRight) {
        penRight.position.x = PEN_CENTER.x + PEN_HALF;
      }

      const dogRoot = new B.TransformNode("dog-root", scene);
      dogRoot.position.set(-22, 0.85, 24);
      const dogBody = B.MeshBuilder.CreateCapsule("dog-body", { radius: 0.8, height: 2.7 }, scene);
      dogBody.parent = dogRoot;
      dogBody.rotation.z = Math.PI / 2;
      dogBody.position.y = 0.1;
      const dogMat = new B.StandardMaterial("dog-mat", scene);
      dogMat.diffuseColor = new B.Color3(0.08, 0.08, 0.1);
      dogMat.specularColor = B.Color3.Black();
      dogBody.material = dogMat;
      const dogChest = B.MeshBuilder.CreateSphere("dog-chest", { diameter: 1 }, scene);
      dogChest.parent = dogRoot;
      dogChest.position.set(0.8, 0.2, 0);
      const chestMat = new B.StandardMaterial("dog-chest-mat", scene);
      chestMat.diffuseColor = new B.Color3(0.92, 0.94, 0.96);
      chestMat.specularColor = B.Color3.Black();
      dogChest.material = chestMat;
      const dogHead = B.MeshBuilder.CreateSphere("dog-head", { diameter: 1.05 }, scene);
      dogHead.parent = dogRoot;
      dogHead.position.set(1.7, 0.5, 0);
      dogHead.material = dogMat;

      const sheepSlots = createPenSlots(B);
      const sheepList: SheepAgent[] = [];

      for (let i = 0; i < SHEEP_COUNT; i += 1) {
        const sheepRoot = new B.Mesh(`sheep-${i}`, scene);
        const body = B.MeshBuilder.CreateSphere(`sheep-body-${i}`, { diameterX: 1.75, diameterY: 1.2, diameterZ: 1.25 }, scene);
        body.parent = sheepRoot;
        body.position.y = 0.65;
        const head = B.MeshBuilder.CreateSphere(`sheep-head-${i}`, { diameter: 0.62 }, scene);
        head.parent = sheepRoot;
        head.position.set(0.86, 0.62, 0);

        const sheepMat = new B.StandardMaterial(`sheep-mat-${i}`, scene);
        sheepMat.diffuseColor = new B.Color3(0.96, 0.96, 0.96);
        sheepMat.specularColor = B.Color3.Black();
        body.material = sheepMat;

        const sheepHeadMat = new B.StandardMaterial(`sheep-head-mat-${i}`, scene);
        sheepHeadMat.diffuseColor = new B.Color3(0.22, 0.24, 0.27);
        sheepHeadMat.specularColor = B.Color3.Black();
        head.material = sheepHeadMat;

        let spawnX = randomInRange(-FIELD_HALF + 4, FIELD_HALF - 8);
        let spawnZ = randomInRange(-FIELD_HALF + 4, FIELD_HALF - 4);
        if (isInsidePen(spawnX, spawnZ)) {
          spawnX = -spawnX;
          spawnZ += 10;
        }
        sheepRoot.position.set(spawnX, 0, spawnZ);

        sheepList.push({
          mesh: sheepRoot,
          material: sheepMat,
          velocity: new B.Vector3(randomInRange(-1, 1), 0, randomInRange(-1, 1)),
          wanderTime: randomInRange(0.2, 1.2),
          captured: false,
          penSlot: sheepSlots[i],
        });
      }

      const keys = {
        ArrowUp: false,
        ArrowDown: false,
        ArrowLeft: false,
        ArrowRight: false,
        w: false,
        a: false,
        s: false,
        d: false,
      };

      const onKeyDown = (event: KeyboardEvent) => {
        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
        if (key in keys) {
          keys[key as keyof typeof keys] = true;
        }
      };
      const onKeyUp = (event: KeyboardEvent) => {
        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
        if (key in keys) {
          keys[key as keyof typeof keys] = false;
        }
      };
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup", onKeyUp);

      const onResize = () => {
        engine.resize();
      };
      window.addEventListener("resize", onResize);

      let elapsed = 0;
      let lastSecond = ROUND_SECONDS;
      let herdedCount = 0;
      let roundOver = false;

      engine.runRenderLoop(() => {
        const dt = engine.getDeltaTime() / 1000;

        if (!roundOver) {
          const inputX = (keys.d || keys.ArrowRight ? 1 : 0) - (keys.a || keys.ArrowLeft ? 1 : 0);
          const inputZ = (keys.w || keys.ArrowUp ? 1 : 0) - (keys.s || keys.ArrowDown ? 1 : 0);

          if (inputX !== 0 || inputZ !== 0) {
            const dir = new B.Vector3(inputX, 0, inputZ).normalize();
            dogRoot.position.addInPlace(dir.scale(DOG_SPEED * dt));
            dogRoot.rotation.y = Math.atan2(dir.x, dir.z);
          }

          dogRoot.position.x = clamp(dogRoot.position.x, -FIELD_HALF + 1.8, FIELD_HALF - 1.8);
          dogRoot.position.z = clamp(dogRoot.position.z, -FIELD_HALF + 1.8, FIELD_HALF - 1.8);

          herdedCount = 0;
          for (const sheep of sheepList) {
            if (!sheep.captured) {
              const toDog = sheep.mesh.position.subtract(dogRoot.position);
              toDog.y = 0;
              const dogDistance = toDog.length();

              let desired = new B.Vector3(0, 0, 0);
              if (dogDistance < SHEEP_SCARE_RADIUS) {
                const away = toDog.scale(1 / Math.max(0.001, dogDistance));
                const panic = 0.4 + (1 - dogDistance / SHEEP_SCARE_RADIUS) * 1.2;
                desired = away.scale(SHEEP_MAX_SPEED * panic);
              } else {
                sheep.wanderTime -= dt;
                if (sheep.wanderTime <= 0) {
                  sheep.wanderTime = randomInRange(0.5, 1.8);
                  sheep.velocity.x += randomInRange(-2.4, 2.4);
                  sheep.velocity.z += randomInRange(-2.4, 2.4);
                }
                desired = sheep.velocity.clone();
              }

              sheep.velocity = B.Vector3.Lerp(sheep.velocity, desired, clamp(dt * 3.6, 0, 1));
              sheep.velocity.y = 0;
              if (sheep.velocity.length() > SHEEP_MAX_SPEED) {
                sheep.velocity = sheep.velocity.normalize().scale(SHEEP_MAX_SPEED);
              }

              sheep.mesh.position.addInPlace(sheep.velocity.scale(dt));
              sheep.mesh.position.x = clamp(sheep.mesh.position.x, -FIELD_HALF + 1.2, FIELD_HALF - 1.2);
              sheep.mesh.position.z = clamp(sheep.mesh.position.z, -FIELD_HALF + 1.2, FIELD_HALF - 1.2);

              if (isInsidePen(sheep.mesh.position.x, sheep.mesh.position.z)) {
                sheep.captured = true;
                sheep.velocity.set(0, 0, 0);
                sheep.material.diffuseColor = new B.Color3(1, 0.9, 0.4);
                sheep.material.emissiveColor = new B.Color3(0.1, 0.08, 0.02);
              }
            }

            if (sheep.captured) {
              herdedCount += 1;
              sheep.mesh.position = B.Vector3.Lerp(sheep.mesh.position, sheep.penSlot, clamp(dt * 2.8, 0, 1));
            }
          }

          if (!disposed) {
            setHerded((prev) => (prev === herdedCount ? prev : herdedCount));
          }

          elapsed += dt;
          const remain = Math.max(0, ROUND_SECONDS - elapsed);
          const remainSec = Math.ceil(remain);
          if (remainSec !== lastSecond) {
            lastSecond = remainSec;
            if (!disposed) {
              setTimeLeft((prev) => (prev === remainSec ? prev : remainSec));
            }
          }

          if (herdedCount >= SHEEP_COUNT) {
            roundOver = true;
            const clearSeconds = Math.max(1, Math.ceil(elapsed));
            if (!disposed) {
              setStatus("Clear");
              setIsRoundOver(true);
              setBestHerded((prev) => Math.max(prev, herdedCount));
              setBestClearTime((prev) => (prev === null ? clearSeconds : Math.min(prev, clearSeconds)));
            }
          } else if (remain <= 0) {
            roundOver = true;
            if (!disposed) {
              setStatus("Time Up");
              setIsRoundOver(true);
              setBestHerded((prev) => Math.max(prev, herdedCount));
            }
          }
        }

        camera.target = B.Vector3.Lerp(camera.target, dogRoot.position.add(new B.Vector3(0, 0.5, 0)), clamp(dt * 4, 0, 1));
        scene.render();
      });

      cleanup = () => {
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("resize", onResize);
        engine.stopRenderLoop();
        scene.dispose();
        engine.dispose();
      };
    };

    void start();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [runId]);

  return (
    <div className={styles.panel}>
      <header className={styles.stats}>
        <span>Status: {status}</span>
        <span>Herded: {herded}/{SHEEP_COUNT}</span>
        <span>Time Left: {timeLeft}s</span>
        <span>
          Best Clear: {bestClearTime === null ? "-" : `${bestClearTime}s`} / Best Herded: {bestHerded}
        </span>
      </header>

      <div className={styles.canvasShell}>
        <div ref={mountRef} className={styles.canvasMount} />
      </div>

      <footer className={styles.footer}>
        <button
          type="button"
          className={styles.control}
          onClick={() => {
            setRunId((prev) => prev + 1);
          }}
        >
          {isRoundOver ? "Restart Round" : "Reset Round"}
        </button>
        <p className={styles.help}>
          Move with Arrow keys or WASD, then drive every sheep into the yellow pen before time runs out.
        </p>
      </footer>
    </div>
  );
}
