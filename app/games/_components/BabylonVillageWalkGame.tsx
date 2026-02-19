"use client";

import { useEffect, useRef, useState } from "react";
import { loadGameSave, saveGameSave } from "@/app/lib/save-protocol";
import styles from "./BabylonVillageWalkGame.module.css";

const GAME_SLUG = "babylon-village-walk";
const GAME_TITLE = "Babylon Village Walk";
const MOVE_SPEED = 10;
const WORLD_LIMIT = 52;
const CLEAR_RADIUS = 4.2;

const LANDMARKS = [
  { id: "plaza", label: "광장 분수", position: { x: -24, z: -12 }, color: [0.95, 0.76, 0.25] as const },
  { id: "market", label: "시장", position: { x: 18, z: -18 }, color: [0.98, 0.51, 0.3] as const },
  { id: "tower", label: "시계탑", position: { x: 30, z: 14 }, color: [0.5, 0.76, 0.98] as const },
  { id: "lake", label: "호수", position: { x: -22, z: 22 }, color: [0.31, 0.85, 0.64] as const },
  { id: "gate", label: "마을 입구", position: { x: 0, z: 34 }, color: [0.75, 0.65, 0.99] as const },
];

const formatTime = (seconds: number) => {
  const m = String(Math.floor(seconds / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
};

export function BabylonVillageWalkGame() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const bestTimeRef = useRef<number | null>(null);

  const [runId, setRunId] = useState(0);
  const [visitedCount, setVisitedCount] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isCleared, setIsCleared] = useState(false);
  const [message, setMessage] = useState("WASD / 방향키로 이동해서 모든 명소를 방문하세요.");
  const [bestTime, setBestTime] = useState<number | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }
    const saved = loadGameSave<{ bestTime?: number }>(GAME_SLUG);
    if (saved?.data && typeof saved.data.bestTime === "number" && Number.isFinite(saved.data.bestTime)) {
      return Math.max(0, Math.floor(saved.data.bestTime));
    }
    return null;
  });

  useEffect(() => {
    bestTimeRef.current = bestTime;
  }, [bestTime]);

  useEffect(() => {
    if (bestTime === null) {
      return;
    }
    saveGameSave(GAME_SLUG, GAME_TITLE, { bestTime });
  }, [bestTime]);

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

      setVisitedCount(0);
      setElapsedSeconds(0);
      setIsCleared(false);
      setMessage("WASD / 방향키로 이동해서 모든 명소를 방문하세요.");

      const visitedMap = new Set<string>();
      let lastSecond = 0;
      let elapsed = 0;
      let cleared = false;

      const canvas = document.createElement("canvas");
      canvas.className = styles.canvas;
      mountRef.current.innerHTML = "";
      mountRef.current.appendChild(canvas);

      const engine = new B.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
      const scene = new B.Scene(engine);
      scene.clearColor = new B.Color4(0.8, 0.95, 1, 1);

      const camera = new B.ArcRotateCamera("camera", -Math.PI / 2, 1.08, 38, new B.Vector3(0, 1.5, 0), scene);
      camera.attachControl(canvas, true);
      camera.lowerRadiusLimit = 20;
      camera.upperRadiusLimit = 42;
      camera.wheelDeltaPercentage = 0.02;

      const sun = new B.DirectionalLight("sun", new B.Vector3(-0.35, -1, -0.25), scene);
      sun.intensity = 1.2;
      const skyLight = new B.HemisphericLight("sky", new B.Vector3(0, 1, 0), scene);
      skyLight.intensity = 0.6;

      const ground = B.MeshBuilder.CreateGround("ground", { width: 130, height: 130 }, scene);
      const groundMat = new B.StandardMaterial("ground-mat", scene);
      groundMat.diffuseColor = new B.Color3(0.45, 0.74, 0.46);
      groundMat.specularColor = B.Color3.Black();
      ground.material = groundMat;

      const roadMat = new B.StandardMaterial("road-mat", scene);
      roadMat.diffuseColor = new B.Color3(0.35, 0.35, 0.38);
      roadMat.specularColor = B.Color3.Black();

      const roadX = B.MeshBuilder.CreateBox("road-x", { width: 104, height: 0.05, depth: 12 }, scene);
      roadX.position.y = 0.03;
      roadX.material = roadMat;
      const roadZ = B.MeshBuilder.CreateBox("road-z", { width: 12, height: 0.05, depth: 104 }, scene);
      roadZ.position.y = 0.03;
      roadZ.material = roadMat;

      const createHouse = (name: string, x: number, z: number) => {
        const body = B.MeshBuilder.CreateBox(`${name}-body`, { width: 8, depth: 8, height: 5.2 }, scene);
        body.position.set(x, 2.6, z);
        const bodyMat = new B.StandardMaterial(`${name}-body-mat`, scene);
        bodyMat.diffuseColor = new B.Color3(0.96, 0.9, 0.78);
        body.material = bodyMat;

        const roof = B.MeshBuilder.CreateCylinder(
          `${name}-roof`,
          { diameterTop: 0.2, diameterBottom: 8.8, height: 3.2, tessellation: 4 },
          scene,
        );
        roof.position.set(x, 6.7, z);
        roof.rotation.y = Math.PI / 4;
        const roofMat = new B.StandardMaterial(`${name}-roof-mat`, scene);
        roofMat.diffuseColor = new B.Color3(0.7, 0.2, 0.17);
        roof.material = roofMat;
      };

      const createTree = (name: string, x: number, z: number) => {
        const trunk = B.MeshBuilder.CreateCylinder(`${name}-trunk`, { diameter: 1.2, height: 3.5 }, scene);
        trunk.position.set(x, 1.75, z);
        const trunkMat = new B.StandardMaterial(`${name}-trunk-mat`, scene);
        trunkMat.diffuseColor = new B.Color3(0.45, 0.26, 0.12);
        trunk.material = trunkMat;

        const crown = B.MeshBuilder.CreateSphere(`${name}-crown`, { diameter: 4.4 }, scene);
        crown.position.set(x, 4.8, z);
        const crownMat = new B.StandardMaterial(`${name}-crown-mat`, scene);
        crownMat.diffuseColor = new B.Color3(0.18, 0.58, 0.24);
        crown.material = crownMat;
      };

      createHouse("house-a", -34, -26);
      createHouse("house-b", 34, -26);
      createHouse("house-c", -34, 24);
      createHouse("house-d", 34, 24);
      createHouse("house-e", 8, 2);

      for (let i = -2; i <= 2; i += 1) {
        createTree(`tree-n-${i}`, -50 + i * 10, -40);
        createTree(`tree-s-${i}`, 50 - i * 10, 40);
      }

      const player = B.MeshBuilder.CreateCapsule("player", { radius: 1.1, height: 3.4 }, scene);
      player.position.set(0, 1.7, 0);
      const playerMat = new B.StandardMaterial("player-mat", scene);
      playerMat.diffuseColor = new B.Color3(0.11, 0.24, 0.53);
      player.material = playerMat;

      const landmarkMeshes = LANDMARKS.map((landmark) => {
        const marker = B.MeshBuilder.CreateCylinder(`landmark-${landmark.id}`, { diameter: 3.8, height: 1.6 }, scene);
        marker.position.set(landmark.position.x, 0.8, landmark.position.z);
        const markerMat = new B.StandardMaterial(`landmark-mat-${landmark.id}`, scene);
        markerMat.diffuseColor = new B.Color3(landmark.color[0], landmark.color[1], landmark.color[2]);
        markerMat.emissiveColor = new B.Color3(landmark.color[0] * 0.3, landmark.color[1] * 0.3, landmark.color[2] * 0.3);
        marker.material = markerMat;
        return { ...landmark, mesh: marker, mat: markerMat };
      });

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

      engine.runRenderLoop(() => {
        const dt = engine.getDeltaTime() / 1000;
        if (!cleared) {
          const moveX = (keys.d || keys.ArrowRight ? 1 : 0) - (keys.a || keys.ArrowLeft ? 1 : 0);
          const moveZ = (keys.w || keys.ArrowUp ? 1 : 0) - (keys.s || keys.ArrowDown ? 1 : 0);

          if (moveX !== 0 || moveZ !== 0) {
            const dir = new B.Vector3(moveX, 0, moveZ).normalize();
            player.position.x += dir.x * MOVE_SPEED * dt;
            player.position.z += dir.z * MOVE_SPEED * dt;
            player.rotation.y = Math.atan2(dir.x, dir.z);
          }

          player.position.x = B.Scalar.Clamp(player.position.x, -WORLD_LIMIT, WORLD_LIMIT);
          player.position.z = B.Scalar.Clamp(player.position.z, -WORLD_LIMIT, WORLD_LIMIT);
          camera.target.copyFrom(player.position);

          elapsed += dt;
          const whole = Math.floor(elapsed);
          if (whole !== lastSecond) {
            lastSecond = whole;
            setElapsedSeconds(whole);
          }

          for (const landmark of landmarkMeshes) {
            if (visitedMap.has(landmark.id)) {
              continue;
            }
            if (B.Vector3.Distance(player.position, landmark.mesh.position) <= CLEAR_RADIUS) {
              visitedMap.add(landmark.id);
              landmark.mat.diffuseColor = new B.Color3(0.24, 0.81, 0.52);
              landmark.mat.emissiveColor = new B.Color3(0.05, 0.2, 0.12);
              setVisitedCount(visitedMap.size);
              setMessage(`${landmark.label} 방문 완료 (${visitedMap.size}/${LANDMARKS.length})`);
            }
          }

          if (visitedMap.size === LANDMARKS.length) {
            cleared = true;
            const finalTime = Math.floor(elapsed);
            setIsCleared(true);
            setMessage(`탐험 완료! 기록 ${formatTime(finalTime)}`);
            const previous = bestTimeRef.current;
            if (previous === null || finalTime < previous) {
              setBestTime(finalTime);
            }
          }
        }

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
        <span>진행: {visitedCount}/{LANDMARKS.length}</span>
        <span>시간: {formatTime(elapsedSeconds)}</span>
        <span>상태: {isCleared ? "완료" : "탐험 중"}</span>
        <span>최고기록: {bestTime === null ? "-" : formatTime(bestTime)}</span>
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
          다시 시작
        </button>
        <p className={styles.help}>{message}</p>
      </footer>
    </div>
  );
}
