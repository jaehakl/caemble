#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
GitHub CAE / Simulation repository harvester with DB-managed keywords.

Core goals:
1) Queries are generated randomly from keyword tables, executed once, and cached (no duplicates).
2) Repos are stored with repo full_name as primary key; duplicates across queries are merged.
3) Repos returned by a query are considered to have the query's tags (keyword categories/values),
   and these are accumulated per repo.

Plus:
4) Candidate keywords are automatically extracted from repo metadata (description/topics) and stored.
5) You can promote candidates into active keywords (manual approval flow recommended).

Storage: SQLite (single DB file), resumable.
API: GitHub REST API (Search + Repo details for topics).
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import random
import re
import sqlite3
import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import requests


# -----------------------------
# Defaults (seed keywords)
# -----------------------------

SEED_KEYWORDS = [
    # Domain (general CAE)
    ("domain", "cfd", 1.0, "manual"),
    ("domain", "fluid", 1.0, "manual"),
    ("domain", "navier-stokes", 1.0, "manual"),
    ("domain", "turbulence", 0.8, "manual"),
    ("domain", "multiphase", 0.7, "manual"),
    ("domain", "combustion", 0.6, "manual"),

    ("domain", "structural", 1.0, "manual"),
    ("domain", "solid-mechanics", 1.0, "manual"),
    ("domain", "elasticity", 0.7, "manual"),
    ("domain", "plasticity", 0.7, "manual"),
    ("domain", "fracture", 0.7, "manual"),
    ("domain", "contact", 0.6, "manual"),

    ("domain", "thermal", 0.8, "manual"),
    ("domain", "heat-transfer", 0.8, "manual"),
    ("domain", "radiation", 0.6, "manual"),

    ("domain", "electromagnetics", 1.0, "manual"),
    ("domain", "maxwell", 0.9, "manual"),
    ("domain", "fdtd", 0.7, "manual"),
    ("domain", "photonics", 0.7, "manual"),
    ("domain", "optics", 0.8, "manual"),  # optics in general

    # Ray optics / ray tracing (explicitly included)
    ("domain", "ray-tracing", 1.0, "manual"),
    ("domain", "raytracing", 0.8, "manual"),
    ("domain", "optical-design", 0.7, "manual"),
    ("domain", "illumination", 0.6, "manual"),
    ("domain", "path-tracing", 0.6, "manual"),
    ("domain", "photon-mapping", 0.5, "manual"),
    ("domain", "brdf", 0.5, "manual"),
    ("domain", "bsdf", 0.5, "manual"),
    ("domain", "fresnel", 0.5, "manual"),

    # Semiconductor / nano
    ("domain", "semiconductor", 1.0, "manual"),
    ("domain", "tcad", 0.9, "manual"),
    ("domain", "device-simulation", 0.7, "manual"),
    ("domain", "drift-diffusion", 0.7, "manual"),
    ("domain", "quantum-transport", 0.6, "manual"),

    ("domain", "molecular-dynamics", 0.9, "manual"),
    ("domain", "dft", 0.8, "manual"),
    ("domain", "electronic-structure", 0.7, "manual"),
    ("domain", "kinetic-monte-carlo", 0.6, "manual"),
    ("domain", "phase-field", 0.7, "manual"),

    # Methods
    ("method", "fem", 1.0, "manual"),
    ("method", "finite-element", 1.0, "manual"),
    ("method", "fea", 0.8, "manual"),
    ("method", "dg", 0.6, "manual"),
    ("method", "discontinuous-galerkin", 0.6, "manual"),
    ("method", "finite-volume", 0.8, "manual"),
    ("method", "fvm", 0.7, "manual"),
    ("method", "finite-difference", 0.7, "manual"),
    ("method", "fdm", 0.6, "manual"),
    ("method", "bem", 0.5, "manual"),
    ("method", "boundary-element", 0.5, "manual"),
    ("method", "lbm", 0.5, "manual"),
    ("method", "lattice-boltzmann", 0.5, "manual"),
    ("method", "sph", 0.5, "manual"),
    ("method", "mpm", 0.4, "manual"),

    # Ray methods (treated as method category)
    ("method", "path-tracing", 0.6, "manual"),
    ("method", "ray-tracing", 0.8, "manual"),
    ("method", "photon-mapping", 0.5, "manual"),
    ("method", "monte-carlo", 0.6, "manual"),

    # Solver-ness triggers (intent)
    ("intent", "solver", 1.0, "manual"),
    ("intent", "simulation", 1.0, "manual"),
    ("intent", "simulator", 0.8, "manual"),
    ("intent", "engine", 0.8, "manual"),
    ("intent", "multiphysics", 0.7, "manual"),
    ("intent", "benchmark", 0.4, "manual"),
    ("intent", "examples", 0.4, "manual"),
    ("intent", "tutorial", 0.4, "manual"),

    # HPC / implementation
    ("hpc", "mpi", 0.7, "manual"),
    ("hpc", "openmp", 0.5, "manual"),
    ("hpc", "cuda", 0.5, "manual"),
    ("hpc", "gpu", 0.6, "manual"),
    ("hpc", "petsc", 0.6, "manual"),
    ("hpc", "trilinos", 0.5, "manual"),
    ("hpc", "hypre", 0.4, "manual"),
]

STOPWORDS = {
    # very common / noisy tokens
    "the", "and", "or", "a", "an", "for", "to", "of", "in", "on", "with", "by",
    "this","that","based","using","use","uses","used","using","uses","used","from",
    "code", "codes", "project", "repo", "repository", "library", "framework",
    "tool", "tools", "software",
    "open", "source", "opensource", "open-source",
    "solver", "simulation", "simulator", "engine",
    "github", "gitlab", "example", "examples", "tutorial", "docs", "documentation",
}


# -----------------------------
# SQLite schema
# -----------------------------

SCHEMA_SQL = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,            -- domain/method/intent/hpc/...
  term TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,  -- sampling weight
  status TEXT NOT NULL DEFAULT 'active', -- active/paused
  source TEXT NOT NULL DEFAULT 'manual', -- manual/auto
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(category, term)
);

CREATE TABLE IF NOT EXISTS keyword_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL,
  suggested_category TEXT,             -- nullable (unknown)
  score REAL NOT NULL DEFAULT 0.0,
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  sources_json TEXT NOT NULL,          -- list of {repo_full_name, field, evidence}
  status TEXT NOT NULL DEFAULT 'pending', -- pending/rejected/promoted
  UNIQUE(term)
);

CREATE TABLE IF NOT EXISTS queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL UNIQUE,
  recipe_json TEXT NOT NULL,           -- how it was constructed: keyword ids/terms/categories
  executed_at TEXT,
  last_status INTEGER,
  last_total_count INTEGER,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS repos (
  full_name TEXT PRIMARY KEY,          -- owner/name
  html_url TEXT,
  api_url TEXT,
  description TEXT,                    -- repository description
  first_seen_at TEXT,
  last_seen_at TEXT,
  repo_json TEXT,                      -- latest raw GitHub data (Search item or repo detail)
  topics_json TEXT,                    -- topics from repo detail endpoint (list)
  merged_tags_json TEXT                -- accumulated tags: {category:[terms...], ...}
);

CREATE TABLE IF NOT EXISTS repo_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query_id INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  hit_tags_json TEXT NOT NULL,         -- the tags implied by that query: {category:term,...}
  FOREIGN KEY(query_id) REFERENCES queries(id),
  FOREIGN KEY(repo_full_name) REFERENCES repos(full_name)
);

CREATE INDEX IF NOT EXISTS idx_keywords_active ON keywords(status, category);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON keyword_candidates(status);
CREATE INDEX IF NOT EXISTS idx_repo_hits_repo ON repo_hits(repo_full_name);
CREATE INDEX IF NOT EXISTS idx_repo_hits_query ON repo_hits(query_id);
"""


# -----------------------------
# Helpers
# -----------------------------

def utcnow_iso() -> str:
    return dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def db_connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA_SQL)
    db_migrate_repos_columns(conn)
    return conn


def db_migrate_repos_columns(conn: sqlite3.Connection) -> None:
    """
    Backward-compatible migration for existing repos table.
    """
    cur = conn.cursor()
    cur.execute("PRAGMA table_info(repos)")
    cols = {r[1] for r in cur.fetchall()}

    if "description" not in cols:
        conn.execute("ALTER TABLE repos ADD COLUMN description TEXT")
    if "detail" in cols:
        try:
            conn.execute("ALTER TABLE repos DROP COLUMN detail")
        except sqlite3.OperationalError:
            # Older SQLite builds may not support DROP COLUMN.
            pass
    if "url" in cols:
        try:
            conn.execute("ALTER TABLE repos DROP COLUMN url")
        except sqlite3.OperationalError:
            # Older SQLite builds may not support DROP COLUMN.
            pass

    # Backfill for old rows.
    conn.execute(
        """
        UPDATE repos
        SET
          description = COALESCE(description, json_extract(repo_json, '$.description'))
        """
    )
    conn.commit()


def db_seed_keywords(conn: sqlite3.Connection) -> int:
    now = utcnow_iso()
    n = 0
    for category, term, weight, source in SEED_KEYWORDS:
        conn.execute(
            "INSERT OR IGNORE INTO keywords(category, term, weight, status, source, created_at, updated_at) "
            "VALUES (?, ?, ?, 'active', ?, ?, ?)",
            (category, term, weight, source, now, now),
        )
        n += 1
    conn.commit()
    return n


def weighted_choice(items: List[Tuple[str, float]], rng: random.Random) -> str:
    total = sum(w for _, w in items)
    if total <= 0:
        return rng.choice([t for t, _ in items])
    r = rng.random() * total
    upto = 0.0
    for t, w in items:
        upto += w
        if upto >= r:
            return t
    return items[-1][0]


def normalize_term(term: str) -> str:
    return term.strip().lower()


TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9\-\_]{2,48}$")


def extract_candidate_terms(text: str) -> List[str]:
    """
    Extract terms from text with conservative rules:
    - lowercase
    - keep hyphen/underscore words
    - length 3..50
    - remove stopwords and pure numbers
    """
    if not text:
        return []
    raw = re.split(r"[^a-zA-Z0-9\-\_]+", text.lower())
    terms = []
    for t in raw:
        t = normalize_term(t)
        if not t:
            continue
        if t in STOPWORDS:
            continue
        if t.isdigit():
            continue
        if not TOKEN_RE.match(t):
            continue
        # drop very generic suffix/prefix patterns
        if t in {"readme", "docs", "doc", "test", "tests"}:
            continue
        terms.append(t)
    return terms


def should_skip_candidate_term(term: str, existing_keyword_terms: set[str]) -> bool:
    t = normalize_term(term)
    if not t:
        return True
    if t in existing_keyword_terms:
        return True
    for kw in existing_keyword_terms:
        if not kw:
            continue
        # Exclude if candidate and existing keyword are substring-related
        # (e.g., fluid vs fluid-dynamics, fem vs xfem, etc.).
        if kw in t or t in kw:
            return True
    return False


# -----------------------------
# Keyword ops
# -----------------------------

@dataclass
class KeywordRow:
    id: int
    category: str
    term: str
    weight: float


def db_get_active_keywords(conn: sqlite3.Connection, category: str) -> List[KeywordRow]:
    cur = conn.cursor()
    cur.execute(
        "SELECT id, category, term, weight FROM keywords WHERE status='active' AND category=?",
        (category,),
    )
    rows = cur.fetchall()
    return [KeywordRow(int(r[0]), r[1], r[2], float(r[3])) for r in rows]


def db_keyword_exists(conn: sqlite3.Connection, category: str, term: str) -> bool:
    cur = conn.cursor()
    cur.execute("SELECT 1 FROM keywords WHERE category=? AND term=?", (category, term))
    return cur.fetchone() is not None


def db_promote_candidate(conn: sqlite3.Connection, term: str, category: str, weight: float = 0.4, source: str = "auto") -> None:
    """
    Promote a candidate term into active keywords (manual approval step).
    """
    now = utcnow_iso()
    term = normalize_term(term)
    conn.execute(
        "INSERT OR IGNORE INTO keywords(category, term, weight, status, source, created_at, updated_at) "
        "VALUES (?, ?, ?, 'active', ?, ?, ?)",
        (category, term, weight, source, now, now),
    )
    conn.execute(
        "UPDATE keyword_candidates SET status='promoted' WHERE term=?",
        (term,),
    )
    conn.commit()


# -----------------------------
# Query generation (DB-driven)
# -----------------------------

def make_random_query(conn: sqlite3.Connection, rng: random.Random) -> Tuple[str, Dict[str, str], Dict]:
    """
    Create a query string and implied tags using a random "recipe".

    Output:
      query_str: str
      hit_tags: {category: term}  (what we consider attributes of repos returned)
      recipe: dict (keyword ids and terms used)
    """
    # Pull active keywords per category
    domains = db_get_active_keywords(conn, "domain")
    methods = db_get_active_keywords(conn, "method")
    intents = db_get_active_keywords(conn, "intent")
    hpcs = db_get_active_keywords(conn, "hpc")

    if not domains or not methods or not intents:
        raise RuntimeError("Not enough active keywords. Run init + seed first.")

    # Choose a recipe type (weights tuned to keep queries short)
    recipe_type = weighted_choice(
        [("DMI", 0.45), ("DI", 0.25), ("MI", 0.15), ("DHI", 0.10), ("DL", 0.05)],
        rng,
    )

    # Helpers to sample a row using weights.
    # Pick row objects directly to avoid string re-match edge cases.
    def pick(rows: List[KeywordRow]) -> KeywordRow:
        if not rows:
            raise RuntimeError("Cannot pick from empty keyword rows.")
        total = sum(float(r.weight) for r in rows)
        if total <= 0:
            return rng.choice(rows)
        rnum = rng.random() * total
        upto = 0.0
        for row in rows:
            upto += float(row.weight)
            if upto >= rnum:
                return row
        return rows[-1]

    dom = pick(domains)
    intent = pick(intents)

    hit_tags: Dict[str, str] = {"domain": dom.term, "intent": intent.term}
    recipe = {"type": recipe_type, "keywords": []}

    # Optional method/hpc/lang/license bait as a short token
    method = pick(methods)

    # Language / license baits (as raw tokens, not keywords table for simplicity)
    lang_baits = ["c++", "fortran", "python", "julia", "rust", "cuda"]
    lic_baits = ["license", "gpl", "lgpl", "bsd", "mit", "apache-2.0", "mpl-2.0", "epl-2.0"]

    if recipe_type == "DMI":
        # domain + method + intent
        query = f"{dom.term} {method.term} {intent.term}"
        hit_tags["method"] = method.term
        recipe["keywords"] = [
            {"id": dom.id, "category": dom.category, "term": dom.term},
            {"id": method.id, "category": method.category, "term": method.term},
            {"id": intent.id, "category": intent.category, "term": intent.term},
        ]

    elif recipe_type == "DI":
        # domain + intent
        query = f"{dom.term} {intent.term}"
        recipe["keywords"] = [
            {"id": dom.id, "category": dom.category, "term": dom.term},
            {"id": intent.id, "category": intent.category, "term": intent.term},
        ]

    elif recipe_type == "MI":
        # method + intent (domain tag becomes unknown; still store intent/method)
        query = f"{method.term} {intent.term}"
        hit_tags = {"method": method.term, "intent": intent.term}
        recipe["keywords"] = [
            {"id": method.id, "category": method.category, "term": method.term},
            {"id": intent.id, "category": intent.category, "term": intent.term},
        ]

    elif recipe_type == "DHI":
        # domain + hpc + intent (dep-bait/HPC-bait)
        if not hpcs:
            query = f"{dom.term} {intent.term}"
            recipe_type = "DI"
        else:
            hpc = pick(hpcs)
            query = f"{dom.term} {intent.term} {hpc.term}"
            hit_tags["hpc"] = hpc.term
            recipe["keywords"] = [
                {"id": dom.id, "category": dom.category, "term": dom.term},
                {"id": intent.id, "category": intent.category, "term": intent.term},
                {"id": hpc.id, "category": hpc.category, "term": hpc.term},
            ]

    else:  # "DL" bait: domain + intent + (lang or license)
        bait = rng.choice(lang_baits + lic_baits)
        query = f"{dom.term} {intent.term} {bait}"
        hit_tags["bait"] = bait
        recipe["keywords"] = [
            {"id": dom.id, "category": dom.category, "term": dom.term},
            {"id": intent.id, "category": intent.category, "term": intent.term},
        ]
        recipe["bait"] = bait

    return query, hit_tags, recipe


def db_insert_query_if_new(conn: sqlite3.Connection, query: str, recipe: Dict) -> int:
    cur = conn.cursor()
    cur.execute(
        "INSERT OR IGNORE INTO queries(query, recipe_json) VALUES (?, ?)",
        (query, json.dumps(recipe, ensure_ascii=False)),
    )
    conn.commit()
    cur.execute("SELECT id FROM queries WHERE query=?", (query,))
    row = cur.fetchone()
    if not row:
        raise RuntimeError("Failed to upsert query row.")
    return int(row[0])


def db_query_is_executed(conn: sqlite3.Connection, query_id: int) -> bool:
    cur = conn.cursor()
    cur.execute("SELECT executed_at FROM queries WHERE id=?", (query_id,))
    r = cur.fetchone()
    return bool(r and r[0])


def db_mark_query_executed(conn: sqlite3.Connection, query_id: int, status: int,
                           total_count: Optional[int], error: Optional[str]) -> None:
    conn.execute(
        "UPDATE queries SET executed_at=?, last_status=?, last_total_count=?, last_error=? WHERE id=?",
        (utcnow_iso(), status, total_count, error, query_id),
    )
    conn.commit()


def _build_numeric_qualifier(name: str, min_value: Optional[int], max_value: Optional[int]) -> Optional[str]:
    if min_value is None and max_value is None:
        return None
    if min_value is not None and min_value < 0:
        raise ValueError(f"{name} minimum must be >= 0")
    if max_value is not None and max_value < 0:
        raise ValueError(f"{name} maximum must be >= 0")
    if min_value is not None and max_value is not None:
        if min_value > max_value:
            raise ValueError(f"{name} minimum cannot be greater than maximum")
        return f"{name}:{min_value}..{max_value}"
    if min_value is not None:
        return f"{name}:>={min_value}"
    return f"{name}:<={max_value}"


def apply_repo_filters_to_query(
    base_query: str,
    min_stars: Optional[int] = None,
    max_stars: Optional[int] = None,
    min_forks: Optional[int] = None,
    max_forks: Optional[int] = None,
    min_followers: Optional[int] = None,
    max_followers: Optional[int] = None,
    min_topics: Optional[int] = None,
    max_topics: Optional[int] = None,
) -> str:
    qualifiers = []
    for q in (
        _build_numeric_qualifier("stars", min_stars, max_stars),
        _build_numeric_qualifier("forks", min_forks, max_forks),
        _build_numeric_qualifier("followers", min_followers, max_followers),
        _build_numeric_qualifier("topics", min_topics, max_topics),
    ):
        if q:
            qualifiers.append(q)
    if not qualifiers:
        return base_query
    return f"{base_query} {' '.join(qualifiers)}"


# -----------------------------
# Repo storage + tag merge
# -----------------------------

def _load_json(s: Optional[str], default):
    if not s:
        return default
    try:
        return json.loads(s)
    except Exception:
        return default


def merge_repo_tags(existing: Dict[str, List[str]], hit_tags: Dict[str, str]) -> Dict[str, List[str]]:
    merged: Dict[str, set] = {k: set(v) for k, v in existing.items()}
    for k, v in hit_tags.items():
        merged.setdefault(k, set()).add(v)
    return {k: sorted(list(vs)) for k, vs in merged.items()}


def db_upsert_repo_and_hit(conn: sqlite3.Connection, query_id: int, repo_item: Dict, hit_tags: Dict[str, str]) -> None:
    full_name = repo_item.get("full_name")
    if not full_name:
        return

    now = utcnow_iso()
    html_url = repo_item.get("html_url")
    api_url = repo_item.get("url")
    description = repo_item.get("description")
    incoming_topics = repo_item.get("topics") or []
    incoming_topics = sorted({
        normalize_term(str(t)) for t in incoming_topics
        if str(t).strip()
    })

    cur = conn.cursor()
    cur.execute("SELECT merged_tags_json, topics_json FROM repos WHERE full_name=?", (full_name,))
    row = cur.fetchone()

    if row:
        existing_tags = _load_json(row[0], {})
        existing_topics = _load_json(row[1], [])
        merged_tags = merge_repo_tags(existing_tags, hit_tags)
        merged_topics = sorted(set(existing_topics) | set(incoming_topics))
        conn.execute(
            "UPDATE repos SET html_url=?, api_url=?, description=?, last_seen_at=?, repo_json=?, topics_json=?, merged_tags_json=? WHERE full_name=?",
            (
                html_url,
                api_url,
                description,
                now,
                json.dumps(repo_item),
                json.dumps(merged_topics, ensure_ascii=False),
                json.dumps(merged_tags, ensure_ascii=False),
                full_name,
            ),
        )
    else:
        merged_tags = merge_repo_tags({}, hit_tags)
        conn.execute(
            "INSERT INTO repos(full_name, html_url, api_url, description, first_seen_at, last_seen_at, repo_json, topics_json, merged_tags_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                full_name,
                html_url,
                api_url,
                description,
                now,
                now,
                json.dumps(repo_item),
                json.dumps(incoming_topics, ensure_ascii=False),
                json.dumps(merged_tags, ensure_ascii=False),
            ),
        )

    conn.execute(
        "INSERT INTO repo_hits(query_id, repo_full_name, seen_at, hit_tags_json) VALUES (?, ?, ?, ?)",
        (query_id, full_name, now, json.dumps(hit_tags, ensure_ascii=False)),
    )
    conn.commit()


# -----------------------------
# GitHub API client
# -----------------------------

class GitHubClient:
    def __init__(self, token: Optional[str], user_agent: str = "cae-db-harvester/2.0"):
        self.base = "https://api.github.com"
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": user_agent})
        if token:
            self.session.headers.update({"Authorization": f"Bearer {token}"})
        self.session.headers.update({"Accept": "application/vnd.github+json"})

    def search_repositories(self, query: str, per_page: int, page: int, sort: str, order: str) -> requests.Response:
        url = f"{self.base}/search/repositories"
        params = {"q": query, "per_page": per_page, "page": page, "sort": sort, "order": order}
        return self.session.get(url, params=params, timeout=30)

    def get_repo_details_with_topics(self, full_name: str) -> requests.Response:
        """
        Repo details endpoint can return topics if we send the proper header.
        GitHub currently supports topics via this media type:
          application/vnd.github+json plus topics in response when 'topics' are enabled.
        We also add a legacy topics preview header for robustness (GitHub has changed this over time).
        """
        url = f"{self.base}/repos/{full_name}"
        headers = {
            "Accept": "application/vnd.github+json, application/vnd.github.mercy-preview+json"
        }
        return self.session.get(url, headers=headers, timeout=30)

    def get_repo_readme(self, full_name: str) -> requests.Response:
        url = f"{self.base}/repos/{full_name}/readme"
        return self.session.get(url, timeout=30)


def maybe_sleep_from_rate_limit(resp: requests.Response, min_sleep: float = 1.5) -> None:
    try:
        remaining = int(resp.headers.get("X-RateLimit-Remaining", "1"))
        reset = int(resp.headers.get("X-RateLimit-Reset", "0"))
    except Exception:
        time.sleep(min_sleep)
        return

    if remaining <= 1 and reset > 0:
        now = int(time.time())
        wait = max(reset - now + 2, 2)
        time.sleep(wait)
    else:
        time.sleep(min_sleep)


# -----------------------------
# README fetch from repos.csv
# -----------------------------

def extract_full_name_from_html_url(html_url: str) -> Optional[str]:
    if not html_url:
        return None
    m = re.match(r"^https?://github\.com/([^/\s]+)/([^/\s?#]+)", html_url.strip())
    if not m:
        return None
    owner = m.group(1).strip()
    repo = m.group(2).strip()
    if repo.endswith(".git"):
        repo = repo[:-4]
    if not owner or not repo:
        return None
    return f"{owner}/{repo}"


def make_readme_filename(full_name: str) -> str:
    # Windows-safe file name for owner/repo format.
    return f"{full_name.replace('/', '__')}.md"


def decode_readme_response(resp: requests.Response) -> Optional[str]:
    try:
        data = resp.json()
    except Exception:
        return None

    content = data.get("content")
    encoding = data.get("encoding")
    if not content:
        return None

    if encoding == "base64":
        try:
            return base64.b64decode(content).decode("utf-8", errors="replace")
        except Exception:
            return None
    if isinstance(content, str):
        return content
    return None


def fetch_readmes_from_csv(
    client: GitHubClient,
    csv_path: str,
    out_dir: str,
    min_sleep: float = 1.0,
    overwrite: bool = False,
    limit: Optional[int] = None,
) -> None:
    import csv

    os.makedirs(out_dir, exist_ok=True)

    total_rows = 0
    attempted = 0
    saved = 0
    skipped_invalid = 0
    skipped_existing = 0
    skipped_duplicate = 0
    missing_readme = 0
    failed = 0
    seen: set[str] = set()

    with open(csv_path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            total_rows += 1
            if limit is not None and attempted >= limit:
                break

            raw_full_name = (row.get("full_name") or "").strip()
            html_url = (row.get("html_url") or "").strip()
            full_name = raw_full_name or extract_full_name_from_html_url(html_url) or ""
            full_name = full_name.strip()

            if not full_name or "/" not in full_name:
                skipped_invalid += 1
                continue
            if full_name in seen:
                skipped_duplicate += 1
                continue
            seen.add(full_name)
            attempted += 1

            out_name = make_readme_filename(full_name)
            out_path = os.path.join(out_dir, out_name)
            if os.path.exists(out_path) and not overwrite:
                skipped_existing += 1
                continue

            resp = client.get_repo_readme(full_name)
            maybe_sleep_from_rate_limit(resp, min_sleep=min_sleep)

            if resp.status_code == 404:
                missing_readme += 1
                print(f"  {full_name}: README not found (404)")
                continue
            if resp.status_code != 200:
                failed += 1
                print(f"  {full_name}: ERROR {resp.status_code}")
                continue

            readme_text = decode_readme_response(resp)
            if readme_text is None:
                failed += 1
                print(f"  {full_name}: ERROR decode_failed")
                continue

            with open(out_path, "w", encoding="utf-8", newline="") as wf:
                wf.write(readme_text)
            saved += 1
            print(f"  {full_name}: saved -> {out_name}")

    print(
        "Fetch README done: "
        f"rows={total_rows}, attempted={attempted}, saved={saved}, "
        f"skipped_invalid={skipped_invalid}, skipped_duplicate={skipped_duplicate}, "
        f"skipped_existing={skipped_existing}, missing_readme={missing_readme}, failed={failed}"
    )


# -----------------------------
# Enrichment: fetch topics, extract candidates
# -----------------------------

def db_get_repos_missing_topics(conn: sqlite3.Connection, limit: int = 200) -> List[str]:
    """
    Return full_name list for repos where topics_json is empty list (or NULL).
    """
    cur = conn.cursor()
    cur.execute(
        """
        SELECT full_name
        FROM repos
        WHERE topics_json IS NULL
           OR topics_json = ''
           OR topics_json = '[]'
           OR (json_valid(topics_json)=1 AND json_type(topics_json)='array' AND json_array_length(topics_json)=0)
           OR json_valid(topics_json)=0
        ORDER BY last_seen_at DESC
        LIMIT ?
        """,
        (limit,),
    )
    return [r[0] for r in cur.fetchall()]


def db_update_repo_details_and_topics(conn: sqlite3.Connection, full_name: str, repo_detail: Dict) -> None:
    topics = repo_detail.get("topics") or []
    now = utcnow_iso()
    conn.execute(
        "UPDATE repos SET topics_json=?, last_seen_at=? WHERE full_name=?",
        (json.dumps(topics, ensure_ascii=False), now, full_name),
    )
    conn.commit()


def db_add_candidate(conn: sqlite3.Connection, term: str, field: str, repo_full_name: str, score_inc: float = 1.0) -> None:
    """
    Upsert candidate term; track sources.
    """
    term = normalize_term(term)
    now = utcnow_iso()

    cur = conn.cursor()
    cur.execute("SELECT score, occurrences, sources_json, status FROM keyword_candidates WHERE term=?", (term,))
    row = cur.fetchone()

    new_source = {"repo_full_name": repo_full_name, "field": field, "evidence": term}

    if row:
        score, occ, sources_json, status = float(row[0]), int(row[1]), row[2], row[3]
        sources = _load_json(sources_json, [])
        # avoid unbounded growth: keep at most 30 sources
        if len(sources) < 30:
            sources.append(new_source)
        conn.execute(
            "UPDATE keyword_candidates SET score=?, occurrences=?, last_seen_at=?, sources_json=? WHERE term=?",
            (score + score_inc, occ + 1, now, json.dumps(sources, ensure_ascii=False), term),
        )
    else:
        sources = [new_source]
        conn.execute(
            "INSERT INTO keyword_candidates(term, suggested_category, score, occurrences, first_seen_at, last_seen_at, sources_json, status) "
            "VALUES (?, NULL, ?, 1, ?, ?, ?, 'pending')",
            (term, score_inc, now, now, json.dumps(sources, ensure_ascii=False)),
        )
    conn.commit()


def infer_candidate_category(term: str) -> Optional[str]:
    """
    Very lightweight heuristics. You can expand over time.
    """
    if term in {"mpi", "openmp", "cuda", "gpu", "petsc", "trilinos", "hypre"}:
        return "hpc"
    if term in {"fem", "fea", "finite-element", "finite-volume", "fvm", "fdm", "fdtd", "bem", "lbm", "sph", "mpm", "ray-tracing", "path-tracing"}:
        return "method"
    if term in {"solver", "simulation", "simulator", "engine", "multiphysics"}:
        return "intent"
    # otherwise: unknown or domain-ish
    return None


def run_enrich_topics(conn: sqlite3.Connection, client: GitHubClient, limit: int, min_sleep: float) -> None:
    targets = db_get_repos_missing_topics(conn, limit=limit)
    print(f"Enrich topics: targets={len(targets)} (limit={limit})")

    for i, full_name in enumerate(targets, 1):
        resp = client.get_repo_details_with_topics(full_name)
        maybe_sleep_from_rate_limit(resp, min_sleep=min_sleep)
        if resp.status_code != 200:
            print(f"  [{i}/{len(targets)}] {full_name}: ERROR {resp.status_code}")
            continue
        detail = resp.json()
        db_update_repo_details_and_topics(conn, full_name, detail)
        topics = detail.get("topics") or []
        print(f"  [{i}/{len(targets)}] {full_name}: topics={len(topics)}")


def run_extract_candidates(conn: sqlite3.Connection, limit_repos: int, min_score_token: float = 1.0) -> None:
    """
    Extract candidate terms from repos (description + topics). Store into keyword_candidates.
    """
    cur = conn.cursor()
    cur.execute("SELECT full_name, repo_json, topics_json FROM repos ORDER BY last_seen_at DESC LIMIT ?", (limit_repos,))
    rows = cur.fetchall()
    cur.execute("SELECT DISTINCT term FROM keywords")
    existing_keyword_terms = {normalize_term(r[0]) for r in cur.fetchall() if r[0]}

    print(f"Extract candidates from repos={len(rows)} (limit={limit_repos})")
    for (full_name, repo_json, topics_json) in rows:
        repo = _load_json(repo_json, {})
        desc = repo.get("description") or ""
        topics = _load_json(topics_json, [])

        # Description tokens: modest score
        for t in extract_candidate_terms(desc):
            if t in STOPWORDS:
                continue
            if should_skip_candidate_term(t, existing_keyword_terms):
                continue
            # skip if already an active keyword in any category (quick check via candidates table only is insufficient)
            # we'll just store as candidate; promotion step checks keyword existence.
            db_add_candidate(conn, t, "description", full_name, score_inc=0.3)

        # Topics tokens: stronger score (topics are high-signal)
        for topic in topics:
            t = normalize_term(str(topic))
            if not t or t in STOPWORDS:
                continue
            if should_skip_candidate_term(t, existing_keyword_terms):
                continue
            db_add_candidate(conn, t, "topic", full_name, score_inc=1.0)

    # Optional: set suggested_category by heuristic for pending candidates with NULL suggested_category
    conn.execute(
        "UPDATE keyword_candidates SET suggested_category=COALESCE(suggested_category, ?) WHERE 1=0",
        ("domain",),
    )
    conn.commit()


def run_suggest_categories(conn: sqlite3.Connection, top_n: int = 500) -> None:
    cur = conn.cursor()
    cur.execute(
        "SELECT term FROM keyword_candidates WHERE status='pending' ORDER BY score DESC, occurrences DESC LIMIT ?",
        (top_n,),
    )
    terms = [r[0] for r in cur.fetchall()]
    updated = 0
    for t in terms:
        cat = infer_candidate_category(t)
        if cat:
            conn.execute(
                "UPDATE keyword_candidates SET suggested_category=? WHERE term=? AND (suggested_category IS NULL OR suggested_category='')",
                (cat, t),
            )
            updated += 1
    conn.commit()
    print(f"Suggested categories updated={updated}")


# -----------------------------
# Harvest loop
# -----------------------------

def run_harvest(
    conn: sqlite3.Connection,
    client: GitHubClient,
    steps: int,
    per_page: int,
    pages_per_query: int,
    seed: int,
    min_sleep: float,
    sort: str,
    order: str,
    min_stars: Optional[int] = None,
    max_stars: Optional[int] = None,
    min_forks: Optional[int] = None,
    max_forks: Optional[int] = None,
    min_watchers: Optional[int] = None,
    max_watchers: Optional[int] = None,
    min_topics: Optional[int] = None,
    max_topics: Optional[int] = None,
    max_query_attempts: int = 50,
) -> None:
    rng = random.Random(seed)
    print(f"Harvest: steps={steps}, per_page={per_page}, pages/query={pages_per_query}, sort={sort}, order={order}")

    executed_steps = 0
    attempts = 0

    while executed_steps < steps and attempts < (steps * max_query_attempts):
        attempts += 1
        query, hit_tags, recipe = make_random_query(conn, rng)
        query = apply_repo_filters_to_query(
            base_query=query,
            min_stars=min_stars,
            max_stars=max_stars,
            min_forks=min_forks,
            max_forks=max_forks,
            min_followers=min_watchers,
            max_followers=max_watchers,
            min_topics=min_topics,
            max_topics=max_topics,
        )
        qid = db_insert_query_if_new(conn, query, recipe)

        if db_query_is_executed(conn, qid):
            continue  # cached, don't re-run

        print(f"\n[{executed_steps+1}/{steps}] qid={qid} :: {query}  tags={hit_tags}")

        total_count = None
        try:
            collected = 0
            for page in range(1, pages_per_query + 1):
                resp = client.search_repositories(query, per_page=per_page, page=page, sort=sort, order=order)
                maybe_sleep_from_rate_limit(resp, min_sleep=min_sleep)

                if resp.status_code != 200:
                    db_mark_query_executed(conn, qid, resp.status_code, None, resp.text[:5000])
                    print(f"  ERROR {resp.status_code}: {resp.text[:220]}")
                    break

                data = resp.json()
                if total_count is None:
                    total_count = int(data.get("total_count", 0))
                    print(f"  total_count={total_count}")

                items = data.get("items", [])
                if not items:
                    print("  No items on this page; stopping paging.")
                    break

                for item in items:
                    db_upsert_repo_and_hit(conn, qid, item, hit_tags)
                    collected += 1

                print(f"  page {page}: items={len(items)}, collected_so_far={collected}")

            db_mark_query_executed(conn, qid, 200, total_count, None)
            executed_steps += 1
            print(f"  Done. collected={collected}")

        except Exception as e:
            db_mark_query_executed(conn, qid, 0, total_count, repr(e))
            print(f"  EXCEPTION: {e}")

    if executed_steps < steps:
        print(f"Stopped early: executed_steps={executed_steps}, attempts={attempts} (pool may be saturated or rate-limited).")


# -----------------------------
# Export
# -----------------------------

def export_repos_csv(conn: sqlite3.Connection, out_path: str) -> int:
    import csv
    cur = conn.cursor()
    cur.execute("""
        SELECT
            full_name,
            html_url,
            description,
            first_seen_at,
            last_seen_at,
            merged_tags_json,
            json_extract(repo_json, '$.language') AS language,
            json_extract(repo_json, '$.stargazers_count') AS stars,
            json_extract(repo_json, '$.forks_count') AS forks,
            json_extract(repo_json, '$.open_issues_count') AS open_issues,
            json_extract(repo_json, '$.updated_at') AS updated_at,
            json_extract(repo_json, '$.license.spdx_id') AS license_spdx,
            topics_json
        FROM repos
    """)
    rows = cur.fetchall()
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "full_name", "html_url", "description", "first_seen_at", "last_seen_at",
            "merged_tags_json", "language", "stars", "forks",
            "open_issues", "updated_at", "license_spdx", "topics_json"
        ])
        for r in rows:
            w.writerow(r)
    return len(rows)


def export_candidates_csv(conn: sqlite3.Connection, out_path: str, status: str = "pending", limit: int = 2000) -> int:
    import csv
    cur = conn.cursor()
    cur.execute("""
        SELECT term, suggested_category, score, occurrences, first_seen_at, last_seen_at, status, sources_json
        FROM keyword_candidates
        WHERE status=?
        ORDER BY score DESC, occurrences DESC
        LIMIT ?
    """, (status, limit))
    rows = cur.fetchall()
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["term", "suggested_category", "score", "occurrences", "first_seen_at", "last_seen_at", "status", "sources_json"])
        for r in rows:
            w.writerow(r)
    return len(rows)


# -----------------------------
# CLI
# -----------------------------

def cmd_init(args) -> None:
    conn = db_connect(args.db)
    n = db_seed_keywords(conn)
    print(f"DB initialized: {args.db}")
    print(f"Seed keywords attempted: {n} (duplicates ignored).")


def cmd_harvest(args) -> None:
    token = os.getenv("GITHUB_TOKEN")
    if not token:
        print("WARNING: GITHUB_TOKEN is not set. You will hit rate limits quickly.")
    conn = db_connect(args.db)
    db_seed_keywords(conn)  # safe no-op if already seeded
    client = GitHubClient(token=token)
    run_harvest(
        conn=conn,
        client=client,
        steps=args.steps,
        per_page=args.per_page,
        pages_per_query=args.pages_per_query,
        seed=args.seed,
        min_sleep=args.min_sleep,
        sort=args.sort,
        order=args.order,
        min_stars=args.min_stars,
        max_stars=args.max_stars,
        min_forks=args.min_forks,
        max_forks=args.max_forks,
        min_watchers=args.min_watchers,
        max_watchers=args.max_watchers,
        min_topics=args.min_topics,
        max_topics=args.max_topics,
    )


def cmd_enrich(args) -> None:
    token = os.getenv("GITHUB_TOKEN")
    if not token:
        print("WARNING: GITHUB_TOKEN is not set. You will hit rate limits quickly.")
    conn = db_connect(args.db)
    client = GitHubClient(token=token)
    run_enrich_topics(conn, client, limit=args.limit, min_sleep=args.min_sleep)


def cmd_extract(args) -> None:
    conn = db_connect(args.db)
    run_extract_candidates(conn, limit_repos=args.limit_repos)
    run_suggest_categories(conn, top_n=args.top_n)


def cmd_promote(args) -> None:
    conn = db_connect(args.db)
    if args.csv:
        import csv

        promoted = 0
        skipped_exists = 0
        skipped_missing_term = 0
        skipped_missing_category = 0
        skipped_invalid_weight = 0

        with open(args.csv, "r", encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                term = normalize_term((row.get("term") or "").strip())
                if not term:
                    skipped_missing_term += 1
                    continue

                category = (row.get("category") or row.get("suggested_category") or args.category or "").strip()
                if not category:
                    skipped_missing_category += 1
                    continue

                weight = args.weight
                row_weight = (row.get("weight") or "").strip()
                if row_weight:
                    try:
                        weight = float(row_weight)
                    except ValueError:
                        skipped_invalid_weight += 1
                        continue

                source = (row.get("source") or args.source or "auto").strip()

                if db_keyword_exists(conn, category, term):
                    skipped_exists += 1
                    continue

                db_promote_candidate(conn, term, category, weight=weight, source=source)
                promoted += 1

        print(
            "Batch promote done: "
            f"promoted={promoted}, "
            f"skipped_exists={skipped_exists}, "
            f"skipped_missing_term={skipped_missing_term}, "
            f"skipped_missing_category={skipped_missing_category}, "
            f"skipped_invalid_weight={skipped_invalid_weight}"
        )
        return

    if not args.term:
        raise RuntimeError("term is required unless --csv is used.")
    if not args.category:
        raise RuntimeError("--category is required for single-term promote.")

    term = normalize_term(args.term)
    category = args.category
    if db_keyword_exists(conn, category, term):
        print(f"Already exists in keywords: category={category}, term={term}")
        return
    db_promote_candidate(conn, term, category, weight=args.weight, source=args.source)
    print(f"Promoted: term={term} -> category={category}, weight={args.weight}, source={args.source}")


def cmd_export(args) -> None:
    conn = db_connect(args.db)
    if args.what == "repos":
        n = export_repos_csv(conn, args.out)
        print(f"Exported repos: {n} -> {args.out}")
    elif args.what == "candidates":
        n = export_candidates_csv(conn, args.out, status=args.status, limit=args.limit)
        print(f"Exported candidates({args.status}): {n} -> {args.out}")
    else:
        raise RuntimeError("Unknown export target.")


def cmd_fetch_readmes(args) -> None:
    token = os.getenv("GITHUB_TOKEN")
    if not token:
        print("WARNING: GITHUB_TOKEN is not set. You will hit rate limits quickly.")
    client = GitHubClient(token=token)
    fetch_readmes_from_csv(
        client=client,
        csv_path=args.csv,
        out_dir=args.out_dir,
        min_sleep=args.min_sleep,
        overwrite=args.overwrite,
        limit=args.limit,
    )


def main() -> None:
    ap = argparse.ArgumentParser(prog="github_cae_db_harvester.py")
    ap.add_argument("--db", type=str, default="cae.sqlite", help="SQLite DB path")

    sub = ap.add_subparsers(dest="cmd", required=True)

    p_init = sub.add_parser("init", help="Initialize DB and seed keywords")
    p_init.set_defaults(func=cmd_init)

    p_h = sub.add_parser("harvest", help="Run harvesting (random queries from DB keywords)")
    p_h.add_argument("--steps", type=int, default=100, help="How many distinct queries to execute")
    p_h.add_argument("--per_page", type=int, default=50, help="Results per page (max 100)")
    p_h.add_argument("--pages_per_query", type=int, default=2, help="Pages to fetch per query")
    p_h.add_argument("--seed", type=int, default=42, help="Random seed")
    p_h.add_argument("--min_sleep", type=float, default=1.5, help="Minimum sleep between requests")
    p_h.add_argument("--sort", type=str, default="updated", choices=["stars", "forks", "help-wanted-issues", "updated"])
    p_h.add_argument("--order", type=str, default="desc", choices=["desc", "asc"])
    p_h.add_argument("--min-stars", type=int, default=1, help="GitHub Search qualifier: minimum stars")
    p_h.add_argument("--max-stars", type=int, default=None, help="GitHub Search qualifier: maximum stars")
    p_h.add_argument("--min-forks", type=int, default=1, help="GitHub Search qualifier: minimum forks")
    p_h.add_argument("--max-forks", type=int, default=None, help="GitHub Search qualifier: maximum forks")
    p_h.add_argument("--min-watchers", type=int, default=None, help="Minimum watchers via GitHub 'followers' qualifier")
    p_h.add_argument("--max-watchers", type=int, default=None, help="Maximum watchers via GitHub 'followers' qualifier")
    p_h.add_argument("--min-topics", type=int, default=1, help="GitHub Search qualifier: minimum number of topics")
    p_h.add_argument("--max-topics", type=int, default=None, help="GitHub Search qualifier: maximum number of topics")
    p_h.set_defaults(func=cmd_harvest)

    p_e = sub.add_parser("enrich", help="Fetch repo details to populate topics (and refresh repo_json)")
    p_e.add_argument("--limit", type=int, default=200, help="How many repos to enrich in this run")
    p_e.add_argument("--min_sleep", type=float, default=1.5, help="Minimum sleep between requests")
    p_e.set_defaults(func=cmd_enrich)

    p_x = sub.add_parser("extract", help="Extract keyword candidates from repo description/topics")
    p_x.add_argument("--limit_repos", type=int, default=2000, help="How many recent repos to scan")
    p_x.add_argument("--top_n", type=int, default=500, help="How many candidates to run category suggestion on")
    p_x.set_defaults(func=cmd_extract)

    p_p = sub.add_parser("promote", help="Promote a candidate term to active keywords")
    p_p.add_argument("term", type=str, nargs="?", help="candidate term to promote (single mode)")
    p_p.add_argument("--csv", type=str, default=None, help="batch mode: input CSV path")
    p_p.add_argument("--category", type=str, default=None, help="domain/method/intent/hpc etc (single mode required, batch mode fallback)")
    p_p.add_argument("--weight", type=float, default=0.4, help="sampling weight for the promoted keyword")
    p_p.add_argument("--source", type=str, default="auto", help="manual/auto")
    p_p.set_defaults(func=cmd_promote)

    p_out = sub.add_parser("export", help="Export repos/candidates to CSV")
    p_out.add_argument("what", choices=["repos", "candidates"])
    p_out.add_argument("--out", type=str, required=True, help="output csv file")
    p_out.add_argument("--status", type=str, default="pending", help="candidate status filter")
    p_out.add_argument("--limit", type=int, default=2000, help="candidate export limit")
    p_out.set_defaults(func=cmd_export)

    p_r = sub.add_parser("fetch-readmes", help="Fetch each repository README from repos.csv via GitHub API")
    p_r.add_argument("--csv", type=str, required=True, help="input repos CSV path (must have full_name or html_url)")
    p_r.add_argument("--out-dir", type=str, default="readme_files", help="directory to save README files")
    p_r.add_argument("--min-sleep", type=float, default=1.0, help="minimum sleep between requests")
    p_r.add_argument("--overwrite", action="store_true", help="overwrite existing README files")
    p_r.add_argument("--limit", type=int, default=None, help="maximum unique repos to attempt")
    p_r.set_defaults(func=cmd_fetch_readmes)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
