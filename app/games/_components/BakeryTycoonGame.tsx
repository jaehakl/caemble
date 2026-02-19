"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type Phaser from "phaser";
import { loadGameSave, saveGameSave } from "@/app/lib/save-protocol";
import styles from "./BakeryTycoonGame.module.css";

const GAME_SLUG = "bakery-tycoon";
const GAME_TITLE = "Bakery Tycoon";

const MAP_WIDTH = 700;
const MAP_HEIGHT = 420;
const PLAYER_SPEED = 220;
const STATION_RADIUS = 76;
const TICK_MS = 600;
const START_MINUTE = 8 * 60;

const INITIAL_CASH = 1200;
const INITIAL_INGREDIENTS = 80;
const INGREDIENT_UNIT_COST = 2;
const BASE_BREAD_PRICE = 8;

const INGREDIENT_SHELF = 900;
const DOUGH_SHELF = 120;
const BREAD_SHELF = 240;

const PREP_MINUTES = 22;
const BAKE_MINUTES = 32;
const BREADS_PER_BATCH = 5;

const PAYROLL_INTERVAL = 360;
const SALARY_PER_EMPLOYEE = 180;
const HIRE_COST = 420;

const BASE_MARKETING_COST = 280;
const BASE_TECH_COST = 340;
const INVEST_DURATION = 900;
const TECH_INVEST_DURATION = 3600;

const BASE_EXPAND_COST = 980;
const EXPAND_STEP = 520;

const BASE_FIRST_PER_HOUR = 6.5;
const BASE_REPURCHASE = 0.06;
const MAX_REPEAT_PER_HOUR = 32;
const EMPLOYEE_BREAD_PER_HOUR = 1.2;
const MAX_LOG = 7;

type PhaserRuntime = typeof Phaser;
type Station = "fridge" | "counter" | "oven" | "display" | "office";
type ActiveStation = Station | null;

type IngredientBatch = {
  id: number;
  units: number;
  expiresAt: number;
};

type BreadLot = {
  id: number;
  units: number;
  count: number;
  expiresAt: number;
};

type OvenSlot = {
  id: number;
  units: number;
  count: number;
  finishAt: number;
  expiresAt: number;
};

type Carrying =
  | { type: "ingredient"; units: number; expiresAt: number }
  | { type: "dough"; units: number; count: number; expiresAt: number }
  | { type: "bread"; units: number; count: number; expiresAt: number }
  | null;

type PrepTask = {
  endsAt: number;
  units: number;
  count: number;
  sourceExpiresAt: number;
} | null;

type Stats = {
  sold: number;
  firstSales: number;
  repeatSales: number;
  manual: number;
  auto: number;
  wasteIngredients: number;
  wasteBread: number;
};

type SimState = {
  minute: number;
  cash: number;
  bestCash: number;
  station: ActiveStation;
  carrying: Carrying;
  task: PrepTask;

  ingredients: IngredientBatch[];
  oven: OvenSlot[];
  ready: BreadLot[];
  display: BreadLot[];

  ingredientPerBread: number;
  breadPrice: number;
  buyUnits: number;

  storeLevel: number;
  employees: number;

  marketingLevel: number;
  marketingUntil: number;
  techLevel: number;
  techUntil: number;

  customerBase: number;
  newPool: number;
  repeatPool: number;
  workerPool: number;
  payrollDueAt: number;

  nextId: number;
  stats: Stats;
  logs: string[];
  paused: boolean;
};

type SceneAction =
  | { type: "setBuyUnits"; value: number }
  | { type: "setIngredient"; value: number }
  | { type: "setPrice"; value: number }
  | { type: "buyIngredients" }
  | { type: "investMarketing" }
  | { type: "investTech" }
  | { type: "expand" }
  | { type: "hire" }
  | { type: "fire" }
  | { type: "togglePause" }
  | { type: "reset" };

type StationPoint = {
  key: Station;
  label: string;
  x: number;
  y: number;
  color: number;
};

type UiSnapshot = {
  minute: number;
  clock: string;
  cash: number;
  bestCash: number;
  ingredientPerBread: number;
  breadPrice: number;
  buyUnits: number;
  ingredientStock: number;
  fridgeCapacity: number;
  ovenCapacity: number;
  displayCount: number;
  readyCount: number;
  prepActive: boolean;
  prepProgress: number;
  prepRemaining: number;
  storeLevel: number;
  employees: number;
  employeeCap: number;
  marketingLevel: number;
  marketingLeft: number;
  techLevel: number;
  techLeft: number;
  marketingCost: number;
  techCost: number;
  expandCost: number;
  firstVisitorRate: number;
  repeatVisitorRate: number;
  autoRate: number;
  paused: boolean;
  logs: string[];
};

type ModalState = {
  station: Station;
  snapshot: UiSnapshot;
};

type SceneBridge = {
  game: Phaser.Game;
  destroy: () => void;
  setModalOpen: (open: boolean) => void;
  act: (action: SceneAction) => void;
  getSnapshot: () => UiSnapshot;
};

type CreateSceneOptions = {
  PhaserRef: PhaserRuntime;
  parent: HTMLDivElement;
  initialBestCash: number;
  onStationChange: (station: ActiveStation) => void;
  onStationClick: (station: Station, snapshot: UiSnapshot) => void;
  onSnapshot: (snapshot: UiSnapshot) => void;
  onBestCash: (bestCash: number) => void;
};

const money = new Intl.NumberFormat("ko-KR");
const STATION_LABEL: Record<Station, string> = {
  fridge: "Fridge",
  counter: "Counter",
  oven: "Oven",
  display: "Display",
  office: "Office",
};

const STATION_POINTS: StationPoint[] = [
  { key: "fridge", label: "FRIDGE", x: 98, y: 94, color: 0x38bdf8 },
  { key: "counter", label: "COUNTER", x: 340, y: 92, color: 0xf59e0b },
  { key: "oven", label: "OVEN", x: 592, y: 102, color: 0xf97316 },
  { key: "display", label: "DISPLAY", x: 584, y: 320, color: 0x4ade80 },
  { key: "office", label: "OFFICE", x: 126, y: 320, color: 0xa78bfa },
];

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const fMoney = (v: number) => `${money.format(Math.round(v))}원`;

const fClock = (m: number) => {
  const day = Math.floor(m / (24 * 60)) + 1;
  const h = String(Math.floor((m % (24 * 60)) / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `D${day} ${h}:${mm}`;
};

const fDur = (m: number) => {
  const safe = Math.max(0, Math.floor(m));
  const h = Math.floor(safe / 60);
  const mm = safe % 60;
  if (h === 0) return `${mm}m`;
  if (mm === 0) return `${h}h`;
  return `${h}h ${mm}m`;
};

const sumIngredients = (rows: IngredientBatch[]) => rows.reduce((sum, row) => sum + row.units, 0);
const totalBreadCount = (rows: BreadLot[]) => rows.reduce((sum, row) => sum + row.count, 0);
const fridgeCap = (lv: number) => 140 + (lv - 1) * 90;
const employeeCap = (lv: number) => 1 + (lv - 1) * 2;
const ovenCap = (lv: number) => 2 + (lv - 1);

const firstVisitorsPerHour = (price: number, marketingLevel: number) =>
  BASE_FIRST_PER_HOUR *
  (1 + marketingLevel * 0.45) *
  clamp(1.2 - (price - BASE_BREAD_PRICE) * 0.06, 0.35, 1.45);

const repurchaseChance = (techLevel: number, ingredient: number, price: number) =>
  clamp(
    BASE_REPURCHASE +
      techLevel * 0.03 +
      ingredient * 0.011 +
      (price / BASE_BREAD_PRICE) * 0.008,
    0.04,
    0.52,
  );

const workerRate = (techLevel: number) => EMPLOYEE_BREAD_PER_HOUR + techLevel * 0.2;

const pushLog = (rows: string[], minute: number, msg: string) =>
  [`[${fClock(minute)}] ${msg}`, ...rows].slice(0, MAX_LOG);

function popOneBread(rows: BreadLot[]): { ok: false } | { ok: true; rows: BreadLot[] } {
  if (rows.length === 0) return { ok: false };
  const [head, ...rest] = rows;
  if (head.count <= 1) return { ok: true, rows: rest };
  return { ok: true, rows: [{ ...head, count: head.count - 1 }, ...rest] };
}

function consumeIngredients(
  rows: IngredientBatch[],
  units: number,
): { ok: false } | { ok: true; rows: IngredientBatch[]; expiresAt: number } {
  if (sumIngredients(rows) < units) return { ok: false };
  const sorted = [...rows].sort((a, b) => a.expiresAt - b.expiresAt);
  const next: IngredientBatch[] = [];
  let need = units;
  const expiresAt = sorted[0]?.expiresAt ?? START_MINUTE;

  for (const row of sorted) {
    if (need <= 0) {
      next.push(row);
      continue;
    }
    if (row.units <= need) {
      need -= row.units;
      continue;
    }
    next.push({ ...row, units: row.units - need });
    need = 0;
  }

  return need > 0 ? { ok: false } : { ok: true, rows: next, expiresAt };
}

function pruneIngredients(rows: IngredientBatch[], minute: number) {
  let expired = 0;
  const keep: IngredientBatch[] = [];
  for (const row of rows) {
    if (row.expiresAt <= minute) expired += row.units;
    else keep.push(row);
  }
  return { keep, expired };
}

function pruneBreadLots(rows: BreadLot[], minute: number) {
  let expired = 0;
  const keep: BreadLot[] = [];
  for (const row of rows) {
    if (row.expiresAt <= minute) expired += row.count;
    else keep.push(row);
  }
  return { keep, expired };
}

function createInitialState(bestCash: number): SimState {
  return {
    minute: START_MINUTE,
    cash: INITIAL_CASH,
    bestCash,
    station: null,
    carrying: null,
    task: null,
    ingredients: [{ id: 1, units: INITIAL_INGREDIENTS, expiresAt: START_MINUTE + INGREDIENT_SHELF }],
    oven: [],
    ready: [],
    display: [],
    ingredientPerBread: 3,
    breadPrice: BASE_BREAD_PRICE,
    buyUnits: 30,
    storeLevel: 1,
    employees: 0,
    marketingLevel: 0,
    marketingUntil: 0,
    techLevel: 0,
    techUntil: 0,
    customerBase: 24,
    newPool: 0,
    repeatPool: 0,
    workerPool: 0,
    payrollDueAt: START_MINUTE + PAYROLL_INTERVAL,
    nextId: 2,
    stats: {
      sold: 0,
      firstSales: 0,
      repeatSales: 0,
      manual: 0,
      auto: 0,
      wasteIngredients: 0,
      wasteBread: 0,
    },
    logs: ["[D1 08:00] Bakery opened."],
    paused: false,
  };
}

function toSnapshot(state: SimState): UiSnapshot {
  const ingredientStock = sumIngredients(state.ingredients);
  const firstRate = firstVisitorsPerHour(state.breadPrice, state.marketingLevel);
  const repeatRate = Math.min(
    MAX_REPEAT_PER_HOUR,
    state.customerBase * repurchaseChance(state.techLevel, state.ingredientPerBread, state.breadPrice),
  );

  const marketingCost = BASE_MARKETING_COST + state.marketingLevel * 160;
  const techCost = BASE_TECH_COST + state.techLevel * 180;
  const expandCost = BASE_EXPAND_COST + (state.storeLevel - 1) * EXPAND_STEP;
  const prepRemaining = state.task ? Math.max(0, state.task.endsAt - state.minute) : 0;
  const prepProgress = state.task
    ? clamp((PREP_MINUTES - prepRemaining) / PREP_MINUTES, 0, 1)
    : 0;

  return {
    minute: state.minute,
    clock: fClock(state.minute),
    cash: state.cash,
    bestCash: state.bestCash,
    ingredientPerBread: state.ingredientPerBread,
    breadPrice: state.breadPrice,
    buyUnits: state.buyUnits,
    ingredientStock,
    fridgeCapacity: fridgeCap(state.storeLevel),
    ovenCapacity: ovenCap(state.storeLevel),
    displayCount: totalBreadCount(state.display),
    readyCount: totalBreadCount(state.ready),
    prepActive: Boolean(state.task),
    prepProgress,
    prepRemaining,
    storeLevel: state.storeLevel,
    employees: state.employees,
    employeeCap: employeeCap(state.storeLevel),
    marketingLevel: state.marketingLevel,
    marketingLeft: state.marketingLevel > 0 ? Math.max(0, state.marketingUntil - state.minute) : 0,
    techLevel: state.techLevel,
    techLeft: state.techLevel > 0 ? Math.max(0, state.techUntil - state.minute) : 0,
    marketingCost,
    techCost,
    expandCost,
    firstVisitorRate: firstRate,
    repeatVisitorRate: repeatRate,
    autoRate: state.employees * workerRate(state.techLevel),
    paused: state.paused,
    logs: state.logs,
  };
}
function createBakeryTycoonScene({
  PhaserRef,
  parent,
  initialBestCash,
  onStationChange,
  onStationClick,
  onSnapshot,
  onBestCash,
}: CreateSceneOptions): SceneBridge {
  const state = createInitialState(initialBestCash);
  let minuteAcc = 0;
  let modalOpen = false;

  let pointerMoveActive = false;
  let pointerTargetX = MAP_WIDTH / 2;
  let pointerTargetY = MAP_HEIGHT / 2;

  let player: Phaser.GameObjects.Arc | null = null;
  let playerShadow: Phaser.GameObjects.Ellipse | null = null;
  let carryNode: Phaser.GameObjects.Shape | null = null;
  let carryHalo: Phaser.GameObjects.Ellipse | null = null;
  let hintText: Phaser.GameObjects.Text | null = null;
  let boardText: Phaser.GameObjects.Text | null = null;
  let flowText: Phaser.GameObjects.Text | null = null;
  let logText: Phaser.GameObjects.Text | null = null;

  let cursors: Phaser.Types.Input.Keyboard.CursorKeys | null = null;
  let keyW: Phaser.Input.Keyboard.Key | null = null;
  let keyA: Phaser.Input.Keyboard.Key | null = null;
  let keyS: Phaser.Input.Keyboard.Key | null = null;
  let keyD: Phaser.Input.Keyboard.Key | null = null;

  const stationNodes = new Map<Station, { ring: Phaser.GameObjects.Arc; pad: Phaser.GameObjects.Rectangle }>();
  const staticNodes: Phaser.GameObjects.GameObject[] = [];
  const ovenFire: Phaser.GameObjects.Ellipse[] = [];

  const detectStation = (x: number, y: number): ActiveStation => {
    for (const p of STATION_POINTS) {
      if (Math.hypot(x - p.x, y - p.y) <= STATION_RADIUS) return p.key;
    }
    return null;
  };

  const detectStationByClick = (x: number, y: number): Station | null => {
    for (const p of STATION_POINTS) {
      if (Math.abs(x - p.x) <= 54 && Math.abs(y - p.y) <= 34) return p.key;
    }
    return null;
  };

  const push = (msg: string) => {
    state.logs = pushLog(state.logs, state.minute, msg);
  };

  const setBestCash = (cash: number) => {
    if (cash <= state.bestCash) return;
    state.bestCash = cash;
    onBestCash(state.bestCash);
  };

  const buyIngredients = () => {
    const cost = state.buyUnits * INGREDIENT_UNIT_COST;
    if (state.cash < cost) {
      push("Not enough cash for ingredient purchase.");
      return;
    }
    if (sumIngredients(state.ingredients) + state.buyUnits > fridgeCap(state.storeLevel)) {
      push("Fridge is full.");
      return;
    }
    state.cash -= cost;
    state.ingredients.push({
      id: state.nextId,
      units: state.buyUnits,
      expiresAt: state.minute + INGREDIENT_SHELF,
    });
    state.nextId += 1;
    push(`Bought ${state.buyUnits} ingredient units.`);
    setBestCash(state.cash);
  };

  const investMarketing = () => {
    const cost = BASE_MARKETING_COST + state.marketingLevel * 160;
    if (state.cash < cost) {
      push("Not enough cash for marketing.");
      return;
    }
    state.cash -= cost;
    state.marketingLevel += 1;
    state.marketingUntil = state.minute + INVEST_DURATION;
    push(`Marketing upgraded to Lv.${state.marketingLevel}.`);
    setBestCash(state.cash);
  };

  const investTech = () => {
    const cost = BASE_TECH_COST + state.techLevel * 180;
    if (state.cash < cost) {
      push("Not enough cash for tech.");
      return;
    }
    state.cash -= cost;
    state.techLevel += 1;
    state.techUntil = state.minute + TECH_INVEST_DURATION;
    push(`Baking tech upgraded to Lv.${state.techLevel}.`);
    setBestCash(state.cash);
  };

  const expandStore = () => {
    const cost = BASE_EXPAND_COST + (state.storeLevel - 1) * EXPAND_STEP;
    if (state.cash < cost) {
      push("Not enough cash to expand.");
      return;
    }
    state.cash -= cost;
    state.storeLevel += 1;
    push(`Store expanded to Lv.${state.storeLevel}.`);
    setBestCash(state.cash);
  };

  const hire = () => {
    if (state.employees >= employeeCap(state.storeLevel)) {
      push("Employee cap reached.");
      return;
    }
    if (state.cash < HIRE_COST) {
      push("Not enough cash to hire.");
      return;
    }
    state.cash -= HIRE_COST;
    state.employees += 1;
    push(`Hired employee (${state.employees}/${employeeCap(state.storeLevel)}).`);
    setBestCash(state.cash);
  };

  const fire = () => {
    if (state.employees <= 0) return;
    state.employees -= 1;
    push(`One employee released (${state.employees} left).`);
  };

  const startPrep = () => {
    if (!state.carrying || state.carrying.type !== "ingredient" || state.task) return;
    state.task = {
      endsAt: state.minute + PREP_MINUTES,
      units: state.carrying.units,
      count: BREADS_PER_BATCH,
      sourceExpiresAt: state.carrying.expiresAt,
    };
    state.carrying = null;
    push("Counter prep started.");
  };

  const loadOven = () => {
    if (!state.carrying || state.carrying.type !== "dough") return;
    if (state.oven.length >= ovenCap(state.storeLevel)) return;
    state.oven.push({
      id: state.nextId,
      units: state.carrying.units,
      count: state.carrying.count,
      finishAt: state.minute + BAKE_MINUTES,
      expiresAt: state.minute + BREAD_SHELF,
    });
    state.nextId += 1;
    state.carrying = null;
    push("Dough loaded into oven.");
  };

  const takeReadyBread = () => {
    if (state.carrying || state.ready.length === 0) return;
    const [head, ...rest] = state.ready;
    state.ready = rest;
    state.carrying = {
      type: "bread",
      units: head.units,
      count: head.count,
      expiresAt: head.expiresAt,
    };
    push(`Picked ${head.count} breads from oven rack.`);
  };

  const placeBreadToDisplay = () => {
    if (!state.carrying || state.carrying.type !== "bread") return;
    state.display.push({
      id: state.nextId,
      units: state.carrying.units,
      count: state.carrying.count,
      expiresAt: state.carrying.expiresAt,
    });
    state.nextId += 1;
    state.stats.manual += state.carrying.count;
    push(`Placed ${state.carrying.count} breads on display.`);
    state.carrying = null;
  };

  const takeIngredientsFromFridge = () => {
    if (state.carrying) return;
    const unitsPerBatch = state.ingredientPerBread * BREADS_PER_BATCH;
    const consumed = consumeIngredients(state.ingredients, unitsPerBatch);
    if (!consumed.ok) return;
    state.ingredients = consumed.rows;
    state.carrying = {
      type: "ingredient",
      units: unitsPerBatch,
      expiresAt: consumed.expiresAt,
    };
    push(`Carrying ingredients (${unitsPerBatch} units).`);
  };

  const processTaskCompletion = () => {
    if (!state.task) return;
    if (state.task.endsAt > state.minute) return;

    if (state.task.sourceExpiresAt <= state.minute) {
      state.stats.wasteIngredients += state.task.units;
      push("Prep failed: ingredient expired during work.");
      state.task = null;
      return;
    }

    state.carrying = {
      type: "dough",
      units: state.task.units / state.task.count,
      count: state.task.count,
      expiresAt: state.minute + DOUGH_SHELF,
    };
    state.task = null;
    push("Counter prep completed. Dough ready.");
  };

  const pruneExpired = () => {
    const ingredientPrune = pruneIngredients(state.ingredients, state.minute);
    state.ingredients = ingredientPrune.keep;
    if (ingredientPrune.expired > 0) {
      state.stats.wasteIngredients += ingredientPrune.expired;
      push(`Ingredients expired (${ingredientPrune.expired} units).`);
    }

    const readyPrune = pruneBreadLots(state.ready, state.minute);
    state.ready = readyPrune.keep;
    if (readyPrune.expired > 0) {
      state.stats.wasteBread += readyPrune.expired;
      push(`Oven rack bread expired (${readyPrune.expired}).`);
    }

    const displayPrune = pruneBreadLots(state.display, state.minute);
    state.display = displayPrune.keep;
    if (displayPrune.expired > 0) {
      state.stats.wasteBread += displayPrune.expired;
      push(`Display bread expired (${displayPrune.expired}).`);
    }

    if (state.carrying) {
      if (state.carrying.expiresAt <= state.minute) {
        if (state.carrying.type === "ingredient") {
          state.stats.wasteIngredients += state.carrying.units;
        } else {
          state.stats.wasteBread += state.carrying.count;
        }
        push("Carried goods expired and discarded.");
        state.carrying = null;
      }
    }
  };

  const processOven = () => {
    const keep: OvenSlot[] = [];
    const ready: OvenSlot[] = [];

    for (const slot of state.oven) {
      if (slot.finishAt <= state.minute) ready.push(slot);
      else keep.push(slot);
    }

    state.oven = keep;
    for (const slot of ready) {
      state.ready.push({
        id: slot.id,
        units: slot.units,
        count: slot.count,
        expiresAt: slot.expiresAt,
      });
      push(`Oven done: ${slot.count} breads are ready.`);
    }
  };

  const processWorkers = () => {
    if (state.employees <= 0) return;
    const rate = workerRate(state.techLevel) * state.employees;
    state.workerPool += rate / 60;

    const unitsPerBread = state.ingredientPerBread;
    const autoCount = Math.floor(state.workerPool);
    if (autoCount <= 0) return;

    let baked = 0;
    let consumedRows = state.ingredients;
    for (let i = 0; i < autoCount; i += 1) {
      const consumed = consumeIngredients(consumedRows, unitsPerBread);
      if (!consumed.ok) break;
      consumedRows = consumed.rows;
      state.display.push({
        id: state.nextId,
        units: unitsPerBread,
        count: 1,
        expiresAt: state.minute + BREAD_SHELF,
      });
      state.nextId += 1;
      baked += 1;
    }

    if (baked > 0) {
      state.ingredients = consumedRows;
      state.workerPool -= baked;
      state.stats.auto += baked;
      push(`Employees baked ${baked} bread(s).`);
    }
  };

  const processCustomers = () => {
    const firstPerMin = firstVisitorsPerHour(state.breadPrice, state.marketingLevel) / 60;
    const repeatPerMin =
      Math.min(
        MAX_REPEAT_PER_HOUR,
        state.customerBase * repurchaseChance(state.techLevel, state.ingredientPerBread, state.breadPrice),
      ) / 60;

    state.newPool += firstPerMin;
    state.repeatPool += repeatPerMin;

    let firstDemand = Math.floor(state.newPool);
    let repeatDemand = Math.floor(state.repeatPool);
    state.newPool -= firstDemand;
    state.repeatPool -= repeatDemand;

    let sold = 0;
    let firstSales = 0;
    let repeatSales = 0;

    while (firstDemand > 0) {
      const pop = popOneBread(state.display);
      if (!pop.ok) break;
      state.display = pop.rows;
      firstDemand -= 1;
      sold += 1;
      firstSales += 1;
      state.customerBase += 1;
    }

    while (repeatDemand > 0) {
      const pop = popOneBread(state.display);
      if (!pop.ok) break;
      state.display = pop.rows;
      repeatDemand -= 1;
      sold += 1;
      repeatSales += 1;
    }

    if (sold > 0) {
      state.cash += sold * state.breadPrice;
      state.stats.sold += sold;
      state.stats.firstSales += firstSales;
      state.stats.repeatSales += repeatSales;
      setBestCash(state.cash);
      push(`Sold ${sold} bread(s) (new ${firstSales}, repeat ${repeatSales}).`);
    }
  };

  const processPayroll = () => {
    if (state.minute < state.payrollDueAt) return;
    const payroll = state.employees * SALARY_PER_EMPLOYEE;
    state.cash -= payroll;
    state.payrollDueAt += PAYROLL_INTERVAL;
    if (payroll > 0) push(`Payroll paid: ${fMoney(payroll)}.`);
  };

  const processInvestExpiry = () => {
    if (state.marketingLevel > 0 && state.minute >= state.marketingUntil) {
      state.marketingLevel = 0;
      state.marketingUntil = 0;
      push("Marketing effect expired.");
    }
    if (state.techLevel > 0 && state.minute >= state.techUntil) {
      state.techLevel = 0;
      state.techUntil = 0;
      push("Tech effect expired.");
    }
  };

  const runStationAutomation = () => {
    if (state.paused || state.task) return;

    switch (state.station) {
      case "fridge": {
        takeIngredientsFromFridge();
        break;
      }
      case "counter": {
        startPrep();
        break;
      }
      case "oven": {
        if (state.carrying?.type === "dough") loadOven();
        else if (!state.carrying) takeReadyBread();
        break;
      }
      case "display": {
        placeBreadToDisplay();
        break;
      }
      default:
        break;
    }
  };

  const tickMinute = () => {
    state.minute += 1;
    processTaskCompletion();
    processInvestExpiry();
    pruneExpired();
    processOven();
    processWorkers();
    processCustomers();
    processPayroll();
  };

  const applyAction = (action: SceneAction) => {
    switch (action.type) {
      case "setBuyUnits":
        state.buyUnits = clamp(Math.round(action.value), 10, 120);
        break;
      case "setIngredient":
        state.ingredientPerBread = clamp(Math.round(action.value), 1, 10);
        break;
      case "setPrice":
        state.breadPrice = clamp(Math.round(action.value), 3, 20);
        break;
      case "buyIngredients":
        buyIngredients();
        break;
      case "investMarketing":
        investMarketing();
        break;
      case "investTech":
        investTech();
        break;
      case "expand":
        expandStore();
        break;
      case "hire":
        hire();
        break;
      case "fire":
        fire();
        break;
      case "togglePause":
        state.paused = !state.paused;
        push(state.paused ? "Simulation paused." : "Simulation resumed.");
        break;
      case "reset": {
        const keepBest = state.bestCash;
        const next = createInitialState(keepBest);
        Object.assign(state, next);
        push("Run reset.");
        break;
      }
      default:
        break;
    }
  };

  const progressForOven = (slot: OvenSlot) =>
    clamp(1 - (slot.finishAt - state.minute) / BAKE_MINUTES, 0, 1);

  const freshness = (expiresAt: number, shelf: number) => clamp((expiresAt - state.minute) / shelf, 0, 1);

  const clearDynamic = (scene: Phaser.Scene) => {
    while (staticNodes.length > 0) {
      staticNodes.pop()?.destroy();
    }
    if (carryNode) {
      carryNode.destroy();
      carryNode = null;
    }
    if (carryHalo) {
      carryHalo.destroy();
      carryHalo = null;
    }

    for (const flame of ovenFire) {
      flame.alpha = state.oven.length > 0 ? 0.8 : 0.12;
    }

    const blink = Math.floor(state.minute / 2) % 2 === 0;

    const ingredientStock = sumIngredients(state.ingredients);
    const fridgeCount = Math.min(12, Math.ceil(ingredientStock / 12));
    for (let i = 0; i < fridgeCount; i += 1) {
      const row = Math.floor(i / 4);
      const col = i % 4;
      const alpha = state.ingredients.some((it) => freshness(it.expiresAt, INGREDIENT_SHELF) < 0.2) && blink ? 0.35 : 0.95;
      const crate = scene.add.rectangle(72 + col * 14, 70 + row * 12, 10, 8, 0x0ea5e9, alpha).setStrokeStyle(1, 0x075985, 0.9);
      staticNodes.push(crate);
    }

    if (state.task) {
      const pct = clamp((PREP_MINUTES - (state.task.endsAt - state.minute)) / PREP_MINUTES, 0, 1);
      const track = scene.add.rectangle(340, 122, 112, 10, 0x7c2d12, 0.35).setStrokeStyle(1, 0xfb923c, 0.9);
      const fill = scene.add.rectangle(284 + pct * 56, 122, Math.max(4, 112 * pct), 8, 0xfb923c, 1);
      staticNodes.push(track, fill);
    }

    if (state.carrying?.type === "dough") {
      const dough = scene.add.ellipse(338, 74, 24, 14, 0xfbbf24, 0.95).setStrokeStyle(2, 0xb45309, 0.8);
      staticNodes.push(dough);
    }

    const ovenSlots = state.oven.slice(0, 8);
    for (let i = 0; i < ovenSlots.length; i += 1) {
      const slot = ovenSlots[i];
      const pct = progressForOven(slot);
      const ox = 554 + (i % 4) * 20;
      const oy = 86 + Math.floor(i / 4) * 20;
      const bay = scene.add.rectangle(ox, oy, 16, 12, 0x111827, 0.95).setStrokeStyle(1, 0x94a3b8, 0.9);
      const heat = scene.add.rectangle(ox - 7 + pct * 7, oy + 2, Math.max(2, 14 * pct), 4, 0xfb923c, 0.95);
      staticNodes.push(bay, heat);
    }

    const readyCount = totalBreadCount(state.ready);
    for (let i = 0; i < Math.min(12, readyCount); i += 1) {
      const row = Math.floor(i / 6);
      const col = i % 6;
      const bread = scene.add.ellipse(514 + col * 12, 132 + row * 12, 10, 7, 0xfb923c, 0.95).setStrokeStyle(1, 0xc2410c, 0.8);
      staticNodes.push(bread);
    }

    const displayCount = totalBreadCount(state.display);
    for (let i = 0; i < Math.min(24, displayCount); i += 1) {
      const row = Math.floor(i / 8);
      const col = i % 8;
      const blinkBad = state.display.some((b) => freshness(b.expiresAt, BREAD_SHELF) < 0.2) && blink;
      const bread = scene
        .add.ellipse(532 + col * 12, 286 + row * 10, 10, 7, 0xfb923c, blinkBad ? 0.35 : 0.95)
        .setStrokeStyle(1, 0x9a3412, 0.85);
      staticNodes.push(bread);
    }

    if (player && state.carrying) {
      carryHalo = scene.add.ellipse(player.x, player.y - 22, 18, 10, 0xffffff, 0.2).setDepth(21);
      if (state.carrying.type === "ingredient") {
        carryNode = scene.add.rectangle(player.x, player.y - 22, 12, 12, 0x38bdf8, 0.95).setStrokeStyle(1, 0x075985, 0.8);
      } else if (state.carrying.type === "dough") {
        carryNode = scene.add.ellipse(player.x, player.y - 22, 14, 10, 0xfbbf24, 0.95).setStrokeStyle(1, 0xb45309, 0.8);
      } else {
        carryNode = scene.add.ellipse(player.x, player.y - 22, 12, 8, 0xfb923c, 0.95).setStrokeStyle(1, 0xc2410c, 0.8);
      }
      carryNode.setDepth(22);
    }
  };

  const renderOverlayText = () => {
    const snap = toSnapshot(state);

    if (boardText) {
      boardText.setText([
        `${snap.clock}   Cash ${fMoney(snap.cash)}   Best ${fMoney(snap.bestCash)}`,
        `Store Lv.${snap.storeLevel}  Employees ${snap.employees}/${snap.employeeCap}  Auto ${snap.autoRate.toFixed(1)}/h`,
        `Marketing Lv.${snap.marketingLevel} (${snap.marketingLeft > 0 ? fDur(snap.marketingLeft) : "off"})`,
        `Tech Lv.${snap.techLevel} (${snap.techLeft > 0 ? fDur(snap.techLeft) : "off"})`,
      ]);
    }

    if (flowText) {
      flowText.setText([
        `Ingredients ${snap.ingredientStock}/${snap.fridgeCapacity}  Batch ${BREADS_PER_BATCH}`,
        `Counter ${snap.prepActive ? `${Math.round(snap.prepProgress * 100)}% (${fDur(snap.prepRemaining)})` : "idle"}`,
        `Oven ${state.oven.length}/${snap.ovenCapacity}  Ready ${snap.readyCount}  Display ${snap.displayCount}`,
        `Demand: new ${snap.firstVisitorRate.toFixed(1)}/h  repeat ${snap.repeatVisitorRate.toFixed(1)}/h`,
      ]);
    }

    if (logText) {
      logText.setText(snap.logs.join("\n"));
    }

    onSnapshot(snap);
  };

  const setHighlight = (station: ActiveStation) => {
    for (const p of STATION_POINTS) {
      const node = stationNodes.get(p.key);
      if (!node) continue;
      const active = station === p.key;
      node.pad.setAlpha(active ? 0.42 : 0.24);
      node.ring.setAlpha(active ? 0.44 : 0.18);
      node.ring.setScale(active ? 1.08 : 1);
    }
  };

  const scene: Phaser.Types.Scenes.SceneType = {
    key: "BakeryTycoonScene",
    create(this: Phaser.Scene) {
      this.add.rectangle(MAP_WIDTH / 2, MAP_HEIGHT / 2, MAP_WIDTH, MAP_HEIGHT, 0x78350f, 1).setDepth(-8);
      this.add.rectangle(MAP_WIDTH / 2, MAP_HEIGHT / 2, MAP_WIDTH - 24, MAP_HEIGHT - 24, 0xfffbeb, 1).setDepth(-7);

      const floor = this.add.graphics().setDepth(-6);
      floor.fillStyle(0xfef3c7, 0.65);
      for (let y = 18; y < MAP_HEIGHT - 18; y += 40) {
        for (let x = 18; x < MAP_WIDTH - 18; x += 40) {
          if ((x + y) % 80 === 0) floor.fillRect(x, y, 20, 20);
        }
      }

      for (const p of STATION_POINTS) {
        const pad = this.add
          .rectangle(p.x, p.y, 108, 62, p.color, 0.24)
          .setStrokeStyle(2, p.color, 0.88)
          .setInteractive({ cursor: "pointer" });
        const ring = this.add
          .circle(p.x, p.y, STATION_RADIUS - 10, p.color, 0.16)
          .setStrokeStyle(2, p.color, 0.58);
        this.add
          .text(p.x, p.y - 24, p.label, {
            color: "#111827",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: "12px",
          })
          .setOrigin(0.5);

        pad.on("pointerdown", () => {
          pointerMoveActive = false;
          onStationClick(p.key, toSnapshot(state));
        });

        stationNodes.set(p.key, { ring, pad });
      }

      this.add.rectangle(98, 94, 50, 42, 0x67e8f9, 0.2).setStrokeStyle(1, 0x0c4a6e, 0.75);
      this.add.rectangle(340, 88, 74, 18, 0xd97706, 0.95).setStrokeStyle(1, 0x92400e, 0.85);
      this.add.rectangle(340, 100, 76, 10, 0x78350f, 0.8);
      this.add.rectangle(592, 102, 68, 58, 0x334155, 0.95).setStrokeStyle(2, 0x94a3b8, 0.75);
      this.add.rectangle(592, 106, 48, 24, 0x0f172a, 0.95).setStrokeStyle(1, 0x94a3b8, 0.9);
      this.add.rectangle(584, 318, 92, 14, 0x78350f, 0.95);
      this.add.rectangle(584, 304, 92, 10, 0x92400e, 0.95);
      this.add.rectangle(126, 320, 74, 30, 0xa78bfa, 0.24).setStrokeStyle(2, 0x7c3aed, 0.85);

      for (let i = 0; i < 3; i += 1) {
        ovenFire.push(this.add.ellipse(578 + i * 12, 114, 10, 14, 0xfb923c, 0.12).setDepth(1));
      }

      playerShadow = this.add.ellipse(MAP_WIDTH / 2, MAP_HEIGHT / 2 + 13, 32, 14, 0x000000, 0.22);
      player = this.add.circle(MAP_WIDTH / 2, MAP_HEIGHT / 2, 12, 0x111827, 1).setStrokeStyle(3, 0xfef3c7, 1);

      hintText = this.add.text(14, 10, "Move: Arrow / WASD / Hold touch", {
        color: "#1f2937",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "12px",
      });

      boardText = this.add.text(14, 34, "", {
        color: "#1f2937",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "12px",
        lineSpacing: 3,
      });

      flowText = this.add.text(14, 98, "", {
        color: "#1f2937",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "12px",
        lineSpacing: 3,
      });

      logText = this.add.text(14, MAP_HEIGHT - 102, state.logs.join("\n"), {
        color: "#7c2d12",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "11px",
        lineSpacing: 3,
      });

      if (this.input.keyboard) {
        cursors = this.input.keyboard.createCursorKeys();
        keyW = this.input.keyboard.addKey(PhaserRef.Input.Keyboard.KeyCodes.W);
        keyA = this.input.keyboard.addKey(PhaserRef.Input.Keyboard.KeyCodes.A);
        keyS = this.input.keyboard.addKey(PhaserRef.Input.Keyboard.KeyCodes.S);
        keyD = this.input.keyboard.addKey(PhaserRef.Input.Keyboard.KeyCodes.D);
      }

      this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        const clickedStation = detectStationByClick(pointer.x, pointer.y);
        if (clickedStation) return;
        pointerMoveActive = true;
        pointerTargetX = pointer.x;
        pointerTargetY = pointer.y;
      });

      this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
        if (!pointerMoveActive || !pointer.isDown) return;
        pointerTargetX = pointer.x;
        pointerTargetY = pointer.y;
      });

      this.input.on("pointerup", () => {
        pointerMoveActive = false;
      });

      state.station = detectStation(MAP_WIDTH / 2, MAP_HEIGHT / 2);
      setHighlight(state.station);
      renderOverlayText();
      clearDynamic(this);
    },
    update(this: Phaser.Scene, _time: number, delta: number) {
      minuteAcc += delta;
      while (minuteAcc >= TICK_MS) {
        minuteAcc -= TICK_MS;
        if (!state.paused) {
          tickMinute();
        }
      }

      if (!player || !playerShadow) return;

      const movementLocked = Boolean(state.task) || modalOpen;
      if (!movementLocked) {
        const left = Boolean(cursors?.left?.isDown || keyA?.isDown);
        const right = Boolean(cursors?.right?.isDown || keyD?.isDown);
        const up = Boolean(cursors?.up?.isDown || keyW?.isDown);
        const down = Boolean(cursors?.down?.isDown || keyS?.isDown);

        let vx = (right ? 1 : 0) - (left ? 1 : 0);
        let vy = (down ? 1 : 0) - (up ? 1 : 0);
        const usingKeyboard = vx !== 0 || vy !== 0;

        if (!usingKeyboard && pointerMoveActive) {
          const dx = pointerTargetX - player.x;
          const dy = pointerTargetY - player.y;
          const dist = Math.hypot(dx, dy);
          if (dist > 6) {
            vx = dx / dist;
            vy = dy / dist;
          } else {
            pointerMoveActive = false;
          }
        }

        if (vx !== 0 || vy !== 0) {
          const len = Math.hypot(vx, vy);
          const nx = vx / len;
          const ny = vy / len;
          player.x += ((PLAYER_SPEED * nx) / 1000) * delta;
          player.y += ((PLAYER_SPEED * ny) / 1000) * delta;
        }

        player.x = PhaserRef.Math.Clamp(player.x, 34, MAP_WIDTH - 34);
        player.y = PhaserRef.Math.Clamp(player.y, 34, MAP_HEIGHT - 34);
      }

      playerShadow.setPosition(player.x, player.y + 13);
      if (carryHalo) carryHalo.setPosition(player.x, player.y - 22);
      if (carryNode) carryNode.setPosition(player.x, player.y - 22);

      const nextStation = detectStation(player.x, player.y);
      if (nextStation !== state.station) {
        state.station = nextStation;
        onStationChange(nextStation);
        setHighlight(nextStation);
      }

      runStationAutomation();

      if (hintText) {
        hintText.setText(
          state.paused
            ? "Paused"
            : state.task
              ? `Counter prep running (${fDur(state.task.endsAt - state.minute)} left)`
              : state.station
                ? `Nearby: ${STATION_LABEL[state.station]}`
                : "Move near a station",
        );
      }

      clearDynamic(this);
      renderOverlayText();
    },
  };

  const game = new PhaserRef.Game({
    type: PhaserRef.AUTO,
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    parent,
    backgroundColor: "#78350f",
    scene,
    scale: {
      mode: PhaserRef.Scale.FIT,
      autoCenter: PhaserRef.Scale.CENTER_BOTH,
    },
  });

  return {
    game,
    destroy() {
      game.destroy(true);
    },
    setModalOpen(open: boolean) {
      modalOpen = open;
    },
    act(action: SceneAction) {
      applyAction(action);
    },
    getSnapshot() {
      return toSnapshot(state);
    },
  };
}

export function BakeryTycoonGame() {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const floorRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<SceneBridge | null>(null);

  const initialBestCash = useMemo(() => {
    if (typeof window === "undefined") return INITIAL_CASH;
    const saved = loadGameSave<{ bestCash?: number }>(GAME_SLUG);
    if (saved?.data && typeof saved.data.bestCash === "number") {
      return Math.max(INITIAL_CASH, saved.data.bestCash);
    }
    return INITIAL_CASH;
  }, []);

  const [modal, setModal] = useState<ModalState | null>(null);
  const [snapshot, setSnapshot] = useState<UiSnapshot>(() => toSnapshot(createInitialState(initialBestCash)));
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!floorRef.current) return;
    let cancelled = false;
    let localController: SceneBridge | null = null;

    const start = async () => {
      const phaserModule = await import("phaser");
      const PhaserRef = ("default" in phaserModule ? phaserModule.default : phaserModule) as PhaserRuntime;
      if (cancelled || !floorRef.current) return;

      localController = createBakeryTycoonScene({
        PhaserRef,
        parent: floorRef.current,
        initialBestCash,
        onStationChange: () => {
          if (cancelled) return;
        },
        onStationClick: (station, snap) => {
          if (cancelled) return;
          setModal({ station, snapshot: snap });
        },
        onSnapshot: (snap) => {
          if (cancelled) return;
          setSnapshot(snap);
          setModal((prev) => (prev ? { ...prev, snapshot: snap } : prev));
        },
        onBestCash: (bestCash) => {
          if (cancelled) return;
          saveGameSave(GAME_SLUG, GAME_TITLE, { bestCash });
        },
      });

      controllerRef.current = localController;
      setSnapshot(localController.getSnapshot());
    };

    void start();

    return () => {
      cancelled = true;
      localController?.destroy();
      controllerRef.current = null;
    };
  }, [initialBestCash]);

  useEffect(() => {
    controllerRef.current?.setModalOpen(Boolean(modal));
  }, [modal]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const syncFullscreen = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      setIsFullscreen(Boolean(document.fullscreenElement || doc.webkitFullscreenElement));
    };

    document.addEventListener("fullscreenchange", syncFullscreen);
    document.addEventListener("webkitfullscreenchange", syncFullscreen as EventListener);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
      document.removeEventListener("webkitfullscreenchange", syncFullscreen as EventListener);
    };
  }, []);

  const act = (action: SceneAction) => {
    controllerRef.current?.act(action);
  };

  const toggleFullscreen = async () => {
    const root = panelRef.current;
    if (!root || typeof document === "undefined") return;

    const doc = document as Document & {
      webkitExitFullscreen?: () => Promise<void> | void;
      webkitFullscreenElement?: Element | null;
    };
    const elem = root as HTMLDivElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
    };
    const active = Boolean(doc.fullscreenElement || doc.webkitFullscreenElement);

    try {
      if (active) {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if (doc.webkitExitFullscreen) {
          await doc.webkitExitFullscreen();
        }
        return;
      }

      if (elem.requestFullscreen) {
        await elem.requestFullscreen();
      } else if (elem.webkitRequestFullscreen) {
        await elem.webkitRequestFullscreen();
      }
    } catch {
      // no-op: browser denied fullscreen request
    }
  };

  const snap = modal?.snapshot ?? snapshot;

  return (
    <div ref={panelRef} className={styles.panel}>
      <header className={styles.toolbar}>
        <button type="button" className={styles.fullscreenBtn} onClick={() => void toggleFullscreen()}>
          {isFullscreen ? "전체화면 해제" : "전체화면"}
        </button>
      </header>

      <section className={styles.floorWrap}>
        <div ref={floorRef} className={styles.floorMount} />
      </section>

      {modal && (
        <section className={styles.modalOverlay} role="dialog" aria-modal="true">
          <article className={styles.modalCard}>
            <header className={styles.modalHeader}>
              <h3>{STATION_LABEL[modal.station]} Panel</h3>
              <button type="button" className={styles.modalClose} onClick={() => setModal(null)}>
                Close
              </button>
            </header>

            {modal.station === "fridge" && (
              <div className={styles.modalBody}>
                <label>Purchase amount: {snap.buyUnits} units</label>
                <input
                  className={styles.slider}
                  type="range"
                  min={10}
                  max={120}
                  step={5}
                  value={snap.buyUnits}
                  onChange={(e) => act({ type: "setBuyUnits", value: Number(e.currentTarget.value) })}
                />
                <p>Cost: {fMoney(snap.buyUnits * INGREDIENT_UNIT_COST)}</p>
                <p>Fridge stock: {snap.ingredientStock}/{snap.fridgeCapacity}</p>
                <button type="button" onClick={() => act({ type: "buyIngredients" })}>
                  Purchase ingredients
                </button>
              </div>
            )}

            {modal.station === "counter" && (
              <div className={styles.modalBody}>
                <label>Ingredient amount per bread: {snap.ingredientPerBread}</label>
                <input
                  className={styles.slider}
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={snap.ingredientPerBread}
                  onChange={(e) => act({ type: "setIngredient", value: Number(e.currentTarget.value) })}
                />
                <p>Per batch({BREADS_PER_BATCH} breads): {snap.ingredientPerBread * BREADS_PER_BATCH} units</p>
                <p>Counter status: {snap.prepActive ? `Working (${Math.round(snap.prepProgress * 100)}%)` : "Idle"}</p>
              </div>
            )}

            {modal.station === "oven" && (
              <div className={styles.modalBody}>
                <p>Tech level: Lv.{snap.techLevel}</p>
                <p>Tech remaining: {snap.techLevel > 0 ? fDur(snap.techLeft) : "inactive"}</p>
                <p>Ready breads: {snap.readyCount}</p>
                <p>Cost: {fMoney(snap.techCost)}</p>
                <button type="button" onClick={() => act({ type: "investTech" })}>
                  Develop tech
                </button>
              </div>
            )}

            {modal.station === "display" && (
              <div className={styles.modalBody}>
                <label>Bread price: {fMoney(snap.breadPrice)}</label>
                <input
                  className={styles.slider}
                  type="range"
                  min={3}
                  max={20}
                  step={1}
                  value={snap.breadPrice}
                  onChange={(e) => act({ type: "setPrice", value: Number(e.currentTarget.value) })}
                />
                <p>Display stock: {snap.displayCount}</p>
                <p>Expected new visitors/hour: {snap.firstVisitorRate.toFixed(1)}</p>
                <p>Expected repeat visitors/hour: {snap.repeatVisitorRate.toFixed(1)}</p>
              </div>
            )}

            {modal.station === "office" && (
              <div className={styles.modalBody}>
                <p>{snap.clock}</p>
                <p>Cash: {fMoney(snap.cash)} (Best {fMoney(snap.bestCash)})</p>
                <p>Store Lv.{snap.storeLevel} | Employees {snap.employees}/{snap.employeeCap}</p>
                <p>Marketing Lv.{snap.marketingLevel} ({snap.marketingLeft > 0 ? fDur(snap.marketingLeft) : "inactive"})</p>
                <p>Tech Lv.{snap.techLevel} ({snap.techLeft > 0 ? fDur(snap.techLeft) : "inactive"})</p>
                <div className={styles.actionGrid}>
                  <button type="button" onClick={() => act({ type: "investMarketing" })}>
                    Marketing {fMoney(snap.marketingCost)}
                  </button>
                  <button type="button" onClick={() => act({ type: "hire" })}>
                    Hire {fMoney(HIRE_COST)}
                  </button>
                  <button type="button" onClick={() => act({ type: "expand" })}>
                    Expand {fMoney(snap.expandCost)}
                  </button>
                  <button type="button" onClick={() => act({ type: "fire" })} disabled={snap.employees === 0}>
                    Fire
                  </button>
                  <button type="button" onClick={() => act({ type: "togglePause" })}>
                    {snap.paused ? "Resume" : "Pause"}
                  </button>
                  <button type="button" onClick={() => act({ type: "reset" })}>
                    Reset run
                  </button>
                </div>
              </div>
            )}
          </article>
        </section>
      )}
    </div>
  );
}
