"use client";

import { useEffect, useState } from "react";
import { loadGameSave, saveGameSave } from "@/app/lib/save-protocol";
import styles from "./MemoryLightsGame.module.css";

const TILES = ["A", "B", "C", "D"];
const GAME_SLUG = "memory-lights";
const GAME_TITLE = "Memory Lights";

function randomTileIndex() {
  return Math.floor(Math.random() * TILES.length);
}

function delay(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function MemoryLightsGame() {
  const [status, setStatus] = useState<"idle" | "running" | "fail">("idle");
  const [sequence, setSequence] = useState<number[]>([]);
  const [inputIndex, setInputIndex] = useState(0);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [locked, setLocked] = useState(false);
  const [round, setRound] = useState(0);
  const [bestRound, setBestRound] = useState(() => {
    if (typeof window === "undefined") {
      return 0;
    }
    const saved = loadGameSave<{ bestRound?: number }>(GAME_SLUG);
    if (saved?.data && typeof saved.data.bestRound === "number") {
      return saved.data.bestRound;
    }
    return 0;
  });

  useEffect(() => {
    if (status !== "running" || sequence.length === 0) {
      return;
    }

    let cancelled = false;

    const playSequence = async () => {
      setLocked(true);
      await delay(260);

      for (const tile of sequence) {
        if (cancelled) {
          return;
        }

        setActiveIndex(tile);
        await delay(330);
        setActiveIndex(null);
        await delay(130);
      }

      if (!cancelled) {
        setInputIndex(0);
        setLocked(false);
      }
    };

    void playSequence();

    return () => {
      cancelled = true;
    };
  }, [sequence, status]);

  useEffect(() => {
    saveGameSave(GAME_SLUG, GAME_TITLE, { bestRound });
  }, [bestRound]);

  const start = () => {
    setStatus("running");
    setRound(1);
    setInputIndex(0);
    setLocked(true);
    setSequence([randomTileIndex()]);
  };

  const handleTilePress = (index: number) => {
    if (status !== "running" || locked) {
      return;
    }

    setActiveIndex(index);
    window.setTimeout(() => {
      setActiveIndex((current) => (current === index ? null : current));
    }, 120);

    if (index !== sequence[inputIndex]) {
      setStatus("fail");
      setLocked(true);
      setBestRound((prev) => Math.max(prev, round));
      return;
    }

    if (inputIndex === sequence.length - 1) {
      setLocked(true);
      setRound((prev) => prev + 1);
      window.setTimeout(() => {
        setInputIndex(0);
        setSequence((prev) => [...prev, randomTileIndex()]);
      }, 420);
      return;
    }

    setInputIndex((prev) => prev + 1);
  };

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <span>라운드: {round}</span>
        <span>최고 라운드: {bestRound}</span>
        <span>{locked ? "순서 재생중" : "입력 가능"}</span>
      </header>

      <div className={styles.grid}>
        {TILES.map((tile, index) => (
          <button
            key={tile}
            type="button"
            onClick={() => handleTilePress(index)}
            className={`${styles.tile} ${activeIndex === index ? styles.active : ""}`}
            aria-label={`${tile} 버튼`}
          >
            {tile}
          </button>
        ))}
      </div>

      <div className={styles.footer}>
        {status === "idle" && (
          <button type="button" onClick={start} className={styles.control}>
            시작
          </button>
        )}
        {status === "running" && (
          <button
            type="button"
            onClick={() => {
              setStatus("idle");
              setSequence([]);
              setLocked(false);
              setRound(0);
              setInputIndex(0);
            }}
            className={styles.control}
          >
            종료
          </button>
        )}
        {status === "fail" && (
          <button type="button" onClick={start} className={styles.control}>
            실패 - 다시 시작
          </button>
        )}
      </div>
    </div>
  );
}

