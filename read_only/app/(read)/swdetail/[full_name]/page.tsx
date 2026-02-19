"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { swDetail } from "../../../api";
import styles from "./page.module.css";

type SoftwareDetailItem = {
  full_name: string;
  name: string | null;
  html_url: string;
  abstract: string;
  description: string | null;
  language: string | null;
  source_updated_at: string;
  repository: string;
  citations: number;
  license: string | null;
  created_at: string;
  updated_at: string;
  topics: string[];
};

type SimilarSoftwareItem = {
  full_name: string;
  name: string | null;
  html_url: string;
  abstract: string;
  description: string | null;
  language: string | null;
  source_updated_at: string;
  repository: string;
  citations: number;
  license: string | null;
  created_at: string;
  updated_at: string;
  topics: string[];
  similarity_score: number;
};

type SoftwareDetailResponse = {
  software: SoftwareDetailItem;
  similar_softwares: SimilarSoftwareItem[];
};

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toISOString().replace("T", " ").slice(0, 19);
}

export default function SoftwareDetailPage() {
  const params = useParams<{ full_name: string }>();
  const routeFullName = Array.isArray(params.full_name) ? params.full_name[0] : params.full_name;

  const decodedFullName = useMemo(() => {
    if (!routeFullName) {
      return "";
    }
    try {
      return decodeURIComponent(routeFullName);
    } catch {
      return routeFullName;
    }
  }, [routeFullName]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<SoftwareDetailItem | null>(null);
  const [similar, setSimilar] = useState<SimilarSoftwareItem[]>([]);

  useEffect(() => {
    if (!decodedFullName) {
      return;
    }
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await swDetail(decodedFullName);
        const data = response?.data as SoftwareDetailResponse | undefined;
        if (!data?.software) {
          throw new Error("상세 데이터가 없습니다.");
        }
        setDetail(data.software);
        setSimilar(Array.isArray(data.similar_softwares) ? data.similar_softwares.slice(0, 6) : []);
      } catch (e) {
        const message = e instanceof Error ? e.message : "상세 조회에 실패했습니다.";
        setError(message);
      } finally {
        setLoading(false);
      }
    };

    void run();
  }, [decodedFullName]);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>Software Detail</h1>
        <p className={styles.links}>
          <Link href="/">Home</Link>
          <Link href="/">Softwares</Link>
        </p>
      </header>

      {loading && <p>Loading...</p>}
      {error && <p className={styles.error}>{error}</p>}

      {!loading && !error && detail && (
        <>
          <section className={styles.section}>
            <h2>{detail.name || detail.full_name}</h2>
            <p className={styles.fullName}>{detail.full_name}</p>

            <div className={styles.topicWrap}>
              {(detail.topics ?? []).length === 0 ? (
                <span className={styles.topicEmpty}>No topics</span>
              ) : (
                detail.topics.map((topic) => (
                  <span key={topic} className={styles.topicChip}>
                    {topic}
                  </span>
                ))
              )}
            </div>

            <dl className={styles.metaGrid}>
              <dt>html_url</dt>
              <dd>
                <a href={detail.html_url} target="_blank" rel="noreferrer">
                  {detail.html_url}
                </a>
              </dd>

              <dt>language</dt>
              <dd>{detail.language || "-"}</dd>

              <dt>repository</dt>
              <dd>{detail.repository || "-"}</dd>

              <dt>citations</dt>
              <dd>{detail.citations}</dd>

              <dt>license</dt>
              <dd>{detail.license || "-"}</dd>

              <dt>Last Updated</dt>
              <dd>{formatDate(detail.source_updated_at)}</dd>

            </dl>

            <div className={styles.textBlock}>
              <h3>Abstract</h3>
              <p>{detail.abstract || "-"}</p>
            </div>
            <div className={styles.textBlock}>
              <h3>Description</h3>
              <p>{detail.description || "-"}</p>
            </div>
          </section>

          <section className={styles.section}>
            <h2>Similar Softwares (Embedding)</h2>
            {similar.length === 0 ? (
              <p>유사 소프트웨어를 찾지 못했습니다.</p>
            ) : (
              <div className={styles.cardGrid}>
                {similar.map((item) => (
                  <article key={item.full_name} className={styles.card}>
                    <h3>
                      <Link href={`/swdetail/${encodeURIComponent(item.full_name)}`}>
                        {item.name || item.full_name}
                      </Link>
                    </h3>
                    <p className={styles.cardFullName}>{item.full_name}</p>
                    <p className={styles.similarity}>
                      similarity: {item.similarity_score.toFixed(4)}
                    </p>
                    <p className={styles.cardText}>{item.abstract || "-"}</p>
                    <p className={styles.cardMeta}>
                      {item.language || "-"} | {item.repository || "-"} | citations {item.citations}
                    </p>
                    <div className={styles.topicWrap}>
                      {(item.topics ?? []).map((topic) => (
                        <span key={`${item.full_name}-${topic}`} className={styles.topicChip}>
                          {topic}
                        </span>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
