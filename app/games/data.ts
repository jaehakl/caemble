export type GameComponentKey =
  | "tap-race"
  | "memory-lights"
  | "tetris"
  | "roguelike-rpg"
  | "phaser-meteor-dodge"
  | "phaser-border-collie-roundup"
  | "bakery-tycoon"
  | "phaser-joseon-warfront"
  | "babylon-village-walk";

export type GameDefinition = {
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  difficulty: "Easy" | "Normal" | "Hard";
  estPlayMinutes: number;
  accent: string;
  component: GameComponentKey;
};

export const gameCatalog: GameDefinition[] = [
  {
    slug: "tap-race",
    title: "탭 레이스 10",
    summary: "10초 동안 화면을 최대한 빠르게 탭해서 최고 점수를 갱신하세요.",
    tags: ["reflex", "score-attack", "one-button"],
    difficulty: "Easy",
    estPlayMinutes: 1,
    accent: "#ef4444",
    component: "tap-race",
  },
  {
    slug: "memory-lights",
    title: "메모리 라이트",
    summary: "점점 길어지는 불빛 순서를 기억하고 정확히 따라 누르는 기억력 게임입니다.",
    tags: ["memory", "pattern", "simon-like"],
    difficulty: "Normal",
    estPlayMinutes: 3,
    accent: "#0ea5e9",
    component: "memory-lights",
  },
  {
    slug: "tetris",
    title: "픽셀 테트리스",
    summary: "블록을 회전하고 배치해 가로줄을 지우는 클래식 퍼즐 게임입니다.",
    tags: ["classic", "puzzle", "line-clear"],
    difficulty: "Normal",
    estPlayMinutes: 5,
    accent: "#f59e0b",
    component: "tetris",
  },
  {
    slug: "roguelike-rpg",
    title: "드리프트 로그",
    summary: "절차적으로 생성된 맵을 탐험하며 실시간 전투를 치르는 로그라이크 RPG입니다.",
    tags: ["roguelike", "rpg", "realtime-combat", "procedural-map"],
    difficulty: "Hard",
    estPlayMinutes: 10,
    accent: "#0f766e",
    component: "roguelike-rpg",
  },
  {
    slug: "phaser-meteor-dodge",
    title: "운석 피하기",
    summary: "좌우로 이동하며 떨어지는 운석을 피하고 오래 생존하는 Phaser 액션 게임입니다.",
    tags: ["phaser", "arcade", "dodge", "survival"],
    difficulty: "Easy",
    estPlayMinutes: 3,
    accent: "#2563eb",
    component: "phaser-meteor-dodge",
  },
  {
    slug: "phaser-border-collie-roundup",
    title: "보더콜리 양몰이",
    summary: "Babylon.js 3D 목장에서 보더콜리를 움직여 제한 시간 안에 모든 양을 우리(PEN)로 몰아넣으세요.",
    tags: ["babylonjs", "3d", "herding", "animal", "time-attack"],
    difficulty: "Normal",
    estPlayMinutes: 4,
    accent: "#ca8a04",
    component: "phaser-border-collie-roundup",
  },
  {
    slug: "bakery-tycoon",
    title: "빵집 경영 시뮬레이션",
    summary:
      "냉장고-조리대-오븐-진열대 동선을 운영하며 유통기한, 투자, 확장, 종업원 자동 생산까지 관리하는 경영 게임입니다.",
    tags: ["management", "simulation", "tycoon", "bakery", "economy"],
    difficulty: "Hard",
    estPlayMinutes: 12,
    accent: "#c2410c",
    component: "bakery-tycoon",
  },
  {
    slug: "phaser-joseon-warfront",
    title: "조선 전선",
    summary:
      "냉병기 시대 한반도를 배경으로 턴제 전략 지도에서 침공을 결정하고, 실시간 전투에서 주인공 검술과 부하 AI로 영토를 확장하는 전략 시뮬레이션입니다.",
    tags: ["phaser", "strategy", "simulation", "realtime-combat", "turn-based"],
    difficulty: "Hard",
    estPlayMinutes: 10,
    accent: "#b91c1c",
    component: "phaser-joseon-warfront",
  },
  {
    slug: "babylon-village-walk",
    title: "Babylon Village Walk",
    summary: "3차원 마을 지형을 걸어다니며 주요 명소를 찾아 완료 시간을 단축하는 Babylon.js 탐험 게임입니다.",
    tags: ["babylonjs", "3d", "exploration", "village", "time-attack"],
    difficulty: "Easy",
    estPlayMinutes: 4,
    accent: "#0f766e",
    component: "babylon-village-walk",
  },
];

export const allTags = Array.from(new Set(gameCatalog.flatMap((game) => game.tags))).sort();

export function getGameBySlug(slug: string) {
  return gameCatalog.find((game) => game.slug === slug);
}
