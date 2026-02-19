"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { allTags, gameCatalog } from "./games/data";
import styles from "./page.module.css";

export default function HomePage() {
  const [query, setQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<string>("all");

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();

    return gameCatalog.filter((game) => {
      const passTag = selectedTag === "all" || game.tags.includes(selectedTag);
      const haystack = `${game.title} ${game.summary} ${game.tags.join(" ")}`.toLowerCase();
      const passQuery = keyword.length === 0 || haystack.includes(keyword);
      return passTag && passQuery;
    });
  }, [query, selectedTag]);

  return (
    <main className={styles.pageShell}>
      <section className={styles.hero}>
        <h1>Nemonori Arcade</h1>
        <div className={styles.heroActions}>
          <Link href="/saves" className={styles.manageSavesLink}>
            세이브 데이터 관리
          </Link>
        </div>
      </section>

      <section className={styles.controls}>
        <input
          aria-label="게임 검색"
          className={styles.search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="게임 이름, 태그, 설명으로 검색"
        />
        <div className={styles.tags}>
          <button
            type="button"
            onClick={() => setSelectedTag("all")}
            className={selectedTag === "all" ? styles.tagActive : styles.tag}
          >
            전체
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => setSelectedTag(tag)}
              className={selectedTag === tag ? styles.tagActive : styles.tag}
            >
              #{tag}
            </button>
          ))}
        </div>
      </section>

      <section className={styles.grid}>
        {filtered.map((game) => (
          <article key={game.slug} className={styles.card}>
            <div className={styles.cardTop}>
              <span
                className={styles.accent}
                style={{ backgroundColor: game.accent }}
                aria-hidden="true"
              />
              <h2>{game.title}</h2>
            </div>
            <p>{game.summary}</p>
            <div className={styles.meta}>
              <span>{game.difficulty}</span>
              <span>{game.estPlayMinutes}분</span>
            </div>
            <div className={styles.tagsInline}>
              {game.tags.map((tag) => (
                <span key={tag}>#{tag}</span>
              ))}
            </div>
            <Link href={`/games/${game.slug}`} className={styles.playLink}>
              플레이
            </Link>
          </article>
        ))}
      </section>
    </main>
  );
}
