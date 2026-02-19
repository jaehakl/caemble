"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { swFilterOptions, swSearch } from "../../api";
import styles from "./page.module.css";

type SoftwareSearchItem = {
  id: number;
  full_name: string;
  name: string | null;
  abstract: string;
  description: string | null;
  language: string | null;
  source_updated_at: string;
  repository: string;
  citations: number;
  license: string | null;
  topics: string[];
  relevance_score: number;
};

type SoftwareSearchResponse = {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  sort_by: "source_updated_at" | "citations" | "relevance";
  sort_order: "asc" | "desc";
  items: SoftwareSearchItem[];
};

type SoftwareFilterOptionsResponse = {
  languages: string[];
  repositories: string[];
  licenses: string[];
  topics: string[];
};

const FIXED_PAGE_SIZE = 60;

type MultiSelectDropdownProps = {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
};

function MultiSelectDropdown({ label, options, selected, onChange }: MultiSelectDropdownProps) {
  const [keyword, setKeyword] = useState("");
  const [open, setOpen] = useState(false);

  const filteredOptions = options.filter((value) => {
    if (selected.includes(value)) {
      return false;
    }
    if (!keyword.trim()) {
      return true;
    }
    return value.toLowerCase().includes(keyword.trim().toLowerCase());
  });

  const handleAdd = (value: string) => {
    onChange([...selected, value]);
    setKeyword("");
    setOpen(false);
  };

  return (
    <div className={styles.comboField}>
      <p className={styles.comboLabel}>{label}</p>
      <div className={styles.combo}>
        <div className={styles.chips}>
          {selected.map((value) => (
            <span key={value} className={styles.chip}>
              <span>{value}</span>
              <button
                type="button"
                className={styles.chipRemove}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onChange(selected.filter((item) => item !== value));
                }}
                title={`Remove ${value}`}
                aria-label={`Remove ${value}`}
              >
                x
              </button>
            </span>
          ))}
        </div>
        <input
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          placeholder={`Search ${label} and click to add`}
        />
        {open && (
          <div className={styles.comboList}>
            {filteredOptions.length === 0 ? (
              <p className={styles.comboEmpty}>No options</p>
            ) : (
              filteredOptions.slice(0, 100).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={styles.comboItem}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleAdd(value);
                  }}
                >
                  {value}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function SoftwaresPage() {
  const [query, setQuery] = useState("");
  const [selectedLanguages, setSelectedLanguages] = useState<string[]>([]);
  const [selectedRepositories, setSelectedRepositories] = useState<string[]>([]);
  const [selectedLicenses, setSelectedLicenses] = useState<string[]>([]);
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<"source_updated_at" | "citations" | "relevance">("citations");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);

  const [optionsLoading, setOptionsLoading] = useState(false);
  const [options, setOptions] = useState<SoftwareFilterOptionsResponse>({
    languages: [],
    repositories: [],
    licenses: [],
    topics: [],
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<SoftwareSearchItem[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);

  const canPrev = page > 1 && !loading;
  const canNext = totalPages > 0 && page < totalPages && !loading;

  const payloadForPage = (targetPage: number) => ({
    query: query.trim() || null,
    languages: selectedLanguages,
    repositories: selectedRepositories,
    licenses: selectedLicenses,
    topics: selectedTopics,
    source_updated_at_from: null,
    source_updated_at_to: null,
    citations_min: null,
    citations_max: null,
    sort_by: sortBy,
    sort_order: sortOrder,
    page: targetPage,
    page_size: FIXED_PAGE_SIZE,
  });

  const executeSearch = async (targetPage: number) => {
    setLoading(true);
    setError(null);
    try {
      const response = await swSearch(payloadForPage(targetPage));
      const data = response?.data as SoftwareSearchResponse | undefined;
      if (!data) {
        throw new Error("Empty response returned.");
      }
      setItems(Array.isArray(data.items) ? data.items : []);
      setTotal(data.total ?? 0);
      setTotalPages(data.total_pages ?? 0);
      setPage(data.page ?? targetPage);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Search failed.";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const loadOptions = async () => {
    setOptionsLoading(true);
    setError(null);
    try {
      const response = await swFilterOptions();
      const data = response?.data as SoftwareFilterOptionsResponse | undefined;
      if (!data) {
        throw new Error("Failed to load filter options.");
      }
      setOptions(data);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to load filter options.";
      setError(message);
    } finally {
      setOptionsLoading(false);
    }
  };

  useEffect(() => {
    void loadOptions().then(() => executeSearch(1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleCountLabel = useMemo(() => `${items.length} / ${total}`, [items.length, total]);
  const formatDateOnly = (value: string) => {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      return "-";
    }
    return d.toISOString().slice(0, 10);
  };

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>Open Source CAE Softwares Search</h1>
        <p>Filter, keyword search, sorting, and pagination for open source CAE software list.</p>
      </header>

      <section className={styles.panel}>
        <div className={styles.listHeader}>
          <h2>Filters</h2>
          {optionsLoading && <p>Loading options...</p>}
        </div>

        <div className={styles.grid}>
          <MultiSelectDropdown
            label="language"
            options={options.languages}
            selected={selectedLanguages}
            onChange={setSelectedLanguages}
          />
          <MultiSelectDropdown
            label="repository"
            options={options.repositories}
            selected={selectedRepositories}
            onChange={setSelectedRepositories}
          />
          <MultiSelectDropdown
            label="license"
            options={options.licenses}
            selected={selectedLicenses}
            onChange={setSelectedLicenses}
          />
          <MultiSelectDropdown
            label="topic"
            options={options.topics}
            selected={selectedTopics}
            onChange={setSelectedTopics}
          />

          <label>
            sort by
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
              <option value="relevance">relevance</option>
              <option value="source_updated_at">source_updated_at</option>
              <option value="citations">citations</option>
            </select>
          </label>

          <label>
            sort order
            <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value as typeof sortOrder)}>
              <option value="desc">desc</option>
              <option value="asc">asc</option>
            </select>
          </label>
        </div>

        <div className={styles.actions}>
          <button type="button" disabled={loading} onClick={() => void executeSearch(1)}>
            {loading ? "Loading..." : "Apply Filters"}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setSelectedLanguages([]);
              setSelectedRepositories([]);
              setSelectedLicenses([]);
              setSelectedTopics([]);
              setSortBy("citations");
              setSortOrder("desc");
              setQuery("");
              void executeSearch(1);
            }}
          >
            Reset
          </button>
        </div>
      </section>

      <section className={styles.searchPanel}>
        <h2>Search</h2>
        <input
          className={styles.searchInput}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search in full_name, name, abstract, description"
        />
        <button type="button" disabled={loading} onClick={() => void executeSearch(1)}>
          {loading ? "Loading..." : "Search"}
        </button>
      </section>

      <section className={styles.panel}>
        <div className={styles.listHeader}>
          <h2>List</h2>
          <p>
            page={page}/{Math.max(totalPages, 1)} | rows={visibleCountLabel}
          </p>
        </div>
        {error && <p className={styles.error}>{error}</p>}
        {!error && (
          <div className={styles.cardGrid}>
            {items.length === 0 ? (
              <p className={styles.empty}>No results.</p>
            ) : (
              items.map((item) => (
                <article key={item.id} className={styles.card}>
                  <h3 className={styles.cardName}>
                    <Link href={`/swdetail/${encodeURIComponent(item.full_name)}`}>{item.name || "-"}</Link>
                  </h3>
                  <p>{item.full_name}</p>
                  <p className={styles.cardAbstract}>{item.abstract || "-"}</p>

                  <div className={styles.metaRow}>
                    <span className={styles.metaTag}>Language: {item.language || "-"}</span>
                    <span className={styles.metaTag}>Updated: {formatDateOnly(item.source_updated_at)}</span>
                  </div>
                  <div className={styles.metaRow}>
                    <span className={styles.metaTag}>Citations: {item.citations}</span>
                    <span className={styles.metaTag}>License: {item.license || "-"}</span>
                  </div>

                  <div className={styles.topicWrap}>
                    {(item.topics ?? []).length === 0 ? (
                      <span className={styles.topicEmpty}>No topics</span>
                    ) : (
                      (item.topics ?? []).map((topic) => (
                        <span key={`${item.id}-${topic}`} className={styles.topicChip}>
                          {topic}
                        </span>
                      ))
                    )}
                  </div>
                </article>
              ))
            )}
          </div>
        )}
        <div className={styles.pagination}>
          <button type="button" disabled={!canPrev} onClick={() => void executeSearch(page - 1)}>
            Prev
          </button>
          <span>
            {page} / {Math.max(totalPages, 1)}
          </span>
          <button type="button" disabled={!canNext} onClick={() => void executeSearch(page + 1)}>
            Next
          </button>
        </div>
      </section>
    </main>
  );
}
