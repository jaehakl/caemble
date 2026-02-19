"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type Phaser from "phaser";
import { loadGameSave, saveGameSave } from "@/app/lib/save-protocol";
import styles from "./RoguelikeRpgGame.module.css";

const GAME_SLUG = "roguelike-rpg";
const GAME_TITLE = "Drift Rogue";
const VIEW_RADIUS = 7;
const TILE_SIZE = 34;
const MAX_LOG_LINES = 12;
const START_STATS = { strength: 8, agility: 6, maxHp: 42 };

const CANVAS_SIZE = (VIEW_RADIUS * 2 + 1) * TILE_SIZE;
const CANVAS_HEIGHT = CANVAS_SIZE + 52;

type PhaserRuntime = typeof Phaser;

type Position = {
  x: number;
  y: number;
};

type Stats = {
  strength: number;
  agility: number;
  maxHp: number;
};

type GearType = "sword" | "armor" | "potion";

type GearItem = {
  id: number;
  type: GearType;
  name: string;
  strength: number;
  agility: number;
  maxHp: number;
  weaponFactor: number;
  defense: number;
  heal: number;
};

type Enemy = {
  id: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  strength: number;
  agility: number;
  weaponFactor: number;
  defense: number;
};

type RunData = {
  position: Position;
  baseStats: Stats;
  hp: number;
  sword: GearItem | null;
  armor: GearItem | null;
  inventory: GearItem[];
  enemies: Enemy[];
  combatEnemyId: number | null;
  nextEnemyId: number;
  nextItemId: number;
  killCount: number;
};

type SaveData = {
  bestDepth: number;
  bestKills: number;
  run: RunData | null;
};

type RenderSnapshot = {
  position: Position;
  enemies: Enemy[];
  combatEnemyId: number | null;
  hp: number;
  maxHp: number;
};

type PhaserController = {
  game: Phaser.Game;
  sync: (snapshot: RenderSnapshot) => void;
  flashPlayerHit: () => void;
  flashEnemyHit: (enemyId: number) => void;
};

type CreateRoguelikeGameOptions = {
  PhaserRef: PhaserRuntime;
  parent: HTMLDivElement;
  onMove: (dx: number, dy: number) => void;
  onReset: () => void;
};

const DIRECTIONS: Position[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

function keyOf(x: number, y: number) {
  return `${x},${y}`;
}

function hashToUnit(x: number, y: number) {
  let n = x * 374761393 + y * 668265263;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) >>> 0) / 4294967296;
}

function isWall(x: number, y: number) {
  if (x === 0 && y === 0) {
    return false;
  }
  return hashToUnit(x, y) < 0.16;
}

function isPassable(x: number, y: number) {
  return !isWall(x, y);
}

function randomInt(min: number, max: number) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function shuffleDirections() {
  const copy = [...DIRECTIONS];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function makeEnemy(id: number, distance: number): Enemy {
  const level = Math.max(1, Math.floor(distance / 5) + 1);
  const maxHp = 24 + level * 8 + randomInt(0, 10);
  return {
    id,
    x: 0,
    y: 0,
    hp: maxHp,
    maxHp,
    strength: 5 + level * 2 + randomInt(0, 2),
    agility: 4 + level * 2 + randomInt(0, 3),
    weaponFactor: 0.8 + level * 0.08 + Math.random() * 0.2,
    defense: 1 + level + randomInt(0, 2),
  };
}

function makeItem(id: number): GearItem {
  const roll = Math.random();
  const type: GearType = roll < 0.38 ? "sword" : roll < 0.76 ? "armor" : "potion";
  if (type === "potion") {
    const heal = randomInt(14, 34);
    const prefix = ["초록빛", "은빛", "응급", "고농축"];
    return {
      id,
      type,
      name: `${prefix[randomInt(0, prefix.length - 1)]} 힐링 포션`,
      strength: 0,
      agility: 0,
      maxHp: 0,
      weaponFactor: 1,
      defense: 0,
      heal,
    };
  }

  const prefix = ["낡은", "강철", "사파이어", "암흑", "고대", "폭풍", "서리"];
  const suffix = type === "sword" ? "검" : "갑옷";
  const quality = randomInt(1, 7);
  return {
    id,
    type,
    name: `${prefix[randomInt(0, prefix.length - 1)]} ${suffix}`,
    strength: randomInt(0, quality + 1),
    agility: randomInt(0, quality),
    maxHp: randomInt(0, quality + 2),
    weaponFactor: type === "sword" ? 1 + quality * 0.12 + Math.random() * 0.24 : 1,
    defense: type === "armor" ? quality + randomInt(1, 5) : 0,
    heal: 0,
  };
}

function formatTime(date: Date) {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function centerPx(index: number) {
  return index * TILE_SIZE + TILE_SIZE / 2;
}

function worldToScreen(value: number, center: number) {
  return centerPx(value - center + VIEW_RADIUS);
}

function createRoguelikePhaserGame({
  PhaserRef,
  parent,
  onMove,
  onReset,
}: CreateRoguelikeGameOptions): PhaserController {
  let gameObjects: Phaser.GameObjects.GameObjectFactory | null = null;
  let mainCamera: Phaser.Cameras.Scene2D.Camera | null = null;
  let tweenManager: Phaser.Tweens.TweenManager | null = null;
  let snapshot: RenderSnapshot | null = null;
  let playerMarker: Phaser.GameObjects.Arc | null = null;
  let hpFill: Phaser.GameObjects.Rectangle | null = null;
  let infoText: Phaser.GameObjects.Text | null = null;
  let cursors: Phaser.Types.Input.Keyboard.CursorKeys | null = null;
  let keyW: Phaser.Input.Keyboard.Key | null = null;
  let keyA: Phaser.Input.Keyboard.Key | null = null;
  let keyS: Phaser.Input.Keyboard.Key | null = null;
  let keyD: Phaser.Input.Keyboard.Key | null = null;
  let keyR: Phaser.Input.Keyboard.Key | null = null;
  let playerLight: Phaser.GameObjects.Arc | null = null;

  const tileNodes = new Map<string, Phaser.GameObjects.Rectangle>();
  const enemyNodes = new Map<
    number,
    {
      body: Phaser.GameObjects.Ellipse;
      hpBack: Phaser.GameObjects.Rectangle;
      hpFront: Phaser.GameObjects.Rectangle;
    }
  >();

  const emitBurst = (x: number, y: number, color: number, amount: number) => {
    if (!gameObjects || !tweenManager) {
      return;
    }

    for (let i = 0; i < amount; i += 1) {
      const particle = gameObjects.circle(x, y, PhaserRef.Math.Between(2, 4), color, 0.95).setDepth(20);
      const angle = PhaserRef.Math.FloatBetween(0, Math.PI * 2);
      const distance = PhaserRef.Math.Between(14, 36);
      tweenManager.add({
        targets: particle,
        x: x + Math.cos(angle) * distance,
        y: y + Math.sin(angle) * distance,
        alpha: 0,
        scale: PhaserRef.Math.FloatBetween(0.5, 1.4),
        duration: PhaserRef.Math.Between(200, 340),
        ease: "Quad.Out",
        onComplete: () => {
          particle.destroy();
        },
      });
    }
  };

  const syncView = () => {
    if (!gameObjects || !snapshot || !playerMarker || !hpFill || !infoText || !playerLight) {
      return;
    }

    const visibleTiles = new Set<string>();
    const visibleEnemies = new Set<number>();
    const center = snapshot.position;

    for (let wy = center.y - VIEW_RADIUS; wy <= center.y + VIEW_RADIUS; wy += 1) {
      for (let wx = center.x - VIEW_RADIUS; wx <= center.x + VIEW_RADIUS; wx += 1) {
        const tileKey = keyOf(wx, wy);
        visibleTiles.add(tileKey);
        const sx = worldToScreen(wx, center.x);
        const sy = worldToScreen(wy, center.y) + 48;

        let tile = tileNodes.get(tileKey);
        if (!tile) {
          tile = gameObjects.rectangle(sx, sy, TILE_SIZE - 3, TILE_SIZE - 3, 0x0f766e, 1).setDepth(1);
          tileNodes.set(tileKey, tile);
        }

        tile.setPosition(sx, sy);
        if (wx === center.x && wy === center.y) {
          tile.setFillStyle(0x0f172a, 0.9);
        } else if (isPassable(wx, wy)) {
          const noise = hashToUnit(wx * 2 + 11, wy * 3 + 13);
          tile.setFillStyle(noise > 0.58 ? 0x115e59 : 0x134e4a, 0.95);
        } else {
          tile.setFillStyle(0x052e16, 1);
        }
      }
    }

    for (const [tileKey, tile] of tileNodes) {
      if (!visibleTiles.has(tileKey)) {
        tile.destroy();
        tileNodes.delete(tileKey);
      }
    }

    for (const enemy of snapshot.enemies) {
      const dx = Math.abs(enemy.x - center.x);
      const dy = Math.abs(enemy.y - center.y);
      if (dx > VIEW_RADIUS || dy > VIEW_RADIUS) {
        continue;
      }

      visibleEnemies.add(enemy.id);
      const sx = worldToScreen(enemy.x, center.x);
      const sy = worldToScreen(enemy.y, center.y) + 48;
      const hpRate = PhaserRef.Math.Clamp(enemy.hp / enemy.maxHp, 0, 1);
      const isTarget = snapshot.combatEnemyId === enemy.id;

      let node = enemyNodes.get(enemy.id);
      if (!node) {
        const body = gameObjects.ellipse(sx, sy, 18, 18, 0xef4444, 1).setDepth(6);
        const hpBack = gameObjects.rectangle(sx, sy - 13, 20, 3, 0x111827, 0.9).setDepth(7);
        const hpFront = gameObjects.rectangle(sx - 10, sy - 13, 20, 3, 0x22c55e, 1).setOrigin(0, 0.5).setDepth(8);
        node = { body, hpBack, hpFront };
        enemyNodes.set(enemy.id, node);
      }

      node.body.setPosition(sx, sy);
      node.body.setStrokeStyle(isTarget ? 2 : 1, isTarget ? 0xfef08a : 0x7f1d1d, 1);
      node.body.setScale(isTarget ? 1.12 : 1);
      node.hpBack.setPosition(sx, sy - 13);
      node.hpFront.setPosition(sx - 10, sy - 13);
      node.hpFront.displayWidth = Math.max(1, 20 * hpRate);
      node.hpFront.setFillStyle(hpRate > 0.45 ? 0x22c55e : hpRate > 0.2 ? 0xf59e0b : 0xf43f5e, 1);
    }

    for (const [enemyId, node] of enemyNodes) {
      if (!visibleEnemies.has(enemyId)) {
        node.body.destroy();
        node.hpBack.destroy();
        node.hpFront.destroy();
        enemyNodes.delete(enemyId);
      }
    }

    playerMarker.setPosition(centerPx(VIEW_RADIUS), centerPx(VIEW_RADIUS) + 48);
    playerLight.setPosition(centerPx(VIEW_RADIUS), centerPx(VIEW_RADIUS) + 48);
    const hpRate = PhaserRef.Math.Clamp(snapshot.hp / Math.max(1, snapshot.maxHp), 0, 1);
    hpFill.displayWidth = 160 * hpRate;
    hpFill.setFillStyle(hpRate > 0.42 ? 0x14b8a6 : hpRate > 0.18 ? 0xf59e0b : 0xf43f5e, 1);
    infoText.setText(`Pos (${center.x}, ${center.y})  Enemies ${snapshot.enemies.length}`);
  };

  const scene: Phaser.Types.Scenes.SceneType = {
    key: "DriftRogueScene",
    create(this: Phaser.Scene) {
      gameObjects = this.add;
      mainCamera = this.cameras.main;
      tweenManager = this.tweens;
      this.cameras.main.setRoundPixels(true);

      const bg = this.add.graphics().setDepth(-5);
      bg.fillGradientStyle(0x021616, 0x082f2f, 0x0f3d3d, 0x042f2e, 1);
      bg.fillRect(0, 0, CANVAS_SIZE, CANVAS_HEIGHT);

      this.add.rectangle(CANVAS_SIZE / 2, CANVAS_HEIGHT / 2 + 24, CANVAS_SIZE - 14, CANVAS_SIZE + 18, 0x0b1f1f, 1).setDepth(-4);
      this.add.ellipse(CANVAS_SIZE / 2, CANVAS_HEIGHT / 2 + 24, CANVAS_SIZE - 12, CANVAS_SIZE, 0x000000, 0.35).setDepth(2);

      playerMarker = this.add.circle(centerPx(VIEW_RADIUS), centerPx(VIEW_RADIUS) + 48, 9, 0xfde047, 1).setDepth(9);
      playerMarker.setStrokeStyle(2, 0xffffff, 0.45);
      playerLight = this.add.circle(centerPx(VIEW_RADIUS), centerPx(VIEW_RADIUS) + 48, 52, 0x5eead4, 0.14).setDepth(5);
      playerLight.setBlendMode(PhaserRef.BlendModes.ADD);

      for (let i = 0; i < 26; i += 1) {
        const mote = this.add
          .circle(
            PhaserRef.Math.Between(14, CANVAS_SIZE - 14),
            PhaserRef.Math.Between(58, CANVAS_HEIGHT - 10),
            PhaserRef.Math.Between(1, 2),
            0xa7f3d0,
            PhaserRef.Math.FloatBetween(0.15, 0.35),
          )
          .setDepth(4)
          .setBlendMode(PhaserRef.BlendModes.ADD);
        this.tweens.add({
          targets: mote,
          y: mote.y - PhaserRef.Math.Between(8, 20),
          alpha: PhaserRef.Math.FloatBetween(0.05, 0.25),
          duration: PhaserRef.Math.Between(1200, 2400),
          repeat: -1,
          yoyo: true,
          delay: PhaserRef.Math.Between(0, 800),
          ease: "Sine.InOut",
        });
      }

      this.add.text(16, 13, "WASD / Arrow: Move", {
        color: "#ccfbf1",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "14px",
      });

      infoText = this.add.text(CANVAS_SIZE - 16, 13, "", {
        color: "#99f6e4",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "14px",
      }).setOrigin(1, 0);

      this.add.rectangle(16, 34, 160, 8, 0x111827, 1).setOrigin(0, 0.5).setDepth(10);
      hpFill = this.add.rectangle(16, 34, 160, 8, 0x14b8a6, 1).setOrigin(0, 0.5).setDepth(11);

      if (this.input.keyboard) {
        cursors = this.input.keyboard.createCursorKeys();
        keyW = this.input.keyboard.addKey(PhaserRef.Input.Keyboard.KeyCodes.W);
        keyA = this.input.keyboard.addKey(PhaserRef.Input.Keyboard.KeyCodes.A);
        keyS = this.input.keyboard.addKey(PhaserRef.Input.Keyboard.KeyCodes.S);
        keyD = this.input.keyboard.addKey(PhaserRef.Input.Keyboard.KeyCodes.D);
        keyR = this.input.keyboard.addKey(PhaserRef.Input.Keyboard.KeyCodes.R);
      }

      syncView();
    },
    update(this: Phaser.Scene, time: number) {
      if (!cursors || !keyW || !keyA || !keyS || !keyD || !keyR) {
        return;
      }

      if (
        PhaserRef.Input.Keyboard.JustDown(cursors.up) ||
        PhaserRef.Input.Keyboard.JustDown(keyW)
      ) {
        onMove(0, -1);
      } else if (
        PhaserRef.Input.Keyboard.JustDown(cursors.down) ||
        PhaserRef.Input.Keyboard.JustDown(keyS)
      ) {
        onMove(0, 1);
      } else if (
        PhaserRef.Input.Keyboard.JustDown(cursors.left) ||
        PhaserRef.Input.Keyboard.JustDown(keyA)
      ) {
        onMove(-1, 0);
      } else if (
        PhaserRef.Input.Keyboard.JustDown(cursors.right) ||
        PhaserRef.Input.Keyboard.JustDown(keyD)
      ) {
        onMove(1, 0);
      }

      if (PhaserRef.Input.Keyboard.JustDown(keyR)) {
        onReset();
      }

      if (snapshot && snapshot.combatEnemyId !== null) {
        const targetNode = enemyNodes.get(snapshot.combatEnemyId);
        if (targetNode) {
          targetNode.body.setScale(1.08 + Math.sin(time / 120) * 0.08);
        }
      }
    },
  };

  const game = new PhaserRef.Game({
    type: PhaserRef.AUTO,
    width: CANVAS_SIZE,
    height: CANVAS_HEIGHT,
    parent,
    backgroundColor: "#031515",
    scene,
    scale: {
      mode: PhaserRef.Scale.FIT,
      autoCenter: PhaserRef.Scale.CENTER_BOTH,
    },
  });

  return {
    game,
    sync(nextSnapshot) {
      snapshot = nextSnapshot;
      syncView();
    },
    flashPlayerHit() {
      if (!mainCamera || !tweenManager || !playerMarker) {
        return;
      }

      playerMarker.setFillStyle(0xfda4af, 1);
      mainCamera.shake(90, 0.0035);
      emitBurst(playerMarker.x, playerMarker.y, 0xfda4af, 7);
      tweenManager.add({
        targets: playerMarker,
        scale: 1.24,
        duration: 90,
        yoyo: true,
        onComplete: () => {
          if (playerMarker) {
            playerMarker.setFillStyle(0xfde047, 1);
          }
        },
      });
    },
    flashEnemyHit(enemyId) {
      if (!tweenManager) {
        return;
      }

      const node = enemyNodes.get(enemyId);
      if (!node) {
        return;
      }

      node.body.setFillStyle(0xfca5a5, 1);
      emitBurst(node.body.x, node.body.y, 0xfca5a5, 6);
      tweenManager.add({
        targets: node.body,
        angle: 16,
        duration: 60,
        yoyo: true,
        repeat: 1,
        onComplete: () => {
          node.body.setFillStyle(0xef4444, 1);
          node.body.setAngle(0);
        },
      });
    },
  };
}

export function RoguelikeRpgGame() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<PhaserController | null>(null);
  const moveRef = useRef<(dx: number, dy: number) => void>(() => undefined);
  const resetRef = useRef<() => void>(() => undefined);

  const [position, setPosition] = useState<Position>({ x: 0, y: 0 });
  const [baseStats, setBaseStats] = useState<Stats>(START_STATS);
  const [hp, setHp] = useState(START_STATS.maxHp);
  const [sword, setSword] = useState<GearItem | null>(null);
  const [armor, setArmor] = useState<GearItem | null>(null);
  const [inventory, setInventory] = useState<GearItem[]>([]);
  const [enemies, setEnemies] = useState<Enemy[]>([]);
  const [combatEnemyId, setCombatEnemyId] = useState<number | null>(null);
  const [killCount, setKillCount] = useState(0);
  const [bestDepth, setBestDepth] = useState(() => {
    if (typeof window === "undefined") {
      return 0;
    }
    return loadGameSave<SaveData>(GAME_SLUG)?.data?.bestDepth ?? 0;
  });
  const [bestKills, setBestKills] = useState(() => {
    if (typeof window === "undefined") {
      return 0;
    }
    return loadGameSave<SaveData>(GAME_SLUG)?.data?.bestKills ?? 0;
  });
  const [battleLog, setBattleLog] = useState<string[]>(() => [
    `[${formatTime(new Date())}] 새 여정을 시작했습니다.`,
  ]);
  const [saveUpdatedAt, setSaveUpdatedAt] = useState<string | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }
    return loadGameSave<SaveData>(GAME_SLUG)?.updatedAt ?? null;
  });

  const nextEnemyIdRef = useRef(1);
  const nextItemIdRef = useRef(1);

  const appendLog = useCallback((text: string) => {
    const stamp = formatTime(new Date());
    setBattleLog((prev) => [`[${stamp}] ${text}`, ...prev].slice(0, MAX_LOG_LINES));
  }, []);

  const totalStats = useMemo(() => {
    const gear = [sword, armor].filter((item): item is GearItem => item !== null);
    const bonus = gear.reduce(
      (acc, item) => {
        acc.strength += item.strength;
        acc.agility += item.agility;
        acc.maxHp += item.maxHp;
        return acc;
      },
      { strength: 0, agility: 0, maxHp: 0 },
    );

    return {
      strength: baseStats.strength + bonus.strength,
      agility: baseStats.agility + bonus.agility,
      maxHp: baseStats.maxHp + bonus.maxHp,
      swordFactor: sword?.weaponFactor ?? 1,
      armorDefense: armor?.defense ?? 0,
    };
  }, [armor, baseStats.agility, baseStats.maxHp, baseStats.strength, sword]);

  const combatEnemy = useMemo(
    () => enemies.find((enemy) => enemy.id === combatEnemyId) ?? null,
    [combatEnemyId, enemies],
  );

  const spawnEnemiesNear = useCallback((center: Position) => {
    setEnemies((prev) => {
      const nearby = prev.filter((enemy) => Math.abs(enemy.x - center.x) <= 8 && Math.abs(enemy.y - center.y) <= 8);
      if (nearby.length >= 7) {
        return prev;
      }

      const occupied = new Set(prev.map((enemy) => keyOf(enemy.x, enemy.y)));
      occupied.add(keyOf(center.x, center.y));
      const needed = 7 - nearby.length;
      const created: Enemy[] = [];

      for (let index = 0; index < needed; index += 1) {
        let placed = false;
        for (let attempt = 0; attempt < 45; attempt += 1) {
          const dx = randomInt(-9, 9);
          const dy = randomInt(-9, 9);
          if (dx === 0 && dy === 0) {
            continue;
          }
          const tx = center.x + dx;
          const ty = center.y + dy;
          if (!isPassable(tx, ty)) {
            continue;
          }
          const mapKey = keyOf(tx, ty);
          if (occupied.has(mapKey)) {
            continue;
          }

          const distance = Math.abs(tx) + Math.abs(ty);
          const enemy = makeEnemy(nextEnemyIdRef.current, distance);
          nextEnemyIdRef.current += 1;
          enemy.x = tx;
          enemy.y = ty;
          created.push(enemy);
          occupied.add(mapKey);
          placed = true;
          break;
        }

        if (!placed) {
          break;
        }
      }

      return created.length > 0 ? [...prev, ...created] : prev;
    });
  }, []);

  const applyRun = useCallback((run: RunData) => {
    setPosition(run.position ?? { x: 0, y: 0 });
    setBaseStats(run.baseStats ?? START_STATS);
    setHp(typeof run.hp === "number" ? run.hp : START_STATS.maxHp);
    setSword(run.sword ?? null);
    setArmor(run.armor ?? null);
    setInventory(Array.isArray(run.inventory) ? run.inventory : []);
    setEnemies(Array.isArray(run.enemies) ? run.enemies : []);
    setCombatEnemyId(typeof run.combatEnemyId === "number" ? run.combatEnemyId : null);
    setKillCount(typeof run.killCount === "number" ? run.killCount : 0);
    nextEnemyIdRef.current = typeof run.nextEnemyId === "number" ? run.nextEnemyId : 1;
    nextItemIdRef.current = typeof run.nextItemId === "number" ? run.nextItemId : 1;
  }, []);

  const resetGame = useCallback(() => {
    nextEnemyIdRef.current = 1;
    nextItemIdRef.current = 1;
    setPosition({ x: 0, y: 0 });
    setBaseStats(START_STATS);
    setHp(START_STATS.maxHp);
    setSword(null);
    setArmor(null);
    setInventory([]);
    setEnemies([]);
    setCombatEnemyId(null);
    setKillCount(0);
    setBattleLog([]);
    appendLog("새 여정을 시작했습니다.");
    spawnEnemiesNear({ x: 0, y: 0 });
  }, [appendLog, spawnEnemiesNear]);

  const saveNow = useCallback(() => {
    const payload: SaveData = {
      bestDepth,
      bestKills,
      run: {
        position,
        baseStats,
        hp,
        sword,
        armor,
        inventory,
        enemies,
        combatEnemyId,
        nextEnemyId: nextEnemyIdRef.current,
        nextItemId: nextItemIdRef.current,
        killCount,
      },
    };

    const envelope = saveGameSave(GAME_SLUG, GAME_TITLE, payload);
    if (envelope) {
      setSaveUpdatedAt(envelope.updatedAt);
      appendLog("세이브 완료.");
    }
  }, [
    appendLog,
    armor,
    baseStats,
    bestDepth,
    bestKills,
    combatEnemyId,
    enemies,
    hp,
    inventory,
    killCount,
    position,
    sword,
  ]);

  const loadFromSave = useCallback(() => {
    const saved = loadGameSave<SaveData>(GAME_SLUG);
    if (!saved?.data) {
      appendLog("저장 데이터가 없습니다.");
      return;
    }

    setBestDepth(typeof saved.data.bestDepth === "number" ? saved.data.bestDepth : 0);
    setBestKills(typeof saved.data.bestKills === "number" ? saved.data.bestKills : 0);

    if (saved.data.run) {
      applyRun(saved.data.run);
      appendLog("세이브 데이터를 불러왔습니다.");
    } else {
      appendLog("기록만 저장된 상태입니다.");
    }

    setSaveUpdatedAt(saved.updatedAt);
  }, [appendLog, applyRun]);

  useEffect(() => {
    spawnEnemiesNear(position);
  }, [position, spawnEnemiesNear]);

  useEffect(() => {
    const depth = Math.abs(position.x) + Math.abs(position.y);
    setBestDepth((prev) => (depth > prev ? depth : prev));
  }, [position.x, position.y]);

  useEffect(() => {
    setBestKills((prev) => (killCount > prev ? killCount : prev));
  }, [killCount]);

  const tryMove = useCallback(
    (dx: number, dy: number) => {
      if (hp <= 0) {
        appendLog("사망 상태입니다. R 또는 리셋 버튼으로 재시작하세요.");
        return;
      }

      const nx = position.x + dx;
      const ny = position.y + dy;
      if (!isPassable(nx, ny)) {
        appendLog("벽입니다.");
        return;
      }

      const enemy = enemies.find((target) => target.x === nx && target.y === ny);
      if (enemy) {
        if (combatEnemyId !== null && combatEnemyId !== enemy.id) {
          appendLog(`적 ${combatEnemyId}과(와) 거리를 벌리고 적 ${enemy.id}(으)로 교전 전환.`);
        }
        setCombatEnemyId(enemy.id);
        appendLog(`적 ${enemy.id}과(와) 교전 시작.`);
        return;
      }

      if (combatEnemyId !== null) {
        setCombatEnemyId(null);
        appendLog(`적 ${combatEnemyId}과(와)의 교전에서 이탈했습니다.`);
      }

      setPosition({ x: nx, y: ny });
      setBaseStats((prev) => ({ ...prev, agility: prev.agility + 1 }));
    },
    [appendLog, combatEnemyId, enemies, hp, position.x, position.y],
  );

  moveRef.current = tryMove;
  resetRef.current = resetGame;

  useEffect(() => {
    if (!mountRef.current) {
      return;
    }

    let cancelled = false;
    let createdController: PhaserController | null = null;

    const start = async () => {
      const phaserModule = await import("phaser");
      const PhaserRef = ("default" in phaserModule ? phaserModule.default : phaserModule) as PhaserRuntime;

      if (cancelled || !mountRef.current) {
        return;
      }

      createdController = createRoguelikePhaserGame({
        PhaserRef,
        parent: mountRef.current,
        onMove: (dx, dy) => {
          moveRef.current(dx, dy);
        },
        onReset: () => {
          resetRef.current();
        },
      });

      controllerRef.current = createdController;
    };

    void start();

    return () => {
      cancelled = true;
      if (createdController) {
        createdController.game.destroy(true);
      }
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const snapshot: RenderSnapshot = {
      position,
      enemies,
      combatEnemyId,
      hp: Math.max(0, Math.min(hp, totalStats.maxHp)),
      maxHp: totalStats.maxHp,
    };
    controllerRef.current?.sync(snapshot);
  }, [combatEnemyId, enemies, hp, position, totalStats.maxHp]);

  useEffect(() => {
    if (!combatEnemy) {
      return;
    }

    const interval = Math.max(220, 1200 - totalStats.agility * 22);
    const timer = window.setInterval(() => {
      setBaseStats((prev) => ({ ...prev, strength: prev.strength + 1 }));

      setEnemies((prev) => {
        const index = prev.findIndex((enemy) => enemy.id === combatEnemy.id);
        if (index < 0) {
          return prev;
        }

        const enemy = prev[index];
        const enemyEvadeChance = Math.min(0.48, enemy.agility * 0.012);
        if (Math.random() < enemyEvadeChance) {
          appendLog(`적 ${enemy.id}이(가) 회피했습니다.`);
          return prev;
        }

        const raw = totalStats.strength * totalStats.swordFactor;
        const damage = Math.max(1, Math.floor(raw - enemy.defense));
        const nextHp = enemy.hp - damage;
        controllerRef.current?.flashEnemyHit(enemy.id);
        appendLog(`플레이어 공격 ${damage} 피해 (적 ${enemy.id}).`);

        if (nextHp <= 0) {
          const next = prev.filter((candidate) => candidate.id !== enemy.id);
          const dropped = makeItem(nextItemIdRef.current);
          nextItemIdRef.current += 1;
          setInventory((items) => [dropped, ...items]);
          setCombatEnemyId(null);
          setKillCount((prevKills) => prevKills + 1);
          appendLog(`적 ${enemy.id} 처치. ${dropped.name} 획득.`);
          return next;
        }

        const next = [...prev];
        next[index] = { ...enemy, hp: nextHp };
        return next;
      });
    }, interval);

    return () => window.clearInterval(timer);
  }, [appendLog, combatEnemy, totalStats.agility, totalStats.strength, totalStats.swordFactor]);

  useEffect(() => {
    if (!combatEnemy) {
      return;
    }

    const interval = Math.max(320, 1350 - combatEnemy.agility * 20);
    const timer = window.setInterval(() => {
      const playerEvadeChance = Math.min(0.58, totalStats.agility * 0.012);
      if (Math.random() < playerEvadeChance) {
        appendLog("플레이어가 회피했습니다.");
        return;
      }

      const raw = combatEnemy.strength * combatEnemy.weaponFactor;
      const damage = Math.max(1, Math.floor(raw - totalStats.armorDefense));
      setBaseStats((prev) => ({ ...prev, maxHp: prev.maxHp + 1 }));
      setHp((prev) => {
        const next = Math.max(0, prev - damage);
        if (next <= 0) {
          setCombatEnemyId(null);
          appendLog("플레이어가 쓰러졌습니다. R 또는 리셋으로 재시작하세요.");
        } else {
          controllerRef.current?.flashPlayerHit();
          appendLog(`플레이어 피격 ${damage} 피해.`);
        }
        return next;
      });
    }, interval);

    return () => window.clearInterval(timer);
  }, [appendLog, combatEnemy, totalStats.agility, totalStats.armorDefense]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setEnemies((prev) => {
        const occupied = new Set(prev.map((enemy) => keyOf(enemy.x, enemy.y)));
        const next: Enemy[] = [];
        let triggeredCombatId: number | null = null;

        for (const enemy of prev) {
          occupied.delete(keyOf(enemy.x, enemy.y));
          let moved = enemy;

          if (combatEnemyId !== enemy.id && Math.random() < 0.74) {
            const dirs = shuffleDirections();
            for (const dir of dirs) {
              const tx = enemy.x + dir.x;
              const ty = enemy.y + dir.y;
              const targetKey = keyOf(tx, ty);

              if (!isPassable(tx, ty)) {
                continue;
              }
              if (occupied.has(targetKey)) {
                continue;
              }

              moved = { ...enemy, x: tx, y: ty };
              break;
            }
          }

          if (moved.x === position.x && moved.y === position.y) {
            triggeredCombatId = moved.id;
            moved = enemy;
          }

          occupied.add(keyOf(moved.x, moved.y));
          next.push(moved);
        }

        if (triggeredCombatId !== null && combatEnemyId === null) {
          setCombatEnemyId(triggeredCombatId);
          appendLog(`적 ${triggeredCombatId}이(가) 접근해 교전 시작.`);
        }

        return next;
      });
    }, 700);

    return () => window.clearInterval(timer);
  }, [appendLog, combatEnemyId, position.x, position.y]);

  const equipItem = useCallback(
    (item: GearItem) => {
      if (item.type === "potion") {
        if (hp <= 0) {
          appendLog("사망 상태에서는 포션을 사용할 수 없습니다.");
          return;
        }
        if (hp >= totalStats.maxHp) {
          appendLog("HP가 가득 차 있어 포션을 아꼈습니다.");
          return;
        }

        setInventory((prev) => prev.filter((entry) => entry.id !== item.id));
        setHp((prev) => Math.min(totalStats.maxHp, prev + item.heal));
        appendLog(`${item.name} 사용. HP ${item.heal} 회복.`);
        return;
      }

      setInventory((prev) => prev.filter((entry) => entry.id !== item.id));

      if (item.type === "sword") {
        setSword((current) => {
          if (current) {
            setInventory((prev) => [current, ...prev]);
          }
          return item;
        });
      } else {
        setArmor((current) => {
          if (current) {
            setInventory((prev) => [current, ...prev]);
          }
          return item;
        });
      }

      appendLog(`${item.name} 장착.`);
    },
    [appendLog, hp, totalStats.maxHp],
  );

  const currentHp = Math.min(hp, totalStats.maxHp);
  const depth = Math.abs(position.x) + Math.abs(position.y);

  return (
    <div className={styles.panel}>
      <header className={styles.statsRow}>
        <span>HP {currentHp} / {totalStats.maxHp}</span>
        <span>힘 {totalStats.strength} (기본 {baseStats.strength})</span>
        <span>민첩 {totalStats.agility} (기본 {baseStats.agility})</span>
        <span>방어 {totalStats.armorDefense}</span>
        <span>공격 배율 x{totalStats.swordFactor.toFixed(2)}</span>
        <span>현재 거리 {depth}</span>
        <span>처치 {killCount}</span>
        <span>최고 거리 {bestDepth}</span>
        <span>최다 처치 {bestKills}</span>
      </header>

      <div className={styles.layout}>
        <section className={styles.canvasSection} aria-label="Roguelike map canvas">
          <div ref={mountRef} className={styles.canvasMount} />
        </section>

        <aside className={styles.side}>
          <div className={styles.box}>
            <p>현재 좌표: ({position.x}, {position.y})</p>
            <p>{combatEnemy ? `교전 중: 적 ${combatEnemy.id}` : "교전 없음"}</p>
            <p>{saveUpdatedAt ? `최근 세이브: ${new Date(saveUpdatedAt).toLocaleString()}` : "세이브 없음"}</p>
            <div className={styles.actions}>
              <button type="button" onClick={saveNow} className={styles.action}>세이브</button>
              <button type="button" onClick={loadFromSave} className={styles.action}>불러오기</button>
              <button type="button" onClick={resetGame} className={styles.action}>리셋</button>
            </div>
          </div>

          <div className={styles.box}>
            <p>이동</p>
            <div className={styles.controls}>
              <button type="button" onClick={() => tryMove(0, -1)} className={`${styles.control} ${styles.controlUp}`}>UP</button>
              <button type="button" onClick={() => tryMove(-1, 0)} className={`${styles.control} ${styles.controlLeft}`}>LEFT</button>
              <button type="button" onClick={() => tryMove(1, 0)} className={`${styles.control} ${styles.controlRight}`}>RIGHT</button>
              <button type="button" onClick={() => tryMove(0, 1)} className={`${styles.control} ${styles.controlDown}`}>DOWN</button>
            </div>
            <p className={styles.inlineHelp}>키보드: 방향키/WASD 이동, R 리셋</p>
          </div>

          <div className={styles.box}>
            <p>장비</p>
            <p>검: {sword ? `${sword.name} (x${sword.weaponFactor.toFixed(2)})` : "없음"}</p>
            <p>갑옷: {armor ? `${armor.name} (방어 ${armor.defense})` : "없음"}</p>
          </div>

          <div className={styles.box}>
            <p>인벤토리</p>
            <ul className={styles.inventory}>
              {inventory.slice(0, 8).map((item) => (
                <li key={item.id}>
                  <span>
                    {item.type === "potion"
                      ? `${item.name} [회복 ${item.heal}]`
                      : `${item.name} [+힘 ${item.strength} / +민첩 ${item.agility} / +HP ${item.maxHp}]`}
                  </span>
                  <button type="button" onClick={() => equipItem(item)} className={styles.equip}>
                    {item.type === "potion" ? "사용" : "장착"}
                  </button>
                </li>
              ))}
              {inventory.length === 0 && <li>아이템 없음</li>}
            </ul>
          </div>
        </aside>
      </div>

      <section className={styles.logBox}>
        <p>전투 로그</p>
        <ul>
          {battleLog.map((line, index) => (
            <li key={`${line}-${index}`}>{line}</li>
          ))}
          {battleLog.length === 0 && <li>로그 없음</li>}
        </ul>
      </section>

      <p className={styles.help}>이동 시 민첩 +1, 공격 시 힘 +1, 피격 시 최대 HP +1. 적 처치로 장비를 얻고 더 멀리 이동해 기록을 갱신하세요.</p>
    </div>
  );
}
