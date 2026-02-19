"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import styles from "./page.module.css";

type SoftwareUpsertItemInput = {
  full_name: string;
  name: string;
  html_url: string;
  abstract: string;
  description: string;
  language: string;
  source_updated_at: string;
  repository: string;
  citations: number;
  license: string;
  topics: string[];
};

type ParseError = {
  row: number;
  message: string;
};

type SubmitResult = {
  inserted: number;
  updated: number;
  topics_created: number;
  links_created: number;
};

const FIELD_NAMES = [
  "full_name",
  "name",
  "html_url",
  "abstract",
  "description",
  "language",
  "source_updated_at",
  "repository",
  "citations",
  "license",
  "topics",
] as const;

const API_URL = "http://127.0.0.1:8000";

function parseTsv(input: string): {
  validRows: SoftwareUpsertItemInput[];
  errors: ParseError[];
} {
  const validRows: SoftwareUpsertItemInput[] = [];
  const errors: ParseError[] = [];

  const lines = input
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");

  if (lines.length === 0) {
    return {
      validRows,
      errors: [{ row: 0, message: "입력된 TSV가 없습니다." }],
    };
  }

  let startIndex = 0;
  const maybeHeader = lines[0].split("\t").map((col) => col.trim().toLowerCase());
  if (
    maybeHeader.length === FIELD_NAMES.length &&
    FIELD_NAMES.every((field, i) => maybeHeader[i] === field)
  ) {
    startIndex = 1;
  }

  for (let i = startIndex; i < lines.length; i += 1) {
    const rowNumber = i + 1;
    const cols = lines[i].split("\t");

    if (cols.length !== FIELD_NAMES.length) {
      errors.push({
        row: rowNumber,
        message: `컬럼 수가 ${FIELD_NAMES.length}개가 아닙니다. 현재 ${cols.length}개입니다.`,
      });
      continue;
    }

    const [
      full_name,
      name,
      html_url,
      abstract,
      description,
      language,
      source_updated_at_raw,
      repository,
      citations_raw,
      license,
      topics_raw,
    ] = cols.map((col) => col.trim());

    const requiredTextFields = [
      ["full_name", full_name],
      ["name", name],
      ["html_url", html_url],
      ["abstract", abstract],
      ["description", description],
      ["language", language],
      ["source_updated_at", source_updated_at_raw],
      ["repository", repository],
      ["license", license],
    ] as const;

    const missingField = requiredTextFields.find(([, value]) => value.length === 0);
    if (missingField) {
      errors.push({ row: rowNumber, message: `${missingField[0]} 값이 비어 있습니다.` });
      continue;
    }

    const dt = new Date(source_updated_at_raw);
    if (Number.isNaN(dt.getTime())) {
      errors.push({
        row: rowNumber,
        message: "source_updated_at 형식이 올바르지 않습니다. (예: 2025-01-01T00:00:00Z)",
      });
      continue;
    }

    const citations = Number(citations_raw);
    if (!Number.isInteger(citations)) {
      errors.push({ row: rowNumber, message: "citations는 정수여야 합니다." });
      continue;
    }

    const topics = topics_raw
      .split(",")
      .map((topic) => topic.trim())
      .filter((topic) => topic.length > 0);

    validRows.push({
      full_name,
      name,
      html_url,
      abstract,
      description,
      language,
      source_updated_at: dt.toISOString(),
      repository,
      citations,
      license,
      topics,
    });
  }

  return { validRows, errors };
}

export default function NewSoftwaresBatchPage() {
  const [tsvInput, setTsvInput] = useState("");
  const [rows, setRows] = useState<SoftwareUpsertItemInput[]>([]);
  const [errors, setErrors] = useState<ParseError[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);

  const canSubmit = useMemo(
    () => rows.length > 0 && errors.length === 0 && !isSubmitting,
    [rows.length, errors.length, isSubmitting]
  );

  const handleValidate = () => {
    const parsed = parseTsv(tsvInput);
    setRows(parsed.validRows);
    setErrors(parsed.errors);
    setSubmitResult(null);
    setSubmitError(null);
  };

  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setTsvInput(text);
      setSubmitResult(null);
      setSubmitError(null);
    } catch {
      setSubmitError("클립보드 읽기에 실패했습니다. 직접 붙여넣어 주세요.");
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit) {
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);
    setSubmitResult(null);

    try {
      const response = await fetch(`${API_URL}/api/sw_upsert_batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(rows),
      });

      if (!response.ok) {
        const bodyText = await response.text();
        throw new Error(bodyText || `요청 실패 (${response.status})`);
      }

      const result = (await response.json()) as SubmitResult;
      setSubmitResult(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
      setSubmitError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>New Softwares Batch</h1>
        <p>TSV를 붙여넣고 검증한 뒤, sw_upsert_batch로 일괄 등록합니다.</p>
        <p className={styles.backLinkWrap}>
          <Link href="/">Back to Home</Link>
        </p>
      </header>

      <section className={styles.section}>
        <h2>1) TSV 입력</h2>
        <p className={styles.hint}>
          컬럼 순서: {FIELD_NAMES.join("\t")}<br />
          topics는 쉼표(,)로 구분합니다.
        </p>
        <textarea
          className={styles.textarea}
          value={tsvInput}
          onChange={(e) => setTsvInput(e.target.value)}
          placeholder="여기에 TSV를 붙여넣으세요"
          rows={12}
        />
        <div className={styles.actions}>
          <button type="button" onClick={handlePasteFromClipboard}>
            Paste From Clipboard
          </button>
          <button type="button" onClick={handleValidate}>
            Validate TSV
          </button>
          <button type="button" onClick={handleSubmit} disabled={!canSubmit}>
            {isSubmitting ? "Submitting..." : "Submit"}
          </button>
        </div>
      </section>

      <section className={styles.section}>
        <h2>2) 검증 결과</h2>
        <p>
          유효 행: <strong>{rows.length}</strong> / 오류: <strong>{errors.length}</strong>
        </p>
        {errors.length > 0 && (
          <ul className={styles.errorList}>
            {errors.map((error, idx) => (
              <li key={`${error.row}-${idx}`}>
                Row {error.row}: {error.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section}>
        <h2>3) 입력 예정 데이터</h2>
        {rows.length === 0 ? (
          <p>표시할 데이터가 없습니다.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {FIELD_NAMES.map((field) => (
                    <th key={field}>{field}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr key={`${row.full_name}-${idx}`}>
                    <td>{row.full_name}</td>
                    <td>{row.name}</td>
                    <td>{row.html_url}</td>
                    <td>{row.abstract}</td>
                    <td>{row.description}</td>
                    <td>{row.language}</td>
                    <td>{row.source_updated_at}</td>
                    <td>{row.repository}</td>
                    <td>{row.citations}</td>
                    <td>{row.license}</td>
                    <td>{row.topics.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={styles.section}>
        <h2>4) 제출 결과</h2>
        {submitError && <p className={styles.submitError}>{submitError}</p>}
        {submitResult && (
          <p className={styles.submitSuccess}>
            inserted={submitResult.inserted}, updated={submitResult.updated}, topics_created=
            {submitResult.topics_created}, links_created={submitResult.links_created}
          </p>
        )}
      </section>
    </main>
  );
}
