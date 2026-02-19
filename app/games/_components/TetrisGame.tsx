"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { loadGameSave, saveGameSave } from "@/app/lib/save-protocol";
import styles from "./TetrisGame.module.css";

const BOARD_WIDTH = 10;
const BOARD_HEIGHT = 20;
const GAME_SLUG = "tetris";
const GAME_TITLE = "Pixel Tetris";

type PieceType = "I" | "O" | "T" | "S" | "Z" | "J" | "L";
type BoardCell = PieceType | null;
type Board = BoardCell[][];
type Matrix = number[][];

type ActivePiece = {
  type: PieceType;
  matrix: Matrix;
  x: number;
  y: number;
};

type BestSaveData = {
  bestScore?: number;
  bestLines?: number;
};

const PIECES: Record<PieceType, Matrix> = {
  I: [[1, 1, 1, 1]],
  O: [
    [1, 1],
    [1, 1],
  ],
  T: [
    [0, 1, 0],
    [1, 1, 1],
  ],
  S: [
    [0, 1, 1],
    [1, 1, 0],
  ],
  Z: [
    [1, 1, 0],
    [0, 1, 1],
  ],
  J: [
    [1, 0, 0],
    [1, 1, 1],
  ],
  L: [
    [0, 0, 1],
    [1, 1, 1],
  ],
};

const PIECE_TYPES = Object.keys(PIECES) as PieceType[];
const SCORE_TABLE = [0, 100, 300, 500, 800];

function createEmptyBoard(): Board {
  return Array.from({ length: BOARD_HEIGHT }, () => Array.from({ length: BOARD_WIDTH }, () => null));
}

function rotateMatrixClockwise(matrix: Matrix): Matrix {
  return matrix[0].map((_, index) => matrix.map((row) => row[index]).reverse());
}

function randomPieceType(): PieceType {
  return PIECE_TYPES[Math.floor(Math.random() * PIECE_TYPES.length)];
}

function spawnPiece(type: PieceType): ActivePiece {
  const matrix = PIECES[type];
  const x = Math.floor((BOARD_WIDTH - matrix[0].length) / 2);
  return { type, matrix, x, y: 0 };
}

function collides(board: Board, piece: ActivePiece, offsetX = 0, offsetY = 0, matrix?: Matrix) {
  const current = matrix ?? piece.matrix;

  for (let row = 0; row < current.length; row += 1) {
    for (let col = 0; col < current[row].length; col += 1) {
      if (current[row][col] === 0) {
        continue;
      }

      const nextX = piece.x + col + offsetX;
      const nextY = piece.y + row + offsetY;

      if (nextX < 0 || nextX >= BOARD_WIDTH || nextY >= BOARD_HEIGHT) {
        return true;
      }

      if (nextY >= 0 && board[nextY][nextX] !== null) {
        return true;
      }
    }
  }

  return false;
}

function mergePiece(board: Board, piece: ActivePiece): Board {
  const merged = board.map((row) => [...row]);

  for (let row = 0; row < piece.matrix.length; row += 1) {
    for (let col = 0; col < piece.matrix[row].length; col += 1) {
      if (piece.matrix[row][col] === 0) {
        continue;
      }

      const x = piece.x + col;
      const y = piece.y + row;

      if (y >= 0 && y < BOARD_HEIGHT && x >= 0 && x < BOARD_WIDTH) {
        merged[y][x] = piece.type;
      }
    }
  }

  return merged;
}

function clearFilledLines(board: Board) {
  const nextRows = board.filter((row) => row.some((cell) => cell === null));
  const cleared = BOARD_HEIGHT - nextRows.length;
  const padding = Array.from({ length: cleared }, () =>
    Array.from({ length: BOARD_WIDTH }, () => null as BoardCell),
  );

  return {
    board: [...padding, ...nextRows],
    cleared,
  };
}

function getDropIntervalMs(level: number) {
  return Math.max(110, 780 - level * 55);
}

export function TetrisGame() {
  const [board, setBoard] = useState<Board>(() => createEmptyBoard());
  const [active, setActive] = useState<ActivePiece>(() => spawnPiece(randomPieceType()));
  const [nextPieceType, setNextPieceType] = useState<PieceType>(() => randomPieceType());
  const [started, setStarted] = useState(false);
  const [running, setRunning] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [score, setScore] = useState(0);
  const [lines, setLines] = useState(0);
  const [level, setLevel] = useState(0);
  const [best, setBest] = useState(() => {
    if (typeof window === "undefined") {
      return { score: 0, lines: 0 };
    }

    const saved = loadGameSave<BestSaveData>(GAME_SLUG);
    return {
      score: typeof saved?.data?.bestScore === "number" ? saved.data.bestScore : 0,
      lines: typeof saved?.data?.bestLines === "number" ? saved.data.bestLines : 0,
    };
  });

  useEffect(() => {
    saveGameSave(GAME_SLUG, GAME_TITLE, { bestScore: best.score, bestLines: best.lines });
  }, [best.lines, best.score]);

  const finalizeAndSpawn = useCallback(
    (lockedPiece: ActivePiece) => {
      const merged = mergePiece(board, lockedPiece);
      const { board: clearedBoard, cleared } = clearFilledLines(merged);
      const gained = SCORE_TABLE[cleared] * (level + 1);
      const nextLines = lines + cleared;
      const nextScore = score + gained;
      const nextLevel = Math.floor(nextLines / 10);

      setBoard(clearedBoard);
      setLines(nextLines);
      setScore(nextScore);
      setLevel(nextLevel);

      const spawning = spawnPiece(nextPieceType);
      const newNext = randomPieceType();

      if (collides(clearedBoard, spawning)) {
        setRunning(false);
        setGameOver(true);
        setBest((prev) => ({
          score: Math.max(prev.score, nextScore),
          lines: Math.max(prev.lines, nextLines),
        }));
        return;
      }

      setActive(spawning);
      setNextPieceType(newNext);
    },
    [board, level, lines, nextPieceType, score],
  );

  const stepDown = useCallback(() => {
    if (!running || gameOver) {
      return;
    }

    if (collides(board, active, 0, 1)) {
      finalizeAndSpawn(active);
      return;
    }

    setActive((prev) => ({ ...prev, y: prev.y + 1 }));
  }, [active, board, finalizeAndSpawn, gameOver, running]);

  const moveHorizontally = useCallback(
    (delta: number) => {
      if (!running || gameOver) {
        return;
      }
      if (collides(board, active, delta, 0)) {
        return;
      }
      setActive((prev) => ({ ...prev, x: prev.x + delta }));
    },
    [active, board, gameOver, running],
  );

  const rotate = useCallback(() => {
    if (!running || gameOver) {
      return;
    }

    const rotated = rotateMatrixClockwise(active.matrix);
    const kicks = [0, -1, 1, -2, 2];

    for (const kick of kicks) {
      if (!collides(board, active, kick, 0, rotated)) {
        setActive((prev) => ({
          ...prev,
          x: prev.x + kick,
          matrix: rotated,
        }));
        return;
      }
    }
  }, [active, board, gameOver, running]);

  const hardDrop = useCallback(() => {
    if (!running || gameOver) {
      return;
    }

    let distance = 0;
    while (!collides(board, active, 0, distance + 1)) {
      distance += 1;
    }

    const dropped = { ...active, y: active.y + distance };
    setActive(dropped);
    finalizeAndSpawn(dropped);
  }, [active, board, finalizeAndSpawn, gameOver, running]);

  const restart = useCallback(() => {
    const first = randomPieceType();
    const second = randomPieceType();

    setBoard(createEmptyBoard());
    setActive(spawnPiece(first));
    setNextPieceType(second);
    setScore(0);
    setLines(0);
    setLevel(0);
    setGameOver(false);
    setStarted(true);
    setRunning(true);
  }, []);

  useEffect(() => {
    if (!started || !running || gameOver) {
      return;
    }

    const timer = window.setInterval(() => {
      stepDown();
    }, getDropIntervalMs(level));

    return () => window.clearInterval(timer);
  }, [gameOver, level, running, started, stepDown]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!started) {
        return;
      }

      if (["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", " "].includes(event.key)) {
        event.preventDefault();
      }

      if (event.key === "ArrowLeft") {
        moveHorizontally(-1);
      } else if (event.key === "ArrowRight") {
        moveHorizontally(1);
      } else if (event.key === "ArrowDown") {
        stepDown();
      } else if (event.key === "ArrowUp") {
        rotate();
      } else if (event.key === " ") {
        hardDrop();
      } else if (event.key.toLowerCase() === "p" && !gameOver) {
        setRunning((prev) => !prev);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [gameOver, hardDrop, moveHorizontally, rotate, started, stepDown]);

  const displayBoard = useMemo(() => {
    const overlay = board.map((row) => [...row]);

    for (let row = 0; row < active.matrix.length; row += 1) {
      for (let col = 0; col < active.matrix[row].length; col += 1) {
        if (active.matrix[row][col] === 0) {
          continue;
        }
        const x = active.x + col;
        const y = active.y + row;
        if (x >= 0 && x < BOARD_WIDTH && y >= 0 && y < BOARD_HEIGHT) {
          overlay[y][x] = active.type;
        }
      }
    }

    return overlay;
  }, [active, board]);

  const nextMatrix = PIECES[nextPieceType];
  const pieceClassName: Record<PieceType, string> = {
    I: styles.i,
    O: styles.o,
    T: styles.t,
    S: styles.s,
    Z: styles.z,
    J: styles.j,
    L: styles.l,
  };

  return (
    <div className={styles.panel}>
      <header className={styles.stats}>
        <span>Score {score}</span>
        <span>Lines {lines}</span>
        <span>Level {level}</span>
        <span>Best Score {best.score}</span>
      </header>

      <div className={styles.main}>
        <section className={styles.board} aria-label="Tetris board">
          {displayBoard.map((row, y) =>
            row.map((cell, x) => (
              <div
                key={`${y}-${x}`}
                className={`${styles.cell} ${cell ? `${styles.filled} ${pieceClassName[cell]}` : ""}`}
              />
            )),
          )}
        </section>

        <aside className={styles.side}>
          <div className={styles.nextBox}>
            <p>Next Piece</p>
            <div className={styles.previewGrid}>
              {Array.from({ length: 16 }).map((_, index) => {
                const py = Math.floor(index / 4);
                const px = index % 4;
                const hasCell = nextMatrix[py]?.[px] === 1;
                return (
                  <div
                    key={`next-${index}`}
                    className={`${styles.previewCell} ${hasCell ? pieceClassName[nextPieceType] : ""}`}
                  />
                );
              })}
            </div>
          </div>

          <div className={styles.statusBox}>
            {!started && <p>Press Start to play.</p>}
            {started && !gameOver && <p>{running ? "Running" : "Paused"}</p>}
            {gameOver && <p>Game Over. Best Lines {best.lines}</p>}
          </div>

          <div className={styles.actions}>
            <button type="button" onClick={restart} className={styles.action}>
              {started ? "Restart" : "Start"}
            </button>
            <button
              type="button"
              onClick={() => setRunning((prev) => !prev)}
              disabled={!started || gameOver}
              className={styles.action}
            >
              {running ? "Pause" : "Resume"}
            </button>
          </div>
        </aside>
      </div>

      <div className={styles.mobileControls}>
        <button type="button" onClick={() => moveHorizontally(-1)} className={styles.control}>
          LEFT
        </button>
        <button type="button" onClick={rotate} className={styles.control}>
          ROT
        </button>
        <button type="button" onClick={stepDown} className={styles.control}>
          DOWN
        </button>
        <button type="button" onClick={() => moveHorizontally(1)} className={styles.control}>
          RIGHT
        </button>
        <button type="button" onClick={hardDrop} className={styles.control}>
          DROP
        </button>
      </div>

      <p className={styles.help}>Keys: Left/Right move, Up rotate, Down drop, Space hard drop, P pause</p>
    </div>
  );
}
