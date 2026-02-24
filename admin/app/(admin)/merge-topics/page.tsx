"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { deleteTopic, getTopics, mergeTopics } from "../../api";
import styles from "./page.module.css";

type TopicItem = {
  id: number;
  topic: string;
  alternative_topics: string[];
  software_count: number;
};

type MergeResult = {
  kept_topic_id: number;
  removed_topic_id: number;
  kept_topic: string;
  alternative_topics: string[];
  links_moved: number;
  links_deduped: number;
};

type TopicDeleteResult = {
  deleted_topic_id: number;
  deleted_topic: string;
  deleted_links: number;
};

const PAGE_SIZE = 200;

export default function MergeTopicsPage() {
  const [topics, setTopics] = useState<TopicItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragSourceId, setDragSourceId] = useState<number | null>(null);
  const [hoverTargetId, setHoverTargetId] = useState<number | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState<number | null>(null);

  const [sourceId, setSourceId] = useState<number | null>(null);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [keepTopicId, setKeepTopicId] = useState<number | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [result, setResult] = useState<MergeResult | null>(null);
  const [deleteMessage, setDeleteMessage] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  const loadTopics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await getTopics();
      const data = response?.data as TopicItem[] | undefined;
      setTopics(Array.isArray(data) ? data : []);
    } catch (e) {
      const message = e instanceof Error ? e.message : "토픽 목록 조회에 실패했습니다.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTopics();
  }, [loadTopics]);

  const sourceTopic = useMemo(
    () => topics.find((item) => item.id === sourceId) ?? null,
    [topics, sourceId]
  );
  const targetTopic = useMemo(
    () => topics.find((item) => item.id === targetId) ?? null,
    [topics, targetId]
  );
  const dragSourceTopic = useMemo(
    () => topics.find((item) => item.id === dragSourceId) ?? null,
    [topics, dragSourceId]
  );
  const selectedTopic = useMemo(
    () => topics.find((item) => item.id === selectedTopicId) ?? null,
    [topics, selectedTopicId]
  );
  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(topics.length / PAGE_SIZE)),
    [topics.length]
  );
  const pagedTopics = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return topics.slice(start, start + PAGE_SIZE);
  }, [currentPage, topics]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const onDropToTarget = (dropTargetId: number) => {
    if (dragSourceId === null || dragSourceId === dropTargetId) {
      return;
    }
    setSourceId(dragSourceId);
    setTargetId(dropTargetId);
    setKeepTopicId(dropTargetId);
    setResult(null);
    setDeleteMessage(null);
    setError(null);
    setHoverTargetId(null);
    setSelectedTopicId(null);
    setIsEditorOpen(true);
  };

  const onClickTopicCard = (clickedTopicId: number) => {
    if (isEditorOpen) {
      return;
    }

    if (selectedTopicId === clickedTopicId) {
      setSelectedTopicId(null);
      return;
    }

    if (selectedTopicId === null) {
      setSelectedTopicId(clickedTopicId);
      setDeleteMessage(null);
      setError(null);
      return;
    }

    setSourceId(selectedTopicId);
    setTargetId(clickedTopicId);
    setKeepTopicId(clickedTopicId);
    setResult(null);
    setDeleteMessage(null);
    setError(null);
    setSelectedTopicId(null);
    setIsEditorOpen(true);
  };

  const handleEditorCancel = () => {
    setSourceId(null);
    setTargetId(null);
    setKeepTopicId(null);
    setSelectedTopicId(null);
    setError(null);
    setIsEditorOpen(false);
  };

  const getMergedPreview = (source: TopicItem, target: TopicItem) => {
    const mergedAlternativeTopics = Array.from(
      new Set([...target.alternative_topics, source.topic, ...source.alternative_topics])
    );

    return {
      title: target.topic,
      softwareCount: target.software_count + source.software_count,
      alternativeTopics: mergedAlternativeTopics,
    };
  };

  const canSave = sourceId !== null && targetId !== null && keepTopicId !== null && !saving;

  const handleMergeSave = async () => {
    if (!canSave || sourceId === null || targetId === null || keepTopicId === null) {
      return;
    }

    setSaving(true);
    setError(null);
    setResult(null);
    setDeleteMessage(null);

    try {
      const response = await mergeTopics({
        source_topic_id: sourceId,
        target_topic_id: targetId,
        keep_topic_id: keepTopicId,
      });
      const data = response?.data as MergeResult | undefined;
      if (!data) {
        throw new Error("빈 응답이 반환되었습니다.");
      }
      setResult(data);
      setSourceId(null);
      setTargetId(null);
      setKeepTopicId(null);
      setSelectedTopicId(null);
      setIsEditorOpen(false);
      await loadTopics();
    } catch (e) {
      const message = e instanceof Error ? e.message : "토픽 병합에 실패했습니다.";
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteTopic = useCallback(async (topic: TopicItem) => {
    if (deleting || saving || isEditorOpen) {
      return;
    }

    const confirmed = window.confirm(
      `"${topic.topic}" topic을 삭제할까요?\n연결된 software-topic 링크도 함께 삭제됩니다.`
    );
    if (!confirmed) {
      return;
    }

    setDeleting(true);
    setError(null);
    setResult(null);
    setDeleteMessage(null);

    try {
      const response = await deleteTopic(topic.id);
      const data = response?.data as TopicDeleteResult | undefined;
      if (!data) {
        throw new Error("빈 응답이 반환되었습니다.");
      }

      setDeleteMessage(
        `deleted: topic_id=${data.deleted_topic_id}, topic=${data.deleted_topic}, links=${data.deleted_links}`
      );
      setSelectedTopicId(null);
      if (
        sourceId === data.deleted_topic_id ||
        targetId === data.deleted_topic_id ||
        keepTopicId === data.deleted_topic_id
      ) {
        setSourceId(null);
        setTargetId(null);
        setKeepTopicId(null);
        setIsEditorOpen(false);
      }
      await loadTopics();
    } catch (e) {
      const message = e instanceof Error ? e.message : "토픽 삭제에 실패했습니다.";
      setError(message);
    } finally {
      setDeleting(false);
    }
  }, [deleting, isEditorOpen, keepTopicId, loadTopics, saving, sourceId, targetId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.key !== "Delete" && event.key !== "Del") || selectedTopicId === null) {
        return;
      }
      if (isEditorOpen || saving || deleting) {
        return;
      }

      const targetElement = event.target as HTMLElement | null;
      const tagName = targetElement?.tagName ?? "";
      const isFormField =
        tagName === "INPUT" ||
        tagName === "TEXTAREA" ||
        tagName === "SELECT" ||
        targetElement?.isContentEditable;
      if (isFormField) {
        return;
      }

      const selectedTopic = topics.find((item) => item.id === selectedTopicId);
      if (!selectedTopic) {
        return;
      }

      event.preventDefault();
      void handleDeleteTopic(selectedTopic);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleting, handleDeleteTopic, isEditorOpen, saving, selectedTopicId, topics]);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>Topic Merge</h1>
        <p>한 topic 카드를 다른 topic 카드로 드래그하면 병합 후보가 설정됩니다.</p>
      </header>

      <section className={styles.panel}>
        {result && (
          <p className={styles.success}>
            merged: kept_topic_id={result.kept_topic_id}, removed_topic_id={result.removed_topic_id}, links_moved={result.links_moved}, links_deduped={result.links_deduped}
          </p>
        )}
        {deleteMessage && <p className={styles.success}>{deleteMessage}</p>}
        {error && !isEditorOpen && <p className={styles.error}>{error}</p>}
      </section>

      <section className={styles.panel}>
        <div className={styles.listHeader}>
          <h2>Topics</h2>
          <button type="button" onClick={() => void loadTopics()} disabled={loading}>
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
        <p className={styles.helperText}>
          클릭: 카드 1개 선택 후 다른 카드 클릭으로 merge 모달을 엽니다. 선택 후 Del 키를 누르면 삭제 확인창이 열립니다.
        </p>
        <div className={styles.paginationRow}>
          <div className={styles.paginationInfo}>
            Page {currentPage}/{totalPages} · Showing {pagedTopics.length} of {topics.length}
            {selectedTopic ? ` · Selected: ${selectedTopic.topic} (id=${selectedTopic.id})` : ""}
          </div>
          <div className={styles.paginationControls}>
            <button
              type="button"
              className={styles.ghostButton}
              onClick={() => setCurrentPage(1)}
              disabled={currentPage === 1}
            >
              First
            </button>
            <button
              type="button"
              className={styles.ghostButton}
              onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
              disabled={currentPage === 1}
            >
              Prev
            </button>
            <button
              type="button"
              className={styles.ghostButton}
              onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
              disabled={currentPage === totalPages}
            >
              Next
            </button>
            <button
              type="button"
              className={styles.ghostButton}
              onClick={() => setCurrentPage(totalPages)}
              disabled={currentPage === totalPages}
            >
              Last
            </button>
          </div>
        </div>

        <div className={styles.topicGrid}>
          {pagedTopics.map((topic) => {
            const isPreviewTarget =
              hoverTargetId === topic.id &&
              dragSourceTopic !== null &&
              dragSourceTopic.id !== topic.id;
            const isSelected = selectedTopicId === topic.id;

            const preview = isPreviewTarget
              ? getMergedPreview(dragSourceTopic, topic)
              : null;

            return (
              <article
                key={topic.id}
                className={`${styles.topicCard} ${isPreviewTarget ? styles.previewCard : ""} ${isSelected ? styles.selectedCard : ""}`}
                draggable
                onDragStart={() => {
                  setDragSourceId(topic.id);
                  setHoverTargetId(null);
                }}
                onDragEnd={() => {
                  setDragSourceId(null);
                  setHoverTargetId(null);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragSourceId !== null && dragSourceId !== topic.id) {
                    setHoverTargetId(topic.id);
                  }
                }}
                onDragLeave={() => {
                  if (hoverTargetId === topic.id) {
                    setHoverTargetId(null);
                  }
                }}
                onDrop={() => onDropToTarget(topic.id)}
                onClick={() => onClickTopicCard(topic.id)}
              >
                {preview ? (
                  <>
                    <p className={styles.previewLabel}>Merge Preview</p>
                    <h3>{preview.title}</h3>
                    <p className={styles.altValue}> ({preview.softwareCount}) {JSON.stringify(preview.alternativeTopics)}</p>
                  </>
                ) : (
                  <>
                    <h3>{topic.topic}</h3>
                    <p className={styles.altValue}> ({topic.software_count}) {JSON.stringify(topic.alternative_topics ?? [])}</p>
                  </>
                )}
              </article>
            );
          })}
        </div>
      </section>

      {isEditorOpen && sourceTopic && targetTopic && (
        <div className={styles.modalOverlay} onClick={handleEditorCancel}>
          <section
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-label="Merge Editor"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>Merge Editor</h2>
            <p>
              source: <strong>{sourceTopic.topic}</strong> (id={sourceTopic.id}) / target: <strong>{targetTopic.topic}</strong> (id={targetTopic.id})
            </p>

            <div className={styles.radioRow}>
              <label>
                <input
                  type="radio"
                  name="keep-topic"
                  value={sourceTopic.id}
                  checked={keepTopicId === sourceTopic.id}
                  onChange={() => setKeepTopicId(sourceTopic.id)}
                />
                Keep topic: {sourceTopic.topic}
              </label>
              <label>
                <input
                  type="radio"
                  name="keep-topic"
                  value={targetTopic.id}
                  checked={keepTopicId === targetTopic.id}
                  onChange={() => setKeepTopicId(targetTopic.id)}
                />
                Keep topic: {targetTopic.topic}
              </label>
            </div>

            <div className={styles.modalActions}>
              <button type="button" className={styles.ghostButton} onClick={handleEditorCancel}>
                Cancel
              </button>
              <button type="button" onClick={handleMergeSave} disabled={!canSave}>
                {saving ? "Saving..." : "Save Merge"}
              </button>
            </div>

            {error && <p className={styles.error}>{error}</p>}
          </section>
        </div>
      )}
    </main>
  );
}
