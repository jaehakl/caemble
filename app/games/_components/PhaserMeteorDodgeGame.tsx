"use client";

import { useEffect, useRef, useState } from "react";
import type Phaser from "phaser";
import { loadGameSave, saveGameSave } from "@/app/lib/save-protocol";
import styles from "./PhaserMeteorDodgeGame.module.css";

const GAME_SLUG = "phaser-meteor-dodge";
const GAME_TITLE = "Phaser Meteor Dodge";
const GAME_WIDTH = 560;
const GAME_HEIGHT = 640;
const START_LIVES = 3;

type PhaserRuntime = typeof Phaser;

type CreateGameOptions = {
  PhaserRef: PhaserRuntime;
  parent: HTMLDivElement;
  onScore: (value: number) => void;
  onLives: (value: number) => void;
  onGameOver: (scoreValue: number) => void;
};

function createMeteorDodgeGame({
  PhaserRef,
  parent,
  onScore,
  onLives,
  onGameOver,
}: CreateGameOptions): Phaser.Game {
  let currentScore = 0;
  let currentLives = START_LIVES;
  let spawnDelayMs = 780;
  let spawnTimerMs = 0;
  let invulnerableUntil = 0;
  let isRoundOver = false;

  let player: Phaser.GameObjects.Rectangle | null = null;
  let cursors: Phaser.Types.Input.Keyboard.CursorKeys | null = null;
  let keyA: Phaser.Input.Keyboard.Key | null = null;
  let keyD: Phaser.Input.Keyboard.Key | null = null;
  let statusText: Phaser.GameObjects.Text | null = null;

  const meteors: Array<{
    shape: Phaser.GameObjects.Ellipse;
    speed: number;
    spin: number;
  }> = [];

  const scene: Phaser.Types.Scenes.SceneType = {
    key: "MeteorDodgeScene",
    create(this: Phaser.Scene) {
      const centerX = GAME_WIDTH / 2;
      const baselineY = GAME_HEIGHT - 72;

      this.add.rectangle(centerX, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x0b1321, 1).setDepth(-4);
      this.add
        .rectangle(centerX, GAME_HEIGHT / 2, GAME_WIDTH - 24, GAME_HEIGHT - 24, 0x111827, 1)
        .setDepth(-3);
      this.add.rectangle(centerX, baselineY + 24, GAME_WIDTH - 18, 8, 0x334155, 1).setDepth(-2);

      player = this.add.rectangle(centerX, baselineY, 64, 22, 0x22d3ee, 1);

      for (let i = 0; i < 90; i += 1) {
        this.add
          .circle(
            PhaserRef.Math.Between(8, GAME_WIDTH - 8),
            PhaserRef.Math.Between(8, GAME_HEIGHT - 8),
            PhaserRef.Math.Between(1, 2),
            0x93c5fd,
            PhaserRef.Math.FloatBetween(0.2, 0.7),
          )
          .setDepth(-1);
      }

      statusText = this.add
        .text(16, 16, "Move: Arrow keys or A/D", {
          color: "#cbd5e1",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "14px",
        })
        .setDepth(5);

      if (!this.input.keyboard) {
        isRoundOver = true;
        onGameOver(0);
        statusText.setText("Keyboard input not available");
        return;
      }

      cursors = this.input.keyboard.createCursorKeys();
      keyA = this.input.keyboard.addKey(PhaserRef.Input.Keyboard.KeyCodes.A);
      keyD = this.input.keyboard.addKey(PhaserRef.Input.Keyboard.KeyCodes.D);
    },
    update(this: Phaser.Scene, time: number, delta: number) {
      if (isRoundOver || !player || !cursors || !keyA || !keyD) {
        return;
      }

      const moveSpeed = 400;
      const movingLeft = Boolean(cursors.left?.isDown || keyA.isDown);
      const movingRight = Boolean(cursors.right?.isDown || keyD.isDown);

      if (movingLeft && !movingRight) {
        player.x -= (moveSpeed * delta) / 1000;
      }
      if (!movingLeft && movingRight) {
        player.x += (moveSpeed * delta) / 1000;
      }

      player.x = PhaserRef.Math.Clamp(player.x, 38, GAME_WIDTH - 38);

      spawnTimerMs += delta;
      if (spawnTimerMs >= spawnDelayMs) {
        spawnTimerMs = 0;
        spawnDelayMs = Math.max(300, spawnDelayMs - 5);

        const radius = PhaserRef.Math.Between(10, 20);
        const meteor = this.add.ellipse(
          PhaserRef.Math.Between(14, GAME_WIDTH - 14),
          -20,
          radius * 2,
          radius * 2,
          0xf97316,
          1,
        );

        meteor.setStrokeStyle(2, 0x7c2d12, 0.95);

        meteors.push({
          shape: meteor,
          speed: PhaserRef.Math.Between(180, 340),
          spin: PhaserRef.Math.Between(-160, 160),
        });
      }

      const playerRect = player.getBounds();

      for (let i = meteors.length - 1; i >= 0; i -= 1) {
        const meteor = meteors[i];
        meteor.shape.y += (meteor.speed * delta) / 1000;
        meteor.shape.angle += (meteor.spin * delta) / 1000;

        if (meteor.shape.y > GAME_HEIGHT + 30) {
          meteor.shape.destroy();
          meteors.splice(i, 1);
          continue;
        }

        if (time < invulnerableUntil) {
          continue;
        }

        const meteorRect = meteor.shape.getBounds();
        if (PhaserRef.Geom.Intersects.RectangleToRectangle(playerRect, meteorRect)) {
          meteor.shape.destroy();
          meteors.splice(i, 1);
          currentLives -= 1;
          invulnerableUntil = time + 780;
          player.fillColor = 0xfda4af;

          this.time.delayedCall(130, () => {
            if (player) {
              player.fillColor = 0x22d3ee;
            }
          });

          onLives(currentLives);

          if (currentLives <= 0) {
            isRoundOver = true;
            onGameOver(currentScore);
            if (statusText) {
              statusText.setText("Game over - press Restart");
            }
            for (const row of meteors) {
              row.shape.destroy();
            }
            meteors.length = 0;
            return;
          }
        }
      }

      currentScore += delta / 1000;
      onScore(Math.floor(currentScore));
    },
  };

  const config: Phaser.Types.Core.GameConfig = {
    type: PhaserRef.AUTO,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    parent,
    backgroundColor: "#0f172a",
    scene,
    scale: {
      mode: PhaserRef.Scale.FIT,
      autoCenter: PhaserRef.Scale.CENTER_BOTH,
    },
  };

  return new PhaserRef.Game(config);
}

export function PhaserMeteorDodgeGame() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [runId, setRunId] = useState(0);
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(START_LIVES);
  const [gameOver, setGameOver] = useState(false);
  const [bestScore, setBestScore] = useState(() => {
    if (typeof window === "undefined") {
      return 0;
    }
    const saved = loadGameSave<{ bestScore?: number }>(GAME_SLUG);
    if (saved?.data && typeof saved.data.bestScore === "number") {
      return saved.data.bestScore;
    }
    return 0;
  });

  useEffect(() => {
    saveGameSave(GAME_SLUG, GAME_TITLE, { bestScore });
  }, [bestScore]);

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

      setScore(0);
      setLives(START_LIVES);
      setGameOver(false);
      phaserGame = createMeteorDodgeGame({
        PhaserRef,
        parent: mountRef.current,
        onScore: (next) => {
          setScore((prev) => (prev === next ? prev : next));
        },
        onLives: setLives,
        onGameOver: (scoreValue) => {
          setGameOver(true);
          setBestScore((prev) => Math.max(prev, Math.floor(scoreValue)));
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

  const statusLabel = gameOver ? "Game Over" : "Running";

  return (
    <div className={styles.panel}>
      <header className={styles.stats}>
        <span>Status: {statusLabel}</span>
        <span>Lives: {lives}</span>
        <span>Score: {score}</span>
        <span>Best: {bestScore}</span>
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
          {gameOver ? "Restart" : "Reset"}
        </button>
        <p className={styles.help}>
          Dodge meteors by moving left and right. Survive longer to increase your score.
        </p>
      </div>
    </div>
  );
}
