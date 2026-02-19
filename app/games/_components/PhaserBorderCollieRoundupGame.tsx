"use client";

import { useEffect, useRef, useState } from "react";
import type Phaser from "phaser";
import { loadGameSave, saveGameSave } from "@/app/lib/save-protocol";
import styles from "./PhaserBorderCollieRoundupGame.module.css";

const GAME_SLUG = "phaser-border-collie-roundup";
const GAME_TITLE = "Border Collie Roundup";
const GAME_WIDTH = 640;
const GAME_HEIGHT = 480;
const SHEEP_COUNT = 9;
const ROUND_SECONDS = 75;

const FIELD_LEFT = 64;
const FIELD_RIGHT = 576;
const FIELD_TOP = 76;
const FIELD_BOTTOM = 438;

const PEN_WORLD = {
  x: 468,
  y: 96,
  width: 90,
  height: 72,
};

type PhaserRuntime = typeof Phaser;

type RoundResult = {
  herdedCount: number;
  cleared: boolean;
};

type CreateGameOptions = {
  PhaserRef: PhaserRuntime;
  parent: HTMLDivElement;
  onHerdedCount: (value: number) => void;
  onTimeLeft: (value: number) => void;
  onStatus: (value: string) => void;
  onRoundEnd: (result: RoundResult) => void;
};

type Projection = {
  x: number;
  y: number;
  scale: number;
  depth: number;
};

type DogAvatar = {
  root: Phaser.GameObjects.Container;
  tail: Phaser.GameObjects.Triangle;
  earL: Phaser.GameObjects.Triangle;
  earR: Phaser.GameObjects.Triangle;
  eye: Phaser.GameObjects.Ellipse;
};

type SheepAvatar = {
  root: Phaser.GameObjects.Container;
  wool: Phaser.GameObjects.Arc[];
  face: Phaser.GameObjects.Ellipse;
  eye: Phaser.GameObjects.Ellipse;
  earL: Phaser.GameObjects.Ellipse;
  earR: Phaser.GameObjects.Ellipse;
};

type SoundFx = {
  unlock: () => void;
  bark: () => void;
  bleat: () => void;
  chime: () => void;
  dispose: () => void;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function worldDepthRatio(worldY: number) {
  return clamp((worldY - FIELD_TOP) / (FIELD_BOTTOM - FIELD_TOP), 0, 1);
}

function projectWorldToScreen(worldX: number, worldY: number): Projection {
  const t = worldDepthRatio(worldY);
  const scale = 0.58 + t * 0.62;
  const screenX = GAME_WIDTH / 2 + (worldX - GAME_WIDTH / 2) * scale;
  const screenY = 54 + (worldY - FIELD_TOP) * 0.95;
  return {
    x: screenX,
    y: screenY,
    scale,
    depth: 2 + t * 10,
  };
}

function isInsidePen(worldX: number, worldY: number) {
  return (
    worldX >= PEN_WORLD.x &&
    worldX <= PEN_WORLD.x + PEN_WORLD.width &&
    worldY >= PEN_WORLD.y &&
    worldY <= PEN_WORLD.y + PEN_WORLD.height
  );
}

function createSoundFx(): SoundFx {
  if (typeof window === "undefined") {
    return {
      unlock: () => undefined,
      bark: () => undefined,
      bleat: () => undefined,
      chime: () => undefined,
      dispose: () => undefined,
    };
  }

  const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) {
    return {
      unlock: () => undefined,
      bark: () => undefined,
      bleat: () => undefined,
      chime: () => undefined,
      dispose: () => undefined,
    };
  }

  let ctx: AudioContext | null = null;
  let enabled = false;

  const ensureContext = () => {
    if (!ctx) {
      ctx = new AudioCtx();
    }
    return ctx;
  };

  const playTone = (
    frequency: number,
    durationMs: number,
    type: OscillatorType,
    volume: number,
    frequencyEnd?: number,
  ) => {
    if (!enabled) {
      return;
    }

    const audio = ensureContext();
    const start = audio.currentTime;
    const end = start + durationMs / 1000;
    const osc = audio.createOscillator();
    const gain = audio.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(frequency, start);
    if (typeof frequencyEnd === "number") {
      osc.frequency.exponentialRampToValueAtTime(Math.max(40, frequencyEnd), end);
    }

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start(start);
    osc.stop(end);
  };

  return {
    unlock() {
      const audio = ensureContext();
      void audio.resume();
      enabled = true;
    },
    bark() {
      playTone(320, 70, "square", 0.03, 250);
      window.setTimeout(() => {
        playTone(280, 65, "square", 0.025, 230);
      }, 52);
    },
    bleat() {
      playTone(520, 140, "triangle", 0.03, 430);
    },
    chime() {
      playTone(780, 170, "sine", 0.03, 930);
      window.setTimeout(() => {
        playTone(980, 170, "sine", 0.023, 1180);
      }, 70);
    },
    dispose() {
      if (ctx) {
        void ctx.close();
        ctx = null;
      }
    },
  };
}

function createDogAvatar(scene: Phaser.Scene, x: number, y: number): DogAvatar {
  const body = scene.add.ellipse(0, 0, 26, 16, 0x111827, 1).setStrokeStyle(2, 0xf8fafc, 0.95);
  const chest = scene.add.ellipse(2, 2, 12, 8, 0xf8fafc, 0.95);
  const head = scene.add.ellipse(12, -8, 14, 12, 0x111827, 1).setStrokeStyle(1, 0xe5e7eb, 1);
  const muzzle = scene.add.ellipse(16, -6, 8, 6, 0xf8fafc, 1);
  const earL = scene.add.triangle(7, -14, 0, 0, 5, -9, 9, 1, 0x111827, 1).setOrigin(0.2, 0.85);
  const earR = scene.add.triangle(15, -15, 0, 0, 6, -8, 10, 1, 0x111827, 1).setOrigin(0.2, 0.85);
  const eye = scene.add.ellipse(14, -9, 3.2, 2.3, 0xffffff, 1);
  const nose = scene.add.circle(19, -6, 1.4, 0x020617, 1);
  const tail = scene.add.triangle(-14, -3, 0, 0, -9, -4, -9, 4, 0x111827, 1);
  const pawBack = scene.add.ellipse(-6, 7, 6, 4, 0x0f172a, 1);
  const pawFront = scene.add.ellipse(6, 7, 6, 4, 0x0f172a, 1);

  const root = scene.add.container(x, y, [
    pawBack,
    pawFront,
    body,
    chest,
    tail,
    head,
    muzzle,
    earL,
    earR,
    eye,
    nose,
  ]);

  return { root, tail, earL, earR, eye };
}

function createSheepAvatar(scene: Phaser.Scene, x: number, y: number): SheepAvatar {
  const wool: Phaser.GameObjects.Arc[] = [];
  const woolOffsets: Array<[number, number, number]> = [
    [0, -2, 10],
    [-9, -1, 7],
    [9, -1, 7],
    [-4, -8, 6],
    [4, -8, 6],
    [-4, 6, 6],
    [4, 6, 6],
  ];

  for (const [ox, oy, radius] of woolOffsets) {
    wool.push(scene.add.circle(ox, oy, radius, 0xffffff, 1).setStrokeStyle(1, 0xd1d5db, 1));
  }

  const face = scene.add.ellipse(11, 1, 11, 10, 0x1f2937, 1).setStrokeStyle(1, 0x111827, 1);
  const earL = scene.add.ellipse(14, -4, 3, 5, 0x374151, 1);
  const earR = scene.add.ellipse(14, 5, 3, 5, 0x374151, 1);
  const eye = scene.add.ellipse(13, 0, 2.4, 2, 0xffffff, 1);
  const hoofL = scene.add.ellipse(-4, 10, 4, 3, 0x374151, 1);
  const hoofR = scene.add.ellipse(4, 10, 4, 3, 0x374151, 1);

  const root = scene.add.container(x, y, [...wool, earL, earR, hoofL, hoofR, face, eye]);

  return { root, wool, face, eye, earL, earR };
}

function setSheepCapturedVisual(avatar: SheepAvatar) {
  for (const puff of avatar.wool) {
    puff.setFillStyle(0xfef3c7, 1);
    puff.setStrokeStyle(1, 0xf59e0b, 1);
  }
  avatar.face.setFillStyle(0x92400e, 1);
}

function createBorderCollieRoundupGame({
  PhaserRef,
  parent,
  onHerdedCount,
  onTimeLeft,
  onStatus,
  onRoundEnd,
}: CreateGameOptions): Phaser.Game {
  const sfx = createSoundFx();
  let dog: DogAvatar | null = null;
  let dogWorldX = FIELD_LEFT + 68;
  let dogWorldY = FIELD_BOTTOM - 52;
  let dogFacing = 1;

  let cursors: Phaser.Types.Input.Keyboard.CursorKeys | null = null;
  let keyW: Phaser.Input.Keyboard.Key | null = null;
  let keyA: Phaser.Input.Keyboard.Key | null = null;
  let keyS: Phaser.Input.Keyboard.Key | null = null;
  let keyD: Phaser.Input.Keyboard.Key | null = null;
  let guideText: Phaser.GameObjects.Text | null = null;
  let isRoundOver = false;
  let timeLeftMs = ROUND_SECONDS * 1000;
  let lastSecond = ROUND_SECONDS;
  let lastHerded = 0;
  let lastBarkAt = -9999;

  const sheepList: Array<{
    avatar: SheepAvatar;
    captured: boolean;
    worldX: number;
    worldY: number;
    vx: number;
    vy: number;
    wanderMs: number;
    bobPhase: number;
    blinkNextMs: number;
    blinkHoldMs: number;
  }> = [];

  const emitCaptureBurst = (scene: Phaser.Scene, worldX: number, worldY: number) => {
    const base = projectWorldToScreen(worldX, worldY);
    for (let i = 0; i < 8; i += 1) {
      const spark = scene.add.circle(base.x, base.y, PhaserRef.Math.Between(2, 4), 0xfef08a, 0.95).setDepth(base.depth + 2);
      const angle = PhaserRef.Math.FloatBetween(0, Math.PI * 2);
      const travel = PhaserRef.Math.Between(10, 28);
      scene.tweens.add({
        targets: spark,
        x: base.x + Math.cos(angle) * travel,
        y: base.y + Math.sin(angle) * travel,
        alpha: 0,
        duration: PhaserRef.Math.Between(190, 320),
        ease: "Quad.Out",
        onComplete: () => {
          spark.destroy();
        },
      });
    }
  };

  const finishRound = (result: RoundResult) => {
    if (isRoundOver) {
      return;
    }
    isRoundOver = true;
    onRoundEnd(result);
    onStatus(result.cleared ? "Clear" : "Time Up");
    if (guideText) {
      guideText.setText(result.cleared ? "All sheep secured. Restart for a new run." : "Time up. Restart to try again.");
    }
  };

  const scene: Phaser.Types.Scenes.SceneType = {
    key: "BorderCollieRoundupScene",
    create(this: Phaser.Scene) {
      this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x052e16, 1).setDepth(-8);
      this.add.rectangle(GAME_WIDTH / 2, 38, GAME_WIDTH, 90, 0x14532d, 0.46).setDepth(-7);

      const fieldGraphics = this.add.graphics().setDepth(-4);
      const fenceGraphics = this.add.graphics().setDepth(-3);

      const topLeft = projectWorldToScreen(FIELD_LEFT, FIELD_TOP);
      const topRight = projectWorldToScreen(FIELD_RIGHT, FIELD_TOP);
      const bottomRight = projectWorldToScreen(FIELD_RIGHT, FIELD_BOTTOM);
      const bottomLeft = projectWorldToScreen(FIELD_LEFT, FIELD_BOTTOM);

      fieldGraphics.fillStyle(0x166534, 1);
      fieldGraphics.beginPath();
      fieldGraphics.moveTo(topLeft.x, topLeft.y);
      fieldGraphics.lineTo(topRight.x, topRight.y);
      fieldGraphics.lineTo(bottomRight.x, bottomRight.y);
      fieldGraphics.lineTo(bottomLeft.x, bottomLeft.y);
      fieldGraphics.closePath();
      fieldGraphics.fillPath();

      for (let i = 0; i <= 5; i += 1) {
        const t = i / 5;
        const yLine = FIELD_TOP + (FIELD_BOTTOM - FIELD_TOP) * t;
        const l = projectWorldToScreen(FIELD_LEFT + 2, yLine);
        const r = projectWorldToScreen(FIELD_RIGHT - 2, yLine);
        fieldGraphics.lineStyle(2, 0x15803d, 0.2 + t * 0.2);
        fieldGraphics.beginPath();
        fieldGraphics.moveTo(l.x, l.y);
        fieldGraphics.lineTo(r.x, r.y);
        fieldGraphics.strokePath();
      }

      fenceGraphics.lineStyle(8, 0x78350f, 1);
      fenceGraphics.beginPath();
      fenceGraphics.moveTo(topLeft.x, topLeft.y);
      fenceGraphics.lineTo(topRight.x, topRight.y);
      fenceGraphics.lineTo(bottomRight.x, bottomRight.y);
      fenceGraphics.lineTo(bottomLeft.x, bottomLeft.y);
      fenceGraphics.closePath();
      fenceGraphics.strokePath();

      const innerTopLeft = projectWorldToScreen(FIELD_LEFT + 10, FIELD_TOP + 8);
      const innerTopRight = projectWorldToScreen(FIELD_RIGHT - 10, FIELD_TOP + 8);
      const innerBottomRight = projectWorldToScreen(FIELD_RIGHT - 10, FIELD_BOTTOM - 8);
      const innerBottomLeft = projectWorldToScreen(FIELD_LEFT + 10, FIELD_BOTTOM - 8);
      fenceGraphics.lineStyle(3, 0xd97706, 0.95);
      fenceGraphics.beginPath();
      fenceGraphics.moveTo(innerTopLeft.x, innerTopLeft.y);
      fenceGraphics.lineTo(innerTopRight.x, innerTopRight.y);
      fenceGraphics.lineTo(innerBottomRight.x, innerBottomRight.y);
      fenceGraphics.lineTo(innerBottomLeft.x, innerBottomLeft.y);
      fenceGraphics.closePath();
      fenceGraphics.strokePath();

      const penGraphics = this.add.graphics().setDepth(1.5);
      const penTL = projectWorldToScreen(PEN_WORLD.x, PEN_WORLD.y);
      const penTR = projectWorldToScreen(PEN_WORLD.x + PEN_WORLD.width, PEN_WORLD.y);
      const penBR = projectWorldToScreen(PEN_WORLD.x + PEN_WORLD.width, PEN_WORLD.y + PEN_WORLD.height);
      const penBL = projectWorldToScreen(PEN_WORLD.x, PEN_WORLD.y + PEN_WORLD.height);

      penGraphics.fillStyle(0x14532d, 0.96);
      penGraphics.beginPath();
      penGraphics.moveTo(penTL.x, penTL.y);
      penGraphics.lineTo(penTR.x, penTR.y);
      penGraphics.lineTo(penBR.x, penBR.y);
      penGraphics.lineTo(penBL.x, penBL.y);
      penGraphics.closePath();
      penGraphics.fillPath();

      penGraphics.lineStyle(3, 0xfde047, 1);
      penGraphics.beginPath();
      penGraphics.moveTo(penTL.x, penTL.y);
      penGraphics.lineTo(penTR.x, penTR.y);
      penGraphics.lineTo(penBR.x, penBR.y);
      penGraphics.lineTo(penBL.x, penBL.y);
      penGraphics.closePath();
      penGraphics.strokePath();

      const penLabelPoint = projectWorldToScreen(PEN_WORLD.x + PEN_WORLD.width / 2, PEN_WORLD.y + 4);
      this.add
        .text(penLabelPoint.x, penLabelPoint.y, "PEN", {
          color: "#fef08a",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "13px",
        })
        .setOrigin(0.5, 0)
        .setDepth(4);

      dog = createDogAvatar(this, 0, 0);
      this.time.addEvent({
        delay: 2200,
        loop: true,
        callback: () => {
          if (!dog) {
            return;
          }
          dog.eye.scaleY = 0.18;
          this.time.delayedCall(95, () => {
            if (dog) {
              dog.eye.scaleY = 1;
            }
          });
        },
      });

      for (let i = 0; i < SHEEP_COUNT; i += 1) {
        sheepList.push({
          avatar: createSheepAvatar(this, 0, 0),
          captured: false,
          worldX: PhaserRef.Math.Between(FIELD_LEFT + 34, FIELD_RIGHT - 136),
          worldY: PhaserRef.Math.Between(FIELD_TOP + 62, FIELD_BOTTOM - 30),
          vx: PhaserRef.Math.FloatBetween(-18, 18),
          vy: PhaserRef.Math.FloatBetween(-18, 18),
          wanderMs: PhaserRef.Math.Between(350, 950),
          bobPhase: PhaserRef.Math.FloatBetween(0, Math.PI * 2),
          blinkNextMs: PhaserRef.Math.Between(900, 2200),
          blinkHoldMs: 0,
        });
      }

      guideText = this.add
        .text(16, 14, "Move: Arrow Keys / WASD  |  Herd sheep into the pen", {
          color: "#ecfccb",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "13px",
        })
        .setDepth(20);

      if (!this.input.keyboard) {
        onStatus("Input Error");
        finishRound({ herdedCount: 0, cleared: false });
        return;
      }

      cursors = this.input.keyboard.createCursorKeys();
      keyW = this.input.keyboard.addKey(PhaserRef.Input.Keyboard.KeyCodes.W);
      keyA = this.input.keyboard.addKey(PhaserRef.Input.Keyboard.KeyCodes.A);
      keyS = this.input.keyboard.addKey(PhaserRef.Input.Keyboard.KeyCodes.S);
      keyD = this.input.keyboard.addKey(PhaserRef.Input.Keyboard.KeyCodes.D);

      this.input.keyboard.once("keydown", () => {
        sfx.unlock();
      });
      this.input.once("pointerdown", () => {
        sfx.unlock();
      });
      this.events.once("shutdown", () => {
        sfx.dispose();
      });
      this.events.once("destroy", () => {
        sfx.dispose();
      });
    },
    update(this: Phaser.Scene, time: number, delta: number) {
      if (isRoundOver || !dog || !cursors || !keyW || !keyA || !keyS || !keyD) {
        return;
      }

      const dt = delta / 1000;
      const moveSpeed = 220;
      const left = Boolean(cursors.left?.isDown || keyA.isDown);
      const right = Boolean(cursors.right?.isDown || keyD.isDown);
      const up = Boolean(cursors.up?.isDown || keyW.isDown);
      const down = Boolean(cursors.down?.isDown || keyS.isDown);
      const vx = (right ? 1 : 0) - (left ? 1 : 0);
      const vy = (down ? 1 : 0) - (up ? 1 : 0);

      if (vx !== 0 || vy !== 0) {
        const length = Math.hypot(vx, vy);
        dogWorldX += ((vx / length) * moveSpeed * delta) / 1000;
        dogWorldY += ((vy / length) * moveSpeed * delta) / 1000;

        if (time - lastBarkAt > 460 && Math.sin(time / 85) > 0.92) {
          sfx.bark();
          lastBarkAt = time;
        }
      }

      if (vx !== 0) {
        dogFacing = vx < 0 ? -1 : 1;
      }

      dogWorldX = clamp(dogWorldX, FIELD_LEFT + 14, FIELD_RIGHT - 14);
      dogWorldY = clamp(dogWorldY, FIELD_TOP + 16, FIELD_BOTTOM - 12);

      dog.tail.rotation = (vx !== 0 || vy !== 0 ? 0.95 : 0.45) * Math.sin(time / 95);
      dog.earL.rotation = Math.sin(time / 300) * 0.26;
      dog.earR.rotation = Math.sin(time / 300 + 0.7) * 0.26;

      let herdCount = 0;

      for (const sheep of sheepList) {
        sheep.avatar.earL.rotation = Math.sin(time / 420 + sheep.bobPhase) * 0.22;
        sheep.avatar.earR.rotation = Math.sin(time / 420 + sheep.bobPhase + 0.6) * 0.22;

        if (sheep.blinkHoldMs > 0) {
          sheep.blinkHoldMs -= delta;
          sheep.avatar.eye.scaleY = 0.2;
        } else {
          sheep.avatar.eye.scaleY = 1;
          sheep.blinkNextMs -= delta;
          if (sheep.blinkNextMs <= 0) {
            sheep.blinkHoldMs = PhaserRef.Math.Between(70, 120);
            sheep.blinkNextMs = PhaserRef.Math.Between(1200, 2600);
          }
        }

        if (!sheep.captured) {
          const dx = sheep.worldX - dogWorldX;
          const dy = sheep.worldY - dogWorldY;
          const dist = Math.max(0.001, Math.hypot(dx, dy));

          if (dist < 130) {
            const fear = PhaserRef.Math.Linear(80, 230, 1 - dist / 130);
            sheep.vx += (dx / dist) * fear * dt;
            sheep.vy += (dy / dist) * fear * dt;
          } else {
            sheep.wanderMs -= delta;
            if (sheep.wanderMs <= 0) {
              sheep.wanderMs = PhaserRef.Math.Between(280, 900);
              sheep.vx += PhaserRef.Math.FloatBetween(-55, 55);
              sheep.vy += PhaserRef.Math.FloatBetween(-55, 55);
            }
          }

          sheep.vx *= 0.94;
          sheep.vy *= 0.94;
          sheep.vx = clamp(sheep.vx, -150, 150);
          sheep.vy = clamp(sheep.vy, -150, 150);
          sheep.worldX += sheep.vx * dt;
          sheep.worldY += sheep.vy * dt;

          if (sheep.worldX < FIELD_LEFT + 12 || sheep.worldX > FIELD_RIGHT - 12) {
            sheep.vx *= -0.86;
            sheep.worldX = clamp(sheep.worldX, FIELD_LEFT + 12, FIELD_RIGHT - 12);
          }
          if (sheep.worldY < FIELD_TOP + 12 || sheep.worldY > FIELD_BOTTOM - 12) {
            sheep.vy *= -0.86;
            sheep.worldY = clamp(sheep.worldY, FIELD_TOP + 12, FIELD_BOTTOM - 12);
          }

          if (isInsidePen(sheep.worldX, sheep.worldY)) {
            sheep.captured = true;
            sheep.vx = 0;
            sheep.vy = 0;
            setSheepCapturedVisual(sheep.avatar);
            emitCaptureBurst(this, sheep.worldX, sheep.worldY);
            sfx.bleat();
            if (herdCount + 1 >= SHEEP_COUNT) {
              sfx.chime();
            }
          }
        }

        if (sheep.captured) {
          herdCount += 1;
        }

        const bobAmount = sheep.captured ? Math.sin(time / 380 + sheep.bobPhase) * 1.1 : Math.sin(time / 190 + sheep.bobPhase) * 0.7;
        const projected = projectWorldToScreen(sheep.worldX, sheep.worldY + bobAmount);
        sheep.avatar.root.setPosition(projected.x, projected.y);
        sheep.avatar.root.setScale(projected.scale);
        sheep.avatar.root.setDepth(projected.depth);
      }

      const dogProjected = projectWorldToScreen(dogWorldX, dogWorldY);
      dog.root.setPosition(dogProjected.x, dogProjected.y);
      dog.root.setScale(dogProjected.scale * dogFacing, dogProjected.scale);
      dog.root.setDepth(dogProjected.depth + 0.25);

      if (herdCount !== lastHerded) {
        lastHerded = herdCount;
        onHerdedCount(herdCount);
      }

      timeLeftMs = Math.max(0, timeLeftMs - delta);
      const secondsLeft = Math.ceil(timeLeftMs / 1000);
      if (secondsLeft !== lastSecond) {
        lastSecond = secondsLeft;
        onTimeLeft(secondsLeft);
      }

      if (herdCount >= SHEEP_COUNT) {
        finishRound({ herdedCount: herdCount, cleared: true });
        return;
      }

      if (timeLeftMs <= 0) {
        finishRound({ herdedCount: herdCount, cleared: false });
      }
    },
  };

  return new PhaserRef.Game({
    type: PhaserRef.AUTO,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    parent,
    backgroundColor: "#052e16",
    scene,
    scale: {
      mode: PhaserRef.Scale.FIT,
      autoCenter: PhaserRef.Scale.CENTER_BOTH,
    },
  });
}

export function PhaserBorderCollieRoundupGame() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [runId, setRunId] = useState(0);
  const [herdedCount, setHerdedCount] = useState(0);
  const [timeLeft, setTimeLeft] = useState(ROUND_SECONDS);
  const [status, setStatus] = useState("Running");
  const [isRoundOver, setIsRoundOver] = useState(false);
  const [bestHerded, setBestHerded] = useState(() => {
    if (typeof window === "undefined") {
      return 0;
    }
    const saved = loadGameSave<{ bestHerded?: number }>(GAME_SLUG);
    if (saved?.data && typeof saved.data.bestHerded === "number") {
      return saved.data.bestHerded;
    }
    return 0;
  });

  useEffect(() => {
    saveGameSave(GAME_SLUG, GAME_TITLE, { bestHerded });
  }, [bestHerded]);

  useEffect(() => {
    if (!mountRef.current) {
      return;
    }

    let cancelled = false;
    let phaserGame: Phaser.Game | null = null;

    const startGame = async () => {
      const phaserModule = await import("phaser");
      const PhaserRef = ("default" in phaserModule ? phaserModule.default : phaserModule) as PhaserRuntime;

      if (cancelled || !mountRef.current) {
        return;
      }

      setHerdedCount(0);
      setTimeLeft(ROUND_SECONDS);
      setStatus("Running");
      setIsRoundOver(false);

      phaserGame = createBorderCollieRoundupGame({
        PhaserRef,
        parent: mountRef.current,
        onHerdedCount: (next) => {
          setHerdedCount((prev) => (prev === next ? prev : next));
        },
        onTimeLeft: (next) => {
          setTimeLeft((prev) => (prev === next ? prev : next));
        },
        onStatus: (next) => {
          setStatus((prev) => (prev === next ? prev : next));
        },
        onRoundEnd: ({ herdedCount: roundHerded }) => {
          setIsRoundOver(true);
          setBestHerded((prev) => Math.max(prev, roundHerded));
        },
      });
    };

    void startGame();

    return () => {
      cancelled = true;
      if (phaserGame) {
        phaserGame.destroy(true);
      }
    };
  }, [runId]);

  return (
    <div className={styles.panel}>
      <header className={styles.stats}>
        <span>Status: {status}</span>
        <span>Herded: {herdedCount} / {SHEEP_COUNT}</span>
        <span>Time Left: {timeLeft}s</span>
        <span>Best Herded: {bestHerded}</span>
      </header>

      <div className={styles.canvasShell}>
        <div ref={mountRef} className={styles.canvasMount} />
      </div>

      <div className={styles.footer}>
        <button
          type="button"
          className={styles.control}
          onClick={() => {
            setRunId((prev) => prev + 1);
          }}
        >
          {isRoundOver ? "Restart Round" : "Reset Round"}
        </button>
        <p className={styles.help}>보더콜리를 움직여 양을 우리(PEN)로 몰아넣으세요. 제한 시간 안에 전부 모으면 클리어입니다.</p>
      </div>
    </div>
  );
}
