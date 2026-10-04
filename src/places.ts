import type {
  PlaceFinding,
  PlaceNameEntry,
  PlaceNamePackage,
  SignItem,
  SignProject,
} from "./types";

export const PLACES_STORAGE_KEY = "sologsb-1008-placenames-v1";

// ---------------------------------------------------------------------------
// 地名表种子：枢纽现行拼写。地名管理部门管拼写、生效与废止。
// id 固定，便于标识种子按 id 引用。
// ---------------------------------------------------------------------------
const place = (
  id: string,
  standard: string,
  aliases: string[],
  effectiveAt: string,
  status: PlaceNameEntry["status"] = "active",
  deprecatedAt?: string,
): PlaceNameEntry => ({
  id,
  standard,
  aliases,
  status,
  effectiveAt,
  deprecatedAt,
  updatedAt: effectiveAt,
});

export const SEED_PLACE_IDS = {
  binhaiStation: "place-binhai-station",
  yingbinRoad: "place-yingbin-road",
  ferryTerminal: "place-ferry-terminal",
} as const;

export const createSeedPlaceTable = (): PlaceNamePackage => ({
  schema: 1,
  issuedAt: "2026-09-01T00:00:00.000Z",
  entries: [
    place(SEED_PLACE_IDS.binhaiStation, "滨海站", [], "2019-12-01T00:00:00.000Z"),
    place(SEED_PLACE_IDS.yingbinRoad, "迎宾路", [], "2019-12-01T00:00:00.000Z"),
    place(SEED_PLACE_IDS.ferryTerminal, "滨海客运码头", ["滨海码头"], "2019-12-01T00:00:00.000Z"),
  ],
});

// ---------------------------------------------------------------------------
// 本地持久化：地名表与项目各存各的，互不覆盖。
// ---------------------------------------------------------------------------
export const loadPlaceTable = (): PlaceNamePackage => {
  const fallback = createSeedPlaceTable();
  try {
    const raw = localStorage.getItem(PLACES_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PlaceNamePackage>;
    if (parsed.schema !== 1 || !Array.isArray(parsed.entries)) return fallback;
    return { schema: 1, issuedAt: parsed.issuedAt ?? fallback.issuedAt, entries: parsed.entries };
  } catch {
    return fallback;
  }
};

export const savePlaceTable = (table: PlaceNamePackage) => {
  try {
    localStorage.setItem(PLACES_STORAGE_KEY, JSON.stringify(table));
  } catch {
    // 存储不可用时静默失败，不影响校对台工作。
  }
};

// ---------------------------------------------------------------------------
// 整包解析：失败时返回错误，调用方保留旧表与已退回标识，支持重试。
// ---------------------------------------------------------------------------
export type ImportResult =
  | { ok: true; table: PlaceNamePackage }
  | { ok: false; error: string };

export const parsePlacePackage = (text: string): ImportResult => {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "粘贴内容为空，请先填入拼写表 JSON。" };
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch (error) {
    return { ok: false, error: `JSON 解析失败：${(error as Error).message}` };
  }
  if (typeof data !== "object" || data === null) return { ok: false, error: "拼写表必须是 JSON 对象。" };
  const pkg = data as Record<string, unknown>;
  if (pkg.schema !== 1) return { ok: false, error: "无法识别的拼写表版本（schema 应为 1）。" };
  if (!Array.isArray(pkg.entries)) return { ok: false, error: "拼写表缺少 entries 数组。" };
  const entries: PlaceNameEntry[] = [];
  for (const [index, raw] of pkg.entries.entries()) {
    if (typeof raw !== "object" || raw === null) return { ok: false, error: `第 ${index + 1} 条地名字段无效。` };
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id.trim()) return { ok: false, error: `第 ${index + 1} 条地名缺少 id。` };
    if (typeof item.standard !== "string" || !item.standard.trim()) return { ok: false, error: `第 ${index + 1} 条地名缺少标准拼写。` };
    if (item.status !== "active" && item.status !== "deprecated") return { ok: false, error: `第 ${index + 1} 条地名状态无效。` };
    if (typeof item.effectiveAt !== "string") return { ok: false, error: `第 ${index + 1} 条地名缺少生效日期。` };
    entries.push({
      id: item.id,
      standard: item.standard,
      aliases: Array.isArray(item.aliases) ? item.aliases.filter((a): a is string => typeof a === "string") : [],
      status: item.status,
      effectiveAt: item.effectiveAt,
      deprecatedAt: typeof item.deprecatedAt === "string" ? item.deprecatedAt : undefined,
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : item.effectiveAt,
    });
  }
  return { ok: true, table: { schema: 1, issuedAt: typeof pkg.issuedAt === "string" ? pkg.issuedAt : new Date().toISOString(), entries } };
};

// ---------------------------------------------------------------------------
// 拼写匹配：找出文本中出现的标准拼写与其他写法。
// ---------------------------------------------------------------------------
const findOccurrences = (text: string, spelling: string): number[] => {
  const positions: number[] = [];
  if (!spelling) return positions;
  let cursor = 0;
  while (cursor < text.length) {
    const found = text.indexOf(spelling, cursor);
    if (found === -1) break;
    positions.push(found);
    cursor = found + spelling.length;
  }
  return positions;
};

export interface UsedSpelling {
  spelling: string;
  isStandard: boolean;
}

export const usedSpellings = (text: string, entry: PlaceNameEntry): UsedSpelling[] => {
  const standardPositions = findOccurrences(text, entry.standard);
  const standardRanges = standardPositions.map((pos) => [pos, pos + entry.standard.length] as const);
  const used: UsedSpelling[] = [];
  if (standardPositions.length) used.push({ spelling: entry.standard, isStandard: true });
  for (const alias of entry.aliases) {
    const positions = findOccurrences(text, alias);
    const standalone = positions.filter(
      (pos) => !standardRanges.some(([start, end]) => pos >= start && pos < end),
    );
    if (standalone.length) used.push({ spelling: alias, isStandard: false });
  }
  return used;
};

// ---------------------------------------------------------------------------
// 对账：按现行写法核对每条引用了地名的标识。
// 只记录前后差异、退回修改，绝不覆盖译文。
// ---------------------------------------------------------------------------
export interface ReconcileReport {
  returned: number;
  unchanged: number;
  total: number;
  results: { signId: string; signCode: string; findings: PlaceFinding[] }[];
}

export const reconcileProject = (project: SignProject, table: PlaceNamePackage): { project: SignProject; report: ReconcileReport } => {
  const draft = structuredClone(project);
  const entryMap = new Map(table.entries.map((entry) => [entry.id, entry]));
  const results: ReconcileReport["results"] = [];
  let returned = 0;

  for (const sign of draft.signs) {
    const findings: PlaceFinding[] = [];
    const text = `${sign.sourceText}\n${sign.targetText}`;
    for (const placeId of sign.placeRefs ?? []) {
      const entry = entryMap.get(placeId);
      if (!entry) continue;
      const used = usedSpellings(text, entry);
      if (!used.length) continue;
      if (entry.status === "deprecated") {
        findings.push({
          placeId,
          kind: "deprecated",
          found: used.find((u) => !u.isStandard)?.spelling ?? used[0].spelling,
          standard: entry.standard,
        });
      } else {
        for (const alias of used.filter((u) => !u.isStandard)) {
          findings.push({ placeId, kind: "spelling", found: alias.spelling, standard: entry.standard });
        }
      }
    }
    sign.placeFindings = findings;
    if (findings.length) {
      sign.status = "changes"; // 退回修改，译文原样保留
      returned += 1;
      results.push({ signId: sign.id, signCode: sign.code, findings });
    }
  }

  return {
    project: draft,
    report: { returned, unchanged: draft.signs.length - returned, total: draft.signs.length, results },
  };
};

// ---------------------------------------------------------------------------
// 旧稿升级：按拼写认领到地名条目。
// 一个拼写对上多处、或一个地名有多种写法时先摆出来，由人工确认。
// ---------------------------------------------------------------------------
export interface UpgradeClaim {
  signId: string;
  placeId: string;
  standard: string;
  found: string;
}

export interface AmbiguousSpelling {
  signId: string;
  signCode: string;
  spelling: string;
  matches: { placeId: string; standard: string }[];
}

export interface MultiSpelling {
  signId: string;
  signCode: string;
  placeId: string;
  standard: string;
  spellings: string[];
}

export interface UpgradeScan {
  autoClaims: UpgradeClaim[];
  ambiguousSpelling: AmbiguousSpelling[];
  multiSpelling: MultiSpelling[];
}

export const scanUpgrades = (signs: SignItem[], table: PlaceNamePackage): UpgradeScan => {
  const entryMap = new Map(table.entries.map((entry) => [entry.id, entry]));
  const autoClaims: UpgradeClaim[] = [];
  const ambiguousSpelling: AmbiguousSpelling[] = [];
  const multiSpelling: MultiSpelling[] = [];

  for (const sign of signs) {
    if ((sign.placeRefs ?? []).length) continue; // 已认领的旧稿不再扫描
    const text = `${sign.sourceText}\n${sign.targetText}`;
    const spellingToEntries = new Map<string, Set<string>>();
    const entryToSpellings = new Map<string, string[]>();

    for (const entry of table.entries) {
      const used = usedSpellings(text, entry);
      if (!used.length) continue;
      entryToSpellings.set(entry.id, used.map((u) => u.spelling));
      for (const item of used) {
        if (!spellingToEntries.has(item.spelling)) spellingToEntries.set(item.spelling, new Set());
        spellingToEntries.get(item.spelling)!.add(entry.id);
      }
    }

    if (!entryToSpellings.size) continue;

    for (const [spelling, ids] of spellingToEntries) {
      if (ids.size > 1) {
        ambiguousSpelling.push({
          signId: sign.id,
          signCode: sign.code,
          spelling,
          matches: [...ids].map((id) => ({ placeId: id, standard: entryMap.get(id)?.standard ?? id })),
        });
      }
    }

    for (const [placeId, spellings] of entryToSpellings) {
      if (spellings.length > 1) {
        multiSpelling.push({
          signId: sign.id,
          signCode: sign.code,
          placeId,
          standard: entryMap.get(placeId)?.standard ?? placeId,
          spellings,
        });
      }
      const ambiguous = spellings.some((spelling) => (spellingToEntries.get(spelling)?.size ?? 0) > 1);
      if (!ambiguous) {
        autoClaims.push({
          signId: sign.id,
          placeId,
          standard: entryMap.get(placeId)?.standard ?? placeId,
          found: spellings[0],
        });
      }
    }
  }

  return { autoClaims, ambiguousSpelling, multiSpelling };
};

// resolutions: key `${signId}::${spelling}` -> placeId 或 null(跳过)
export const applyUpgrades = (
  project: SignProject,
  scan: UpgradeScan,
  resolutions: Record<string, string | null>,
): SignProject => {
  const draft = structuredClone(project);
  const addRef = (signId: string, placeId: string) => {
    const sign = draft.signs.find((item) => item.id === signId);
    if (sign && !(sign.placeRefs ?? []).includes(placeId)) {
      sign.placeRefs = [...(sign.placeRefs ?? []), placeId];
    }
  };
  for (const claim of scan.autoClaims) addRef(claim.signId, claim.placeId);
  for (const amb of scan.ambiguousSpelling) {
    const placeId = resolutions[`${amb.signId}::${amb.spelling}`];
    if (placeId) addRef(amb.signId, placeId);
  }
  return draft;
};
