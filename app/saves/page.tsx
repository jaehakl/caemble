"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  clearAllGameSaves,
  deleteGameSave,
  getAllGameSaves,
  type GameSaveSummary,
} from "../lib/save-protocol";
import styles from "./page.module.css";

function formatTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "알 수 없음";
  }
  return date.toLocaleString("ko-KR");
}

export default function SavesPage() {
  const [saves, setSaves] = useState<GameSaveSummary[]>(() => getAllGameSaves());

  const totalBytes = useMemo(() => saves.reduce((sum, row) => sum + row.byteSize, 0), [saves]);

  const refresh = () => {
    setSaves(getAllGameSaves());
  };

  const handleDelete = (slug: string) => {
    deleteGameSave(slug);
    refresh();
  };

  const handleClearAll = () => {
    clearAllGameSaves();
    refresh();
  };

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <Link href="/" className={styles.backLink}>
          {"<- "}메인으로
        </Link>
        <h1>세이브 데이터 관리</h1>
        <p>
          프로토콜: <code>nemonori.save.v1</code>
        </p>
      </header>

      <section className={styles.toolbar}>
        <span>총 {saves.length}개</span>
        <span>{totalBytes} bytes</span>
        <button type="button" onClick={refresh} className={styles.secondaryButton}>
          새로고침
        </button>
        <button type="button" onClick={handleClearAll} className={styles.dangerButton}>
          전체 삭제
        </button>
      </section>

      {saves.length === 0 ? (
        <section className={styles.empty}>저장된 게임 데이터가 없습니다.</section>
      ) : (
        <section className={styles.list}>
          {saves.map((save) => (
            <article key={save.storageKey} className={styles.card}>
              <div className={styles.cardHead}>
                <div>
                  <h2>{save.gameTitle}</h2>
                  <p>{save.gameSlug}</p>
                </div>
                <Link href={`/games/${save.gameSlug}`} className={styles.playLink}>
                  게임 열기
                </Link>
              </div>

              <div className={styles.meta}>
                <span>저장 시각: {formatTime(save.updatedAt)}</span>
                <span>크기: {save.byteSize} bytes</span>
              </div>

              <details className={styles.details}>
                <summary>Raw 데이터 보기</summary>
                <pre>{JSON.stringify(save.data, null, 2)}</pre>
              </details>

              <button
                type="button"
                onClick={() => handleDelete(save.gameSlug)}
                className={styles.deleteButton}
              >
                이 세이브 삭제
              </button>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
