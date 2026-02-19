"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { swDelete, swDetail, swUpsertBatch } from "../../../api";
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
  topics: string[];
};

type SoftwareDetailResponse = {
  software: SoftwareDetailItem;
};

type SubmitResult = {
  inserted: number;
  updated: number;
  topics_created: number;
  links_created: number;
};

type DeleteResult = {
  deleted_full_name: string;
  deleted_topics: number;
};

type FormState = {
  full_name: string;
  name: string;
  html_url: string;
  abstract: string;
  description: string;
  language: string;
  source_updated_at: string;
  repository: string;
  citations: string;
  license: string;
  topics_text: string;
};

const EMPTY_FORM: FormState = {
  full_name: "",
  name: "",
  html_url: "",
  abstract: "",
  description: "",
  language: "",
  source_updated_at: "",
  repository: "",
  citations: "",
  license: "",
  topics_text: "",
};

function toDatetimeLocalValue(input: string) {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function normalizeTopics(text: string): string[] {
  return text
    .split(/\r?\n|,/g)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export default function SoftwareEditPage() {
  const params = useParams<{ full_name: string }>();
  const router = useRouter();
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
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  useEffect(() => {
    if (!decodedFullName) {
      return;
    }
    const run = async () => {
      setLoading(true);
      setError(null);
      setSuccess(null);
      try {
        const response = await swDetail(decodedFullName);
        const data = response?.data as SoftwareDetailResponse | undefined;
        if (!data?.software) {
          throw new Error("상세 데이터가 없습니다.");
        }
        const sw = data.software;
        setForm({
          full_name: sw.full_name ?? "",
          name: sw.name ?? "",
          html_url: sw.html_url ?? "",
          abstract: sw.abstract ?? "",
          description: sw.description ?? "",
          language: sw.language ?? "",
          source_updated_at: toDatetimeLocalValue(sw.source_updated_at),
          repository: sw.repository ?? "",
          citations: String(sw.citations ?? ""),
          license: sw.license ?? "",
          topics_text: (sw.topics ?? []).join(", "),
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : "데이터 로딩에 실패했습니다.";
        setError(message);
      } finally {
        setLoading(false);
      }
    };
    void run();
  }, [decodedFullName]);

  const onChange =
    (key: keyof FormState) =>
    (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setForm((prev) => ({ ...prev, [key]: e.target.value }));
    };

  const validate = () => {
    const requiredFields: Array<keyof FormState> = [
      "full_name",
      "html_url",
      "abstract",
      "source_updated_at",
      "repository",
      "citations",
    ];
    for (const field of requiredFields) {
      if (!form[field].trim()) {
        return `${field} is required`;
      }
    }

    const date = new Date(form.source_updated_at);
    if (Number.isNaN(date.getTime())) {
      return "source_updated_at is invalid";
    }

    const citations = Number(form.citations);
    if (!Number.isInteger(citations)) {
      return "citations must be integer";
    }

    return null;
  };

  const handleSave = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      setSuccess(null);
      return;
    }

    const payload = {
      full_name: form.full_name.trim(),
      name: form.name.trim(),
      html_url: form.html_url.trim(),
      abstract: form.abstract.trim(),
      description: form.description.trim(),
      language: form.language.trim(),
      source_updated_at: new Date(form.source_updated_at).toISOString(),
      repository: form.repository.trim(),
      citations: Number(form.citations),
      license: form.license.trim(),
      topics: normalizeTopics(form.topics_text),
    };

    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await swUpsertBatch([payload]);
      const result = response?.data as SubmitResult | undefined;
      if (!result) {
        throw new Error("빈 응답이 반환되었습니다.");
      }
      setSuccess(
        `saved: inserted=${result.inserted}, updated=${result.updated}, topics_created=${result.topics_created}, links_created=${result.links_created}`
      );
      router.push(`/swdetail/${encodeURIComponent(payload.full_name)}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : "저장에 실패했습니다.";
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const target = form.full_name.trim() || decodedFullName;
    if (!target) {
      setError("full_name is required");
      return;
    }

    const confirmed = window.confirm(
      `Delete software "${target}"?\nThis will also remove orphan topics automatically.`
    );
    if (!confirmed) {
      return;
    }

    setDeleting(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await swDelete(target);
      const result = response?.data as DeleteResult | undefined;
      if (!result) {
        throw new Error("빈 응답이 반환되었습니다.");
      }
      router.push("/");
    } catch (e) {
      const message = e instanceof Error ? e.message : "삭제에 실패했습니다.";
      setError(message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>Edit Software</h1>
        <p className={styles.links}>
          <Link href="/">Home</Link>
          <Link href="/">Softwares</Link>
          {decodedFullName && <Link href={`/swdetail/${encodeURIComponent(decodedFullName)}`}>Back to Detail</Link>}
        </p>
      </header>

      {loading && <p>Loading...</p>}
      {error && <p className={styles.error}>{error}</p>}
      {success && <p className={styles.success}>{success}</p>}

      {!loading && (
        <section className={styles.formWrap}>
          <label>
            full_name
            <input value={form.full_name} onChange={onChange("full_name")} />
          </label>
          <label>
            name
            <input value={form.name} onChange={onChange("name")} />
          </label>
          <label>
            html_url
            <input value={form.html_url} onChange={onChange("html_url")} />
          </label>
          <label>
            language
            <input value={form.language} onChange={onChange("language")} />
          </label>
          <label>
            repository
            <input value={form.repository} onChange={onChange("repository")} />
          </label>
          <label>
            citations
            <input value={form.citations} onChange={onChange("citations")} />
          </label>
          <label>
            license
            <input value={form.license} onChange={onChange("license")} />
          </label>
          <label>
            source_updated_at
            <input
              type="datetime-local"
              value={form.source_updated_at}
              onChange={onChange("source_updated_at")}
            />
          </label>
          <label className={styles.fullRow}>
            abstract
            <textarea rows={4} value={form.abstract} onChange={onChange("abstract")} />
          </label>
          <label className={styles.fullRow}>
            description
            <textarea rows={8} value={form.description} onChange={onChange("description")} />
          </label>
          <label className={styles.fullRow}>
            topics (comma or newline separated)
            <textarea rows={4} value={form.topics_text} onChange={onChange("topics_text")} />
          </label>

          <div className={styles.actions}>
            <button type="button" onClick={handleSave} disabled={saving || deleting}>
              {saving ? "Saving..." : "Save"}
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={saving || deleting}
              className={styles.deleteButton}
            >
              {deleting ? "Deleting..." : "Delete"}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
