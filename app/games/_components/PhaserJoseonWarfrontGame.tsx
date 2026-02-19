"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type Phaser from "phaser";
import { loadGameSave, saveGameSave } from "@/app/lib/save-protocol";
import styles from "./PhaserJoseonWarfrontGame.module.css";

const GAME_SLUG = "phaser-joseon-warfront";
const GAME_TITLE = "Joseon Warfront";
const MAP_WIDTH = 760;
const MAP_HEIGHT = 520;
const PLAYER = 0;
const FACTION_COUNT = 7;

type PhaserRuntime = typeof Phaser;
type Terrain = "plain" | "forest" | "hill" | "mountain" | "wetland";
type Region = { id: number; x: number; y: number; row: number; col: number; neighbors: number[] };
type BattleConfig = { targetId: number; defenderFaction: number; attackerCount: number; defenderCount: number; terrain: Terrain };
type BattleResult = "victory" | "defeat";

type Faction = { id: number; name: string; color: number; text: string; emblem: string };
const FACTIONS: Faction[] = [
  { id: 0, name: "아군", color: 0x2563eb, text: "#bfdbfe", emblem: "A" },
  { id: 1, name: "북방", color: 0xbe123c, text: "#fecdd3", emblem: "B" },
  { id: 2, name: "관서", color: 0x7c3aed, text: "#ddd6fe", emblem: "C" },
  { id: 3, name: "중원", color: 0xea580c, text: "#fed7aa", emblem: "D" },
  { id: 4, name: "영남", color: 0x0891b2, text: "#bae6fd", emblem: "E" },
  { id: 5, name: "호남", color: 0x4d7c0f, text: "#d9f99d", emblem: "F" },
  { id: 6, name: "동북", color: 0xa16207, text: "#fde68a", emblem: "G" },
];

const TERRAIN_COLOR: Record<Terrain, { fill: number; stroke: number; battle: number }> = {
  plain: { fill: 0x65a30d, stroke: 0x3f6212, battle: 0x3f6212 },
  forest: { fill: 0x166534, stroke: 0x14532d, battle: 0x14532d },
  hill: { fill: 0x78716c, stroke: 0x57534e, battle: 0x57534e },
  mountain: { fill: 0x475569, stroke: 0x334155, battle: 0x334155 },
  wetland: { fill: 0x0f766e, stroke: 0x115e59, battle: 0x115e59 },
};

const TERRAIN_MOD: Record<
  Terrain,
  {
    heroSpeedMul: number;
    allySpeedMul: number;
    enemySpeedMul: number;
    detectRangeMul: number;
    swingRangeMul: number;
    unitCooldownAddMs: number;
  }
> = {
  plain: { heroSpeedMul: 1, allySpeedMul: 1, enemySpeedMul: 1, detectRangeMul: 1, swingRangeMul: 1, unitCooldownAddMs: 0 },
  forest: { heroSpeedMul: 0.92, allySpeedMul: 0.88, enemySpeedMul: 0.9, detectRangeMul: 0.84, swingRangeMul: 0.95, unitCooldownAddMs: 180 },
  hill: { heroSpeedMul: 0.9, allySpeedMul: 0.9, enemySpeedMul: 0.9, detectRangeMul: 0.92, swingRangeMul: 0.95, unitCooldownAddMs: 120 },
  mountain: { heroSpeedMul: 0.82, allySpeedMul: 0.8, enemySpeedMul: 0.82, detectRangeMul: 0.78, swingRangeMul: 0.9, unitCooldownAddMs: 260 },
  wetland: { heroSpeedMul: 0.78, allySpeedMul: 0.74, enemySpeedMul: 0.76, detectRangeMul: 0.82, swingRangeMul: 0.92, unitCooldownAddMs: 420 },
};

const LAYOUT: number[][] = [
  [7, 8, 9],
  [6, 7, 8, 9, 10],
  [5, 6, 7, 8, 9, 10],
  [5, 6, 7, 8, 9, 10, 11],
  [4, 5, 6, 7, 8, 9, 10],
  [4, 5, 6, 7, 8, 9, 10],
  [5, 6, 7, 8, 9, 10],
  [5, 6, 7, 8, 9, 10],
  [6, 7, 8, 9, 10],
  [6, 7, 8, 9, 10],
  [7, 8, 9],
];

const ORIGIN_X = 128;
const ORIGIN_Y = 72;
const COL_GAP = 34;
const ROW_GAP = 36;

const EVEN: Array<[number, number]> = [[-1, 0], [1, 0], [0, -1], [-1, -1], [0, 1], [-1, 1]];
const ODD: Array<[number, number]> = [[-1, 0], [1, 0], [0, -1], [1, -1], [0, 1], [1, 1]];

const rint = (n: number) => Math.floor(Math.random() * n);
const shuf = <T,>(arr: T[]) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = rint(i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
};

function cellToWorld(row: number, col: number) {
  return {
    x: ORIGIN_X + col * COL_GAP + (row % 2 === 0 ? 0 : 12) + Math.round((row - 5) * 1.4),
    y: ORIGIN_Y + row * ROW_GAP,
  };
}

function buildRegions() {
  const regions: Region[] = [];
  const byCell = new Map<string, number>();
  let id = 0;
  for (let row = 0; row < LAYOUT.length; row += 1) {
    for (const col of LAYOUT[row]) {
      const { x, y } = cellToWorld(row, col);
      regions.push({ id, x, y, row, col, neighbors: [] });
      byCell.set(`${row}:${col}`, id);
      id += 1;
    }
  }
  for (const rg of regions) {
    const dirs = rg.row % 2 === 0 ? EVEN : ODD;
    const list: number[] = [];
    for (const [dx, dy] of dirs) {
      const n = byCell.get(`${rg.row + dy}:${rg.col + dx}`);
      if (typeof n === "number") list.push(n);
    }
    rg.neighbors = Array.from(new Set(list));
  }
  return regions;
}

function peninsulaOutline() {
  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];
  for (let row = 0; row < LAYOUT.length; row += 1) {
    const cols = LAYOUT[row];
    const min = Math.min(...cols);
    const max = Math.max(...cols);
    const l = cellToWorld(row, min);
    const r = cellToWorld(row, max);
    left.push([l.x - 24, l.y - 18]);
    right.unshift([r.x + 24, r.y - 18]);
  }
  const head = cellToWorld(0, LAYOUT[0][1]);
  const tail = cellToWorld(LAYOUT.length - 1, LAYOUT[LAYOUT.length - 1][1]);
  return [[head.x - 6, head.y - 42], ...left, [tail.x - 10, tail.y + 30], [tail.x + 24, tail.y + 26], ...right, [head.x + 20, head.y - 34]];
}

const REGIONS = buildRegions();
const OUTLINE = peninsulaOutline();

function genTerrain(): Terrain[] {
  const pool: Terrain[] = ["plain", "plain", "forest", "hill", "wetland", "mountain"];
  const t = REGIONS.map((r) => {
    if (r.y < 150) return Math.random() < 0.4 ? "mountain" : "hill";
    if (r.y > 330) return Math.random() < 0.35 ? "plain" : "wetland";
    return pool[rint(pool.length)];
  });
  for (let k = 0; k < 2; k += 1) {
    for (const rg of shuf(REGIONS)) {
      if (Math.random() > 0.38) continue;
      const c = new Map<Terrain, number>();
      for (const n of rg.neighbors) c.set(t[n], (c.get(t[n]) ?? 0) + 1);
      const d = [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (d) t[rg.id] = d;
    }
  }
  return t;
}

function genOwners(): number[] {
  const owners = new Array<number>(REGIONS.length).fill(-1);
  const unassigned = new Set(REGIONS.map((r) => r.id));
  const seeds = shuf(REGIONS.map((r) => r.id)).slice(0, FACTION_COUNT);
  const front: number[][] = Array.from({ length: FACTION_COUNT }, () => []);

  for (let f = 0; f < FACTION_COUNT; f += 1) {
    owners[seeds[f]] = f;
    front[f].push(seeds[f]);
    unassigned.delete(seeds[f]);
  }

  while (unassigned.size > 0) {
    let progressed = false;
    for (const f of shuf(Array.from({ length: FACTION_COUNT }, (_, i) => i))) {
      if (front[f].length === 0) continue;
      const pivot = front[f][rint(front[f].length)];
      const options = shuf(REGIONS[pivot].neighbors).filter((n) => owners[n] < 0);
      if (options.length === 0) {
        front[f] = front[f].filter((x) => x !== pivot);
        continue;
      }
      const pick = options[0];
      owners[pick] = f;
      front[f].push(pick);
      unassigned.delete(pick);
      progressed = true;
    }
    if (!progressed) {
      const o = [...unassigned][0];
      const near = REGIONS[o].neighbors.find((n) => owners[n] >= 0);
      const f = typeof near === "number" ? owners[near] : PLAYER;
      owners[o] = f;
      front[f].push(o);
      unassigned.delete(o);
    }
  }
  return owners;
}

function buildWorld() {
  return { owners: genOwners(), terrain: genTerrain() };
}

const countOwned = (owners: number[], f: number) => owners.filter((x) => x === f).length;
const canAttackAny = (owners: number[]) =>
  REGIONS.some((r) => owners[r.id] !== PLAYER && r.neighbors.some((n) => owners[n] === PLAYER));

function createStrategyGame({
  PhaserRef,
  parent,
  owners,
  terrain,
  turn,
  allowAttack,
  onAttack,
}: {
  PhaserRef: PhaserRuntime;
  parent: HTMLDivElement;
  owners: number[];
  terrain: Terrain[];
  turn: number;
  allowAttack: boolean;
  onAttack: (targetId: number) => void;
}): Phaser.Game {
  const attackable = (id: number) => allowAttack && owners[id] !== PLAYER && REGIONS[id].neighbors.some((n) => owners[n] === PLAYER);

  const scene: Phaser.Types.Scenes.SceneType = {
    key: "JWStrategy",
    create(this: Phaser.Scene) {
      this.add.rectangle(MAP_WIDTH / 2, MAP_HEIGHT / 2, MAP_WIDTH, MAP_HEIGHT, 0x082f49, 1);
      const sea = this.add.graphics().setDepth(-2);
      sea.fillStyle(0x0c4a6e, 0.34);
      sea.fillCircle(110, 120, 78);
      sea.fillCircle(650, 360, 92);
      sea.fillCircle(610, 120, 60);

      const land = this.add.graphics().setDepth(0);
      land.fillStyle(0x365314, 1);
      land.lineStyle(5, 0x4d7c0f, 0.9);
      land.beginPath();
      land.moveTo(OUTLINE[0][0], OUTLINE[0][1]);
      for (let i = 1; i < OUTLINE.length; i += 1) land.lineTo(OUTLINE[i][0], OUTLINE[i][1]);
      land.closePath();
      land.fillPath();
      land.strokePath();

      const tg = this.add.graphics().setDepth(1);
      for (const rg of REGIONS) {
        const tc = TERRAIN_COLOR[terrain[rg.id]];
        tg.fillStyle(tc.fill, 0.9);
        tg.lineStyle(1, tc.stroke, 0.8);
        tg.fillCircle(rg.x, rg.y, 8);
        tg.strokeCircle(rg.x, rg.y, 8);
      }

      const links = new Set<string>();
      const bg = this.add.graphics().setDepth(2);
      bg.lineStyle(2, 0xe2e8f0, 0.22);
      for (const r of REGIONS) {
        for (const n of r.neighbors) {
          const k = [r.id, n].sort((a, b) => a - b).join("-");
          if (links.has(k)) continue;
          links.add(k);
          bg.beginPath();
          bg.moveTo(r.x, r.y);
          bg.lineTo(REGIONS[n].x, REGIONS[n].y);
          bg.strokePath();
        }
      }

      for (const rg of REGIONS) {
        const f = FACTIONS[owners[rg.id]];
        const node = this.add
          .circle(rg.x, rg.y, 11, f.color, 0.95)
          .setStrokeStyle(2, attackable(rg.id) ? 0xfacc15 : 0xe2e8f0, 0.95)
          .setDepth(4)
          .setInteractive({ cursor: attackable(rg.id) ? "pointer" : "default" });
        this.add
          .text(rg.x, rg.y + 15, `${rg.id + 1}`, {
            color: f.text,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: "10px",
          })
          .setOrigin(0.5)
          .setDepth(5);
        const banner = this.add.graphics().setDepth(5);
        banner.fillStyle(0xf8fafc, 0.92);
        banner.fillRect(rg.x - 1, rg.y - 17, 2, 8);
        banner.fillStyle(f.color, 0.98);
        banner.fillTriangle(rg.x + 1, rg.y - 17, rg.x + 9, rg.y - 14, rg.x + 1, rg.y - 11);
        this.add
          .text(rg.x + 6, rg.y - 14, f.emblem, {
            color: "#f8fafc",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: "8px",
          })
          .setOrigin(0.5)
          .setDepth(6);
        if (attackable(rg.id)) node.on("pointerdown", () => onAttack(rg.id));
      }

      this.add.text(14, 12, `전략 모드 (턴 ${turn})`, { color: "#fde68a", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "14px" }).setDepth(12);
      this.add
        .text(14, 32, allowAttack ? "인접한 타 세력 영토(노란 외곽선)를 클릭해 침공하세요." : "종료 상태: 지도만 확인 가능합니다.", {
          color: "#f8fafc",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "12px",
        })
        .setDepth(12);

      let y = 12;
      for (const f of FACTIONS) {
        this.add.rectangle(MAP_WIDTH - 126, y + 8, 10, 10, f.color, 1).setDepth(12);
        this.add.text(MAP_WIDTH - 116, y + 2, `[${f.emblem}] ${f.name} ${countOwned(owners, f.id)}`, {
          color: f.text,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "11px",
        }).setDepth(12);
        y += 18;
      }
    },
  };

  return new PhaserRef.Game({ type: PhaserRef.AUTO, width: MAP_WIDTH, height: MAP_HEIGHT, parent, scene, scale: { mode: PhaserRef.Scale.FIT, autoCenter: PhaserRef.Scale.CENTER_BOTH } });
}

function createBattleGame({
  PhaserRef,
  parent,
  config,
  onTick,
  onEnd,
}: {
  PhaserRef: PhaserRuntime;
  parent: HTMLDivElement;
  config: BattleConfig;
  onTick: (a: number, e: number) => void;
  onEnd: (r: BattleResult) => void;
}): Phaser.Game {
  const baseHeroSpeed = 148;
  const heroRange = 46;
  const heroArc = 0.72;
  const heroCd = 680;
  const heroDur = 120;

  const baseDetectRange = 44;
  const attackRange = 16;
  const baseSwingRange = 32;
  const baseUnitCd = 3000;
  const baseAllySpeed = 66;
  const baseEnemySpeed = 72;

  const mod = TERRAIN_MOD[config.terrain];
  const heroSpeed = baseHeroSpeed * mod.heroSpeedMul;
  const detectRange = Math.max(24, Math.round(baseDetectRange * mod.detectRangeMul));
  const swingRange = Math.max(20, Math.round(baseSwingRange * mod.swingRangeMul));
  const unitCd = Math.round(baseUnitCd + mod.unitCooldownAddMs);
  const allySpeed = baseAllySpeed * mod.allySpeedMul;
  const enemySpeed = baseEnemySpeed * mod.enemySpeedMul;

  const field = { left: 44, right: MAP_WIDTH - 44, top: 72, bottom: MAP_HEIGHT - 44 };
  type Unit = { sprite: Phaser.GameObjects.Arc; cooldown: number; alive: boolean };
  type BattlePatch = { terrain: Terrain; shape: "ellipse" | "rect"; x: number; y: number; w: number; h: number };
  type Obstacle =
    | { kind: "wall"; shape: "rect"; x: number; y: number; w: number; h: number }
    | { kind: "cliff"; shape: "circle"; x: number; y: number; r: number };

  let hero: Phaser.GameObjects.Rectangle | null = null;
  let shadow: Phaser.GameObjects.Ellipse | null = null;
  let facing = { x: 1, y: 0 };
  let heroCdLeft = 0;
  let heroDurLeft = 0;
  let heroAlive = true;
  let ended = false;
  let spacePrev = false;

  const allies: Unit[] = [];
  const enemies: Unit[] = [];
  const terrainPatches: BattlePatch[] = [];
  const obstacles: Obstacle[] = [];

  let cursors: Phaser.Types.Input.Keyboard.CursorKeys | null = null;
  let w: Phaser.Input.Keyboard.Key | null = null;
  let a: Phaser.Input.Keyboard.Key | null = null;
  let s: Phaser.Input.Keyboard.Key | null = null;
  let d: Phaser.Input.Keyboard.Key | null = null;
  let space: Phaser.Input.Keyboard.Key | null = null;
  let pointerMoveActive = false;
  let pointerTargetX = MAP_WIDTH / 2;
  let pointerTargetY = MAP_HEIGHT / 2;
  let attackButtonPressed = false;
  let attackButtonOuter: Phaser.GameObjects.Arc | null = null;
  let attackButtonInner: Phaser.GameObjects.Arc | null = null;

  const attackButtonPos = { x: MAP_WIDTH - 64, y: MAP_HEIGHT - 64, r: 32 };

  const clampObj = (o: Phaser.GameObjects.Components.Transform) => {
    o.x = PhaserRef.Math.Clamp(o.x, field.left, field.right);
    o.y = PhaserRef.Math.Clamp(o.y, field.top, field.bottom);
  };

  const resolveObstacleCollision = (o: Phaser.GameObjects.Components.Transform, radius: number) => {
    for (const obs of obstacles) {
      if (obs.shape === "rect") {
        const left = obs.x - obs.w / 2 - radius;
        const right = obs.x + obs.w / 2 + radius;
        const top = obs.y - obs.h / 2 - radius;
        const bottom = obs.y + obs.h / 2 + radius;

        if (o.x > left && o.x < right && o.y > top && o.y < bottom) {
          const dl = Math.abs(o.x - left);
          const dr = Math.abs(right - o.x);
          const dt = Math.abs(o.y - top);
          const db = Math.abs(bottom - o.y);
          const min = Math.min(dl, dr, dt, db);
          if (min === dl) o.x = left;
          else if (min === dr) o.x = right;
          else if (min === dt) o.y = top;
          else o.y = bottom;
        }
      } else {
        const dx = o.x - obs.x;
        const dy = o.y - obs.y;
        const dist = Math.max(0.0001, Math.hypot(dx, dy));
        const min = obs.r + radius;
        if (dist < min) {
          o.x = obs.x + (dx / dist) * min;
          o.y = obs.y + (dy / dist) * min;
        }
      }
    }
    clampObj(o);
  };

  const nearest = (x: number, y: number, pool: Unit[], range: number) => {
    let pick: Unit | null = null;
    let dist = range;
    for (const u of pool) {
      if (!u.alive) continue;
      const d0 = Math.hypot(u.sprite.x - x, u.sprite.y - y);
      if (d0 <= dist) {
        pick = u;
        dist = d0;
      }
    }
    return pick;
  };

  const followSlot = (idx: number, total: number, radius: number, phase: number) => {
    if (!hero) return { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 };
    const ang = phase + (idx / Math.max(1, total)) * Math.PI * 2;
    return { x: hero.x + Math.cos(ang) * radius, y: hero.y + Math.sin(ang) * radius };
  };

  const moveTo = (o: Phaser.GameObjects.Components.Transform, tx: number, ty: number, speed: number, dt: number, stop = 0) => {
    const dx = tx - o.x;
    const dy = ty - o.y;
    const dist = Math.max(0.0001, Math.hypot(dx, dy));
    if (dist <= stop) return;
    const step = Math.min(speed * dt, dist - stop);
    o.x += (dx / dist) * step;
    o.y += (dy / dist) * step;
  };

  const swingFx = (scene: Phaser.Scene, fx: number, fy: number, tx: number, ty: number, color: number) => {
    const ang = Math.atan2(ty - fy, tx - fx);
    const g = scene.add.graphics({ x: fx, y: fy }).setDepth(13);
    g.lineStyle(3, color, 0.96);
    g.beginPath();
    g.arc(0, 0, 16, ang - 0.7, ang + 0.15, false);
    g.strokePath();
    const blade = scene.add.rectangle(fx, fy, 20, 3, color, 0.94).setRotation(ang).setDepth(13);
    const p1 = scene.add.circle(fx, fy, 2.5, 0xfef3c7, 0.95).setDepth(13);
    const p2 = scene.add.circle(fx, fy, 1.8, color, 0.9).setDepth(13);
    scene.tweens.add({
      targets: [g, blade, p1, p2],
      x: fx + Math.cos(ang) * 12,
      y: fy + Math.sin(ang) * 12,
      alpha: 0,
      duration: 170,
      onComplete: () => {
        g.destroy();
        blade.destroy();
        p1.destroy();
        p2.destroy();
      },
    });
  };

  const separate = () => {
    if (!hero) return;
    const pts: Array<{ hero: boolean; x: number; y: number; r: number; set: (x: number, y: number) => void }> = [
      { hero: true, x: hero.x, y: hero.y, r: 12, set: (x, y) => { if (hero) { hero.x = x; hero.y = y; } } },
    ];
    for (const u of allies) pts.push({ hero: false, x: u.sprite.x, y: u.sprite.y, r: 8, set: (x, y) => { u.sprite.x = x; u.sprite.y = y; } });
    for (const u of enemies) pts.push({ hero: false, x: u.sprite.x, y: u.sprite.y, r: 8, set: (x, y) => { u.sprite.x = x; u.sprite.y = y; } });

    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        const a0 = pts[i];
        const b0 = pts[j];
        const dx = b0.x - a0.x;
        const dy = b0.y - a0.y;
        const dist = Math.max(0.0001, Math.hypot(dx, dy));
        const min = a0.r + b0.r + 3;
        if (dist >= min) continue;
        const push = (min - dist) / 2;
        const nx = dx / dist;
        const ny = dy / dist;
        const ar = a0.hero ? 0.35 : 1;
        const br = b0.hero ? 0.35 : 1;
        a0.x -= nx * push * ar;
        a0.y -= ny * push * ar;
        b0.x += nx * push * br;
        b0.y += ny * push * br;
      }
    }

    for (const p of pts) p.set(PhaserRef.Math.Clamp(p.x, field.left, field.right), PhaserRef.Math.Clamp(p.y, field.top, field.bottom));
  };

  const tryHeroAttack = () => {
    if (heroCdLeft > 0) return false;
    heroCdLeft = heroCd;
    heroDurLeft = heroDur;
    return true;
  };

  const scene: Phaser.Types.Scenes.SceneType = {
    key: "JWBattle",
    create(this: Phaser.Scene) {
      const tc = TERRAIN_COLOR[config.terrain];
      this.add.rectangle(MAP_WIDTH / 2, MAP_HEIGHT / 2, MAP_WIDTH, MAP_HEIGHT, tc.battle, 1).setDepth(-8);
      this.add.rectangle(MAP_WIDTH / 2, 58, MAP_WIDTH, 94, 0x0f172a, 0.4).setDepth(-7);
      const arena = this.add.graphics().setDepth(-3);
      arena.fillStyle(tc.fill, 0.84);
      arena.fillRoundedRect(field.left, field.top, field.right - field.left, field.bottom - field.top, 26);
      arena.lineStyle(4, 0x78350f, 1);
      arena.strokeRoundedRect(field.left, field.top, field.right - field.left, field.bottom - field.top, 26);

      const patchTerrains: Terrain[] = ["plain", "forest", "hill", "mountain", "wetland"];
      terrainPatches.length = 0;
      for (let i = 0; i < 18; i += 1) {
        const shape = Math.random() < 0.55 ? "ellipse" : "rect";
        const x = PhaserRef.Math.Between(field.left + 90, field.right - 90);
        const y = PhaserRef.Math.Between(field.top + 30, field.bottom - 30);
        terrainPatches.push({
          terrain: patchTerrains[PhaserRef.Math.Between(0, patchTerrains.length - 1)],
          shape,
          x,
          y,
          w: PhaserRef.Math.Between(36, 86),
          h: PhaserRef.Math.Between(22, 68),
        });
      }

      const patchG = this.add.graphics().setDepth(-2);
      for (const p of terrainPatches) {
        const c = TERRAIN_COLOR[p.terrain];
        patchG.fillStyle(c.fill, 0.5);
        patchG.lineStyle(1, c.stroke, 0.7);
        if (p.shape === "ellipse") {
          patchG.fillEllipse(p.x, p.y, p.w, p.h);
          patchG.strokeEllipse(p.x, p.y, p.w, p.h);
        } else {
          patchG.fillRoundedRect(p.x - p.w / 2, p.y - p.h / 2, p.w, p.h, 8);
          patchG.strokeRoundedRect(p.x - p.w / 2, p.y - p.h / 2, p.w, p.h, 8);
        }
      }

      obstacles.length = 0;
      const obstacleCount = PhaserRef.Math.Between(5, 8);
      for (let i = 0; i < obstacleCount; i += 1) {
        const asWall = Math.random() < 0.55;
        if (asWall) {
          const horizontal = Math.random() < 0.5;
          obstacles.push({
            kind: "wall",
            shape: "rect",
            x: PhaserRef.Math.Between(field.left + 170, field.right - 170),
            y: PhaserRef.Math.Between(field.top + 45, field.bottom - 45),
            w: horizontal ? PhaserRef.Math.Between(70, 130) : PhaserRef.Math.Between(20, 34),
            h: horizontal ? PhaserRef.Math.Between(20, 34) : PhaserRef.Math.Between(70, 130),
          });
        } else {
          obstacles.push({
            kind: "cliff",
            shape: "circle",
            x: PhaserRef.Math.Between(field.left + 170, field.right - 170),
            y: PhaserRef.Math.Between(field.top + 45, field.bottom - 45),
            r: PhaserRef.Math.Between(16, 28),
          });
        }
      }

      const obsG = this.add.graphics().setDepth(2);
      for (const o of obstacles) {
        if (o.shape === "rect") {
          obsG.fillStyle(0x9ca3af, 0.95);
          obsG.lineStyle(2, 0x334155, 1);
          obsG.fillRoundedRect(o.x - o.w / 2, o.y - o.h / 2, o.w, o.h, 4);
          obsG.strokeRoundedRect(o.x - o.w / 2, o.y - o.h / 2, o.w, o.h, 4);
        } else {
          obsG.fillStyle(0x475569, 0.96);
          obsG.lineStyle(2, 0x1e293b, 1);
          obsG.fillCircle(o.x, o.y, o.r);
          obsG.strokeCircle(o.x, o.y, o.r);
          obsG.fillStyle(0x94a3b8, 0.25);
          obsG.fillCircle(o.x - 4, o.y - 3, Math.max(3, o.r - 8));
        }
      }

      shadow = this.add.ellipse(108, MAP_HEIGHT / 2 + 10, 30, 12, 0x000000, 0.24);
      hero = this.add.rectangle(108, MAP_HEIGHT / 2, 18, 18, 0xf8fafc, 1).setStrokeStyle(2, 0x1e3a8a, 1);

      const ac = 8;
      for (let i = 0; i < config.attackerCount; i += 1) {
        const row = Math.floor(i / ac);
        const col = i % ac;
        allies.push({ sprite: this.add.circle(96 + col * 16, 138 + row * 16, 6, 0x60a5fa, 0.96).setStrokeStyle(2, 0x1d4ed8, 0.95), cooldown: PhaserRef.Math.Between(0, 900), alive: true });
      }

      const ec = 8;
      const defColor = FACTIONS[config.defenderFaction].color;
      for (let i = 0; i < config.defenderCount; i += 1) {
        const row = Math.floor(i / ec);
        const col = i % ec;
        enemies.push({ sprite: this.add.circle(MAP_WIDTH - 210 + col * 16, 138 + row * 16, 6, defColor, 0.96).setStrokeStyle(2, 0x1f2937, 0.95), cooldown: PhaserRef.Math.Between(0, 900), alive: true });
      }

      this.add.text(14, 12, "전투 모드", { color: "#fde68a", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "14px" }).setDepth(11);
      this.add.text(
        14,
        32,
        `지형: ${config.terrain} + 혼합지형 | 병사 공격 주기: ${(unitCd / 1000).toFixed(1)}초 | 감지 ${detectRange} | 휘두름 ${swingRange} | 장애물 ${obstacles.length}`,
        { color: "#f8fafc", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" },
      ).setDepth(11);
      this.add
        .text(14, 50, "모바일: 주변 길게 터치 이동 | 우하단 버튼으로 공격", {
          color: "#dbeafe",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "11px",
        })
        .setDepth(11);

      attackButtonOuter = this.add
        .circle(attackButtonPos.x, attackButtonPos.y, attackButtonPos.r, 0x1e3a8a, 0.52)
        .setStrokeStyle(3, 0xbfdbfe, 0.95)
        .setDepth(20);
      attackButtonInner = this.add
        .circle(attackButtonPos.x, attackButtonPos.y, 20, 0xf97316, 0.85)
        .setStrokeStyle(2, 0xfef3c7, 1)
        .setDepth(21);
      this.add
        .text(attackButtonPos.x, attackButtonPos.y, "공격", {
          color: "#fff7ed",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "11px",
        })
        .setOrigin(0.5)
        .setDepth(22);

      if (this.input.keyboard) {
        cursors = this.input.keyboard.createCursorKeys();
        w = this.input.keyboard.addKey(PhaserRef.Input.Keyboard.KeyCodes.W);
        a = this.input.keyboard.addKey(PhaserRef.Input.Keyboard.KeyCodes.A);
        s = this.input.keyboard.addKey(PhaserRef.Input.Keyboard.KeyCodes.S);
        d = this.input.keyboard.addKey(PhaserRef.Input.Keyboard.KeyCodes.D);
        space = this.input.keyboard.addKey(PhaserRef.Input.Keyboard.KeyCodes.SPACE);
      }

      const isAttackButtonHit = (x: number, y: number) => Math.hypot(x - attackButtonPos.x, y - attackButtonPos.y) <= attackButtonPos.r;

      this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        if (isAttackButtonHit(pointer.x, pointer.y)) {
          attackButtonPressed = true;
          tryHeroAttack();
          return;
        }
        attackButtonPressed = false;
        pointerMoveActive = true;
        pointerTargetX = pointer.x;
        pointerTargetY = pointer.y;
      });

      this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
        if (!pointer.isDown || attackButtonPressed) return;
        pointerMoveActive = true;
        pointerTargetX = pointer.x;
        pointerTargetY = pointer.y;
      });

      this.input.on("pointerup", () => {
        pointerMoveActive = false;
        attackButtonPressed = false;
      });

      onTick(allies.length, enemies.length);
    },
    update(this: Phaser.Scene, _t: number, delta: number) {
      if (!hero || !shadow || ended || !heroAlive) return;

      const dt = delta / 1000;
      heroCdLeft = Math.max(0, heroCdLeft - delta);
      heroDurLeft = Math.max(0, heroDurLeft - delta);

      const lx = Boolean(cursors?.left?.isDown || a?.isDown);
      const rx = Boolean(cursors?.right?.isDown || d?.isDown);
      const uy = Boolean(cursors?.up?.isDown || w?.isDown);
      const dy = Boolean(cursors?.down?.isDown || s?.isDown);
      const sx = (rx ? 1 : 0) - (lx ? 1 : 0);
      const sy = (dy ? 1 : 0) - (uy ? 1 : 0);
      if (sx !== 0 || sy !== 0) {
        const len = Math.hypot(sx, sy);
        const nx = sx / len;
        const ny = sy / len;
        hero.x += nx * heroSpeed * dt;
        hero.y += ny * heroSpeed * dt;
        facing = { x: nx, y: ny };
      } else if (pointerMoveActive) {
        const dx = pointerTargetX - hero.x;
        const dy = pointerTargetY - hero.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 6) {
          const nx = dx / dist;
          const ny = dy / dist;
          hero.x += nx * heroSpeed * dt;
          hero.y += ny * heroSpeed * dt;
          facing = { x: nx, y: ny };
        }
      }
      clampObj(hero);
      resolveObstacleCollision(hero, 11);
      shadow.setPosition(hero.x, hero.y + 10);

      const downSpace = Boolean(space?.isDown);
      const pressedSpace = downSpace && !spacePrev;
      spacePrev = downSpace;
      if (pressedSpace) tryHeroAttack();

      if (attackButtonOuter && attackButtonInner) {
        attackButtonOuter.setAlpha(attackButtonPressed ? 0.9 : 0.52);
        attackButtonInner.setScale(attackButtonPressed ? 0.9 : 1);
      }

      for (let i = 0; i < allies.length; i += 1) {
        const u = allies[i];
        if (!u.alive) continue;
        u.cooldown = Math.max(0, u.cooldown - delta);
        const near = nearest(u.sprite.x, u.sprite.y, enemies, detectRange);
        if (near) moveTo(u.sprite, near.sprite.x, near.sprite.y, allySpeed, dt, attackRange);
        else {
          const slot = followSlot(i, allies.length, 52 + (i % 4) * 3, Math.PI * 0.25);
          moveTo(u.sprite, slot.x, slot.y, allySpeed * 0.9, dt, 8);
        }
        clampObj(u.sprite);
        resolveObstacleCollision(u.sprite, 7);
      }

      for (let i = 0; i < enemies.length; i += 1) {
        const u = enemies[i];
        if (!u.alive) continue;
        u.cooldown = Math.max(0, u.cooldown - delta);
        const near = nearest(u.sprite.x, u.sprite.y, allies, detectRange);
        if (near) moveTo(u.sprite, near.sprite.x, near.sprite.y, enemySpeed, dt, attackRange);
        else {
          const slot = followSlot(i, enemies.length, 30 + (i % 3) * 3, Math.PI * -0.7);
          moveTo(u.sprite, slot.x, slot.y, enemySpeed * 0.86, dt, 3);
        }
        clampObj(u.sprite);
        resolveObstacleCollision(u.sprite, 7);
      }

      separate();
      resolveObstacleCollision(hero, 11);
      for (const u of allies) resolveObstacleCollision(u.sprite, 7);
      for (const u of enemies) resolveObstacleCollision(u.sprite, 7);
      shadow.setPosition(hero.x, hero.y + 10);

      if (heroDurLeft > 0) {
        for (const e0 of enemies) {
          if (!e0.alive) continue;
          const dx = e0.sprite.x - hero.x;
          const dy = e0.sprite.y - hero.y;
          const dist = Math.hypot(dx, dy);
          if (dist > heroRange) continue;
          const nx = dx / Math.max(0.0001, dist);
          const ny = dy / Math.max(0.0001, dist);
          const dot = nx * facing.x + ny * facing.y;
          if (dot < Math.cos(heroArc)) continue;
          e0.alive = false;
          swingFx(this, hero.x, hero.y, e0.sprite.x, e0.sprite.y, 0xf59e0b);
        }
      }

      for (const u of allies) {
        if (!u.alive || u.cooldown > 0) continue;
        const t = nearest(u.sprite.x, u.sprite.y, enemies, swingRange);
        if (!t) continue;
        swingFx(this, u.sprite.x, u.sprite.y, t.sprite.x, t.sprite.y, 0xbfdbfe);
        t.alive = false;
        u.cooldown = unitCd;
      }

      for (const u of enemies) {
        if (!u.alive || u.cooldown > 0) continue;
        const allyTarget = nearest(u.sprite.x, u.sprite.y, allies, swingRange);
        const heroDist = Math.hypot(u.sprite.x - hero.x, u.sprite.y - hero.y);
        const heroInRange = heroDist <= swingRange;
        if (!allyTarget && !heroInRange) continue;

        if (allyTarget && (!heroInRange || Math.hypot(u.sprite.x - allyTarget.sprite.x, u.sprite.y - allyTarget.sprite.y) <= heroDist)) {
          swingFx(this, u.sprite.x, u.sprite.y, allyTarget.sprite.x, allyTarget.sprite.y, 0xfca5a5);
          allyTarget.alive = false;
          u.cooldown = unitCd;
        } else {
          swingFx(this, u.sprite.x, u.sprite.y, hero.x, hero.y, 0xfca5a5);
          heroAlive = false;
          u.cooldown = unitCd;
        }
      }

      for (let i = allies.length - 1; i >= 0; i -= 1) if (!allies[i].alive) { allies[i].sprite.destroy(); allies.splice(i, 1); }
      for (let i = enemies.length - 1; i >= 0; i -= 1) if (!enemies[i].alive) { enemies[i].sprite.destroy(); enemies.splice(i, 1); }

      onTick(allies.length, enemies.length);

      if (!heroAlive) {
        ended = true;
        hero.setFillStyle(0x7f1d1d, 1);
        this.time.delayedCall(320, () => onEnd("defeat"));
        return;
      }
      if (enemies.length === 0) {
        ended = true;
        this.time.delayedCall(280, () => onEnd("victory"));
      }
    },
  };

  return new PhaserRef.Game({ type: PhaserRef.AUTO, width: MAP_WIDTH, height: MAP_HEIGHT, parent, scene, scale: { mode: PhaserRef.Scale.FIT, autoCenter: PhaserRef.Scale.CENTER_BOTH } });
}

export function PhaserJoseonWarfrontGame() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const fullscreenRef = useRef<HTMLDivElement | null>(null);
  const [runId, setRunId] = useState(0);
  const [turn, setTurn] = useState(1);
  const [owners, setOwners] = useState<number[]>([]);
  const [terrain, setTerrain] = useState<Terrain[]>([]);
  const [phase, setPhase] = useState<"strategy" | "battle" | "ended">("strategy");
  const [status, setStatus] = useState("전략 모드");
  const [battle, setBattle] = useState<BattleConfig | null>(null);
  const [alliesLeft, setAlliesLeft] = useState(0);
  const [enemiesLeft, setEnemiesLeft] = useState(0);
  const [log, setLog] = useState("인접한 적 영토를 선택해 공격하세요.");
  const [best, setBest] = useState(0);
  const [saveReady, setSaveReady] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const initWorld = useMemo(() => buildWorld(), []);
  useEffect(() => {
    setOwners(initWorld.owners);
    setTerrain(initWorld.terrain);
    setBest((prev) => Math.max(prev, countOwned(initWorld.owners, PLAYER)));
  }, [initWorld]);

  useEffect(() => {
    const saved = loadGameSave<{ bestTerritories?: number }>(GAME_SLUG);
    if (typeof saved?.data?.bestTerritories === "number") {
      setBest((prev) => Math.max(prev, saved.data.bestTerritories as number));
    }
    setSaveReady(true);
  }, []);

  const myLand = useMemo(() => countOwned(owners, PLAYER), [owners]);
  const otherLand = Math.max(0, REGIONS.length - myLand);

  useEffect(() => {
    if (!saveReady) return;
    saveGameSave(GAME_SLUG, GAME_TITLE, { bestTerritories: best });
  }, [best, saveReady]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const syncFullscreen = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
    };
  }, []);

  useEffect(() => {
    if (!mountRef.current || owners.length !== REGIONS.length || terrain.length !== REGIONS.length) return;
    let cancelled = false;
    let game: Phaser.Game | null = null;

    const start = async () => {
      const m = await import("phaser");
      const PhaserRef = ("default" in m ? m.default : m) as PhaserRuntime;
      if (cancelled || !mountRef.current) return;

      if (phase === "strategy" || phase === "ended") {
        game = createStrategyGame({
          PhaserRef,
          parent: mountRef.current,
          owners,
          terrain,
          turn,
          allowAttack: phase === "strategy",
          onAttack: (targetId) => {
            if (cancelled) return;
            const defender = owners[targetId];
            if (defender === PLAYER) return;
            const atk = countOwned(owners, PLAYER);
            const def = countOwned(owners, defender);
            if (atk <= 0 || def <= 0) return;
            setBattle({ targetId, defenderFaction: defender, attackerCount: atk, defenderCount: def, terrain: terrain[targetId] });
            setAlliesLeft(atk);
            setEnemiesLeft(def);
            setStatus("전투 모드");
            setLog(`${targetId + 1}번 권역 침공: 아군 ${atk} vs ${FACTIONS[defender].name} ${def}`);
            setPhase("battle");
          },
        });
        return;
      }

      if (phase === "battle" && battle) {
        game = createBattleGame({
          PhaserRef,
          parent: mountRef.current,
          config: battle,
          onTick: (a0, e0) => {
            if (cancelled) return;
            setAlliesLeft((p) => (p === a0 ? p : a0));
            setEnemiesLeft((p) => (p === e0 ? p : e0));
          },
          onEnd: (result) => {
            if (cancelled) return;
            setOwners((prev) => {
              const next = [...prev];
              if (result === "victory") {
                next[battle.targetId] = PLAYER;
                setLog(`${battle.targetId + 1}번 권역 점령 성공`);
              } else {
                const candidates = REGIONS[battle.targetId].neighbors.filter((n) => next[n] === PLAYER);
                if (candidates.length > 0) {
                  const lost = candidates[rint(candidates.length)];
                  next[lost] = battle.defenderFaction;
                  setLog(`전투 패배: ${lost + 1}번 권역 상실 (${FACTIONS[battle.defenderFaction].name}에게)`);
                } else {
                  setLog("전투 패배: 인접 아군 영토가 없어 추가 상실 없음");
                }
              }

              const mine = countOwned(next, PLAYER);
              setBest((b0) => Math.max(b0, mine));
              if (mine <= 0) {
                setStatus("패배");
                setPhase("ended");
              } else if (mine >= REGIONS.length) {
                setStatus("통일 달성");
                setPhase("ended");
              } else {
                setStatus("전략 모드");
                setPhase("strategy");
              }
              setTurn((t) => t + 1);
              return next;
            });
          },
        });
      }
    };

    void start();
    return () => {
      cancelled = true;
      if (game) game.destroy(true);
    };
  }, [owners, terrain, phase, battle, turn, runId]);

  useEffect(() => {
    if (phase === "strategy" && owners.length === REGIONS.length && !canAttackAny(owners)) {
      setStatus("공격 불가");
      setPhase("ended");
      setLog("인접한 타 세력 영토가 없어 이번 판이 종료됩니다.");
    }
  }, [phase, owners]);

  const resetRun = () => {
    const w0 = buildWorld();
    setRunId((r) => r + 1);
    setOwners(w0.owners);
    setTerrain(w0.terrain);
    setBattle(null);
    setAlliesLeft(0);
    setEnemiesLeft(0);
    setTurn(1);
    setStatus("전략 모드");
    setLog("새 판 시작: 7개 세력 배치 완료");
    setPhase("strategy");
    setBest((b0) => Math.max(b0, countOwned(w0.owners, PLAYER)));
  };

  const toggleFullscreen = async () => {
    const root = fullscreenRef.current;
    if (!root || typeof document === "undefined") return;

    const doc = document as Document & {
      webkitExitFullscreen?: () => Promise<void> | void;
      webkitFullscreenElement?: Element | null;
    };

    const elem = root as HTMLDivElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
    };

    const active = Boolean(doc.fullscreenElement || doc.webkitFullscreenElement);
    if (active) {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (doc.webkitExitFullscreen) {
        await doc.webkitExitFullscreen();
      }
      return;
    }

    try {
      if (elem.requestFullscreen) {
        await elem.requestFullscreen();
      } else if (elem.webkitRequestFullscreen) {
        await elem.webkitRequestFullscreen();
      } else {
        setLog("이 브라우저는 전체화면 모드를 지원하지 않습니다.");
      }
    } catch {
      setLog("전체화면 전환에 실패했습니다. 브라우저 권한을 확인해 주세요.");
    }
  };

  const help =
    phase === "strategy"
      ? "전략 모드: 인접한 타 세력 영토를 클릭하면 전투 시작"
      : phase === "battle"
        ? "전투 모드: 병사 자동 검격(3초), 주인공 수동 조작"
        : "게임 종료: 리셋 버튼으로 새 판 시작";

  return (
    <div className={styles.panel}>
      <header className={styles.stats}>
        <span>상태: {status}</span>
        <span>턴: {turn}</span>
        <span>아군 영토: {myLand}</span>
        <span>타 세력 영토: {otherLand}</span>
        <span>최고 영토 수: {best}</span>
      </header>
      <div ref={fullscreenRef} className={styles.canvasShell}>
        <div ref={mountRef} className={styles.canvasMount} />
      </div>
      <div className={styles.controls}>
        <button type="button" className={styles.control} onClick={resetRun}>
          리셋
        </button>
        <button type="button" className={styles.control} onClick={() => void toggleFullscreen()}>
          {isFullscreen ? "전체화면 해제" : "전체화면"}
        </button>
        <p className={styles.help}>
          {help} | 전투 병력(생존): 아군 {alliesLeft} / 적 {enemiesLeft} | 로그: {log}
        </p>
      </div>
    </div>
  );
}
