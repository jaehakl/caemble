export const SAVE_PROTOCOL = "nemonori.save.v1" as const;

const STORAGE_PREFIX = "nemonori.arcade";
const GAME_SAVE_KEY_PREFIX = `${STORAGE_PREFIX}:game:`;
const GAME_SAVE_KEY_SUFFIX = ":save";

export type GameSaveEnvelope<T = unknown> = {
  protocol: typeof SAVE_PROTOCOL;
  gameSlug: string;
  gameTitle: string;
  updatedAt: string;
  data: T;
};

export type GameSaveSummary = {
  gameSlug: string;
  gameTitle: string;
  storageKey: string;
  updatedAt: string;
  byteSize: number;
  data: unknown;
};

function isBrowser() {
  return typeof window !== "undefined";
}

function buildStorageKey(gameSlug: string) {
  return `${GAME_SAVE_KEY_PREFIX}${gameSlug}${GAME_SAVE_KEY_SUFFIX}`;
}

function parseEnvelope(raw: string | null): GameSaveEnvelope | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<GameSaveEnvelope>;

    if (
      parsed.protocol !== SAVE_PROTOCOL ||
      typeof parsed.gameSlug !== "string" ||
      typeof parsed.gameTitle !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      !("data" in parsed)
    ) {
      return null;
    }

    return parsed as GameSaveEnvelope;
  } catch {
    return null;
  }
}

export function loadGameSave<T>(gameSlug: string): GameSaveEnvelope<T> | null {
  if (!isBrowser()) {
    return null;
  }

  const key = buildStorageKey(gameSlug);
  const raw = window.localStorage.getItem(key);
  return parseEnvelope(raw) as GameSaveEnvelope<T> | null;
}

export function saveGameSave<T>(
  gameSlug: string,
  gameTitle: string,
  data: T,
): GameSaveEnvelope<T> | null {
  if (!isBrowser()) {
    return null;
  }

  const key = buildStorageKey(gameSlug);
  const envelope: GameSaveEnvelope<T> = {
    protocol: SAVE_PROTOCOL,
    gameSlug,
    gameTitle,
    updatedAt: new Date().toISOString(),
    data,
  };

  window.localStorage.setItem(key, JSON.stringify(envelope));
  return envelope;
}

export function deleteGameSave(gameSlug: string) {
  if (!isBrowser()) {
    return;
  }

  window.localStorage.removeItem(buildStorageKey(gameSlug));
}

export function clearAllGameSaves() {
  if (!isBrowser()) {
    return;
  }

  const keysToDelete: string[] = [];

  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);

    if (key && key.startsWith(GAME_SAVE_KEY_PREFIX) && key.endsWith(GAME_SAVE_KEY_SUFFIX)) {
      keysToDelete.push(key);
    }
  }

  keysToDelete.forEach((key) => window.localStorage.removeItem(key));
}

export function getAllGameSaves(): GameSaveSummary[] {
  if (!isBrowser()) {
    return [];
  }

  const rows: GameSaveSummary[] = [];

  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);

    if (!key || !key.startsWith(GAME_SAVE_KEY_PREFIX) || !key.endsWith(GAME_SAVE_KEY_SUFFIX)) {
      continue;
    }

    const raw = window.localStorage.getItem(key);
    const envelope = parseEnvelope(raw);

    if (!envelope) {
      continue;
    }

    rows.push({
      gameSlug: envelope.gameSlug,
      gameTitle: envelope.gameTitle,
      storageKey: key,
      updatedAt: envelope.updatedAt,
      byteSize: raw ? new Blob([raw]).size : 0,
      data: envelope.data,
    });
  }

  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
