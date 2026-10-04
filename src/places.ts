import { uid } from "./data";
import type {
  AmbiguityIssue,
  PlaceEntry,
  PlaceRef,
  SignItem,
  SpellingChange,
  WorkspaceState,
} from "./types";

/* ---------------------------------- 通用 ---------------------------------- */

const nowIso = () => new Date().toISOString();

/** 拼写按地名部门的口径做大小写/空格归一，仅用于比对，不改原写法 */
export function normalizeSpelling(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

const issue = (
  source: AmbiguityIssue["source"],
  kind: AmbiguityIssue["kind"],
  message: string,
  details?: AmbiguityIssue["details"],
  signIds?: string[],
  placeIds?: string[],
): AmbiguityIssue => ({
  id: uid("amb"),
  source,
  kind,
  message,
  details,
  signIds,
  placeIds,
  createdAt: nowIso(),
  acknowledged: false,
});

/* ----------------------------- 拼写表整包解析 ----------------------------- */

export interface SheetRow {
  /** 地名条目 id；旧稿/增量表可空，空则按拼写/地名认领 */
  placeId?: string;
  /** 标准地名 */
  name?: string;
  /** 标准拼写 */
  spelling?: string;
  /** active | revoked */
  status?: string;
  effectiveAt?: string;
  revokedAt?: string;
  note?: string;
}

export interface SheetEnvelope {
  issuedAt?: string;
  source?: string;
  places?: SheetRow[];
  entries?: SheetRow[];
}

export interface ParsedSheet {
  rows: SheetRow[];
  issuedAt?: string;
  source?: string;
}

export class SheetParseError extends Error {}

function assertRow(condition: unknown, rowIndex: number, message: string): asserts condition {
  if (!condition) throw new SheetParseError(`第 ${rowIndex + 1} 行：${message}`);
}

function parseTsv(text: string): SheetRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) throw new SheetParseError("文件为空。");
  const header = lines[0].split("\t").map((cell) => cell.trim().toLocaleLowerCase());
  const col = (...names: string[]) => header.findIndex((cell) => names.includes(cell));
  const idx = {
    placeId: col("placeid", "id", "编号"),
    name: col("name", "地名", "名称"),
    spelling: col("spelling", "拼写", "标准拼写"),
    status: col("status", "状态"),
    effectiveAt: col("effectiveat", "生效时间"),
    revokedAt: col("revokedat", "废止时间"),
    note: col("note", "备注"),
  };
  if (idx.name < 0 || idx.spelling < 0) {
    throw new SheetParseError("TSV 表头需包含 name(地名) 与 spelling(拼写) 两列。");
  }
  return lines.slice(1).map((line, i) => {
    const cells = line.split("\t").map((cell) => cell.trim());
    const get = (index: number) => (index >= 0 ? (cells[index] ?? "") : "");
    return {
      placeId: get(idx.placeId) || undefined,
      name: get(idx.name),
      spelling: get(idx.spelling),
      status: get(idx.status) || undefined,
      effectiveAt: get(idx.effectiveAt) || undefined,
      revokedAt: get(idx.revokedAt) || undefined,
      note: get(idx.note) || undefined,
    };
  }).map((row, i) => validateRow(row, i));
}

function validateRow(row: SheetRow, rowIndex: number): SheetRow {
  const isRevoked = row.status === "revoked";
  assertRow(isRevoked || Boolean(row.spelling && row.spelling.trim()), rowIndex, "缺少拼写。");
  assertRow(
    !row.status || row.status === "active" || row.status === "revoked",
    rowIndex,
    `状态只能是 active 或 revoked，收到「${row.status}」。`,
  );
  // 废止行允许只给 placeId/地名 + status；新增/生效行必须能报出地名或编号。
  assertRow(isRevoked || Boolean(row.placeId || row.name), rowIndex, "缺少地名或条目编号。");
  assertRow(!isRevoked || Boolean(row.placeId || row.name || row.spelling), rowIndex, "废止行缺少可认领的地名信息。");
  return row;
}

/**
 * 整包解析：JSON（{places:[...]} 或裸数组）或 TSV。
 * 解析失败抛 SheetParseError —— 调用方整包不落地，可修正后重试。
 */
export function parseSpellingSheet(text: string): ParsedSheet {
  const trimmed = text.trim();
  if (!trimmed) throw new SheetParseError("内容为空。");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let envelope: SheetEnvelope | SheetRow[];
    try {
      envelope = JSON.parse(trimmed) as SheetEnvelope | SheetRow[];
    } catch (error) {
      throw new SheetParseError(`JSON 解析失败：${(error as Error).message}`);
    }
    if (Array.isArray(envelope)) {
      const rows = envelope.map((row, i) => validateRow({ ...row }, i));
      return { rows };
    }
    const rows = envelope.places ?? envelope.entries;
    if (!Array.isArray(rows)) {
      throw new SheetParseError("JSON 需包含 places（或 entries）数组。");
    }
    return {
      rows: rows.map((row, i) => validateRow({ ...row }, i)),
      issuedAt: envelope.issuedAt,
      source: envelope.source,
    };
  }
  return { rows: parseTsv(trimmed) };
}

/* ------------------------------- 地名条目匹配 ------------------------------ */

/** 按 id / 现行拼写 / 地名 找到唯一一个条目；命中多个返回 null 由调用方摆歧义 */
export function matchPlace(places: PlaceEntry[], row: SheetRow): { place?: PlaceEntry; ambiguous: PlaceEntry[] } {
  if (row.placeId) {
    return { place: places.find((p) => p.id === row.placeId), ambiguous: [] };
  }
  const byName = places.filter((p) => p.name === row.name);
  const spellingKey = normalizeSpelling(row.spelling ?? "");
  const bySpelling: PlaceEntry[] = [];
  for (const p of places) {
    const keys = [p.spelling, ...p.history.map((h) => h.spelling)].map(normalizeSpelling);
    if (keys.includes(spellingKey)) bySpelling.push(p);
  }
  const merged = new Map<string, PlaceEntry>();
  [...byName, ...bySpelling].forEach((p) => merged.set(p.id, p));
  const hits = [...merged.values()];
  if (hits.length === 1) return { place: hits[0], ambiguous: [] };
  if (hits.length > 1) return { ambiguous: hits };
  return { ambiguous: [] };
}

/* --------------------------------- 对账 ---------------------------------- */

export interface ReconcileReport {
  added: number;
  updated: number;
  revoked: number;
  returnedSigns: number;
  returnedSignIds: string[];
}

function openChangeFor(sign: SignItem, placeId: string): SpellingChange | undefined {
  return sign.spellingChanges.find((c) => c.placeId === placeId && c.status === "open");
}

/**
 * 按地名条目的现行写法对账所有标识：
 * - 引用拼写 ≠ 现行拼写（或地名被废止）：挂前后差异，牌子退回「需修改」；
 *   草稿（还没提交的译文）保留原状态，绝不被盖掉；
 * - 引用拼写已一致：自动核销该地名的待处理差异，其余差异原样保留。
 */
export function reconcileSigns(workspace: WorkspaceState): ReconcileReport {
  const report: ReconcileReport = { added: 0, updated: 0, revoked: 0, returnedSignIds: [], returnedSigns: 0 };
  for (const sign of workspace.project.signs) {
    for (const ref of sign.placeRefs) {
      const place = workspace.places.find((p) => p.id === ref.placeId);
      if (!place) continue;
      const existing = openChangeFor(sign, place.id);
      if (place.status === "revoked") {
        if (!existing) {
          sign.spellingChanges.unshift({
            id: uid("chg"),
            placeId: place.id,
            kind: "revoked",
            oldSpelling: ref.citedSpelling,
            newSpelling: "",
            status: "open",
            foundAt: nowIso(),
          });
          if (!report.returnedSignIds.includes(sign.id)) report.returnedSignIds.push(sign.id);
        }
        continue;
      }
      if (normalizeSpelling(ref.citedSpelling) === normalizeSpelling(place.spelling)) {
        // 牌子已是现行写法：核销待处理差异（其余地名的差异保留）。
        if (existing) {
          existing.status = "resolved";
          existing.resolvedAt = nowIso();
        }
        continue;
      }
      if (!existing) {
        sign.spellingChanges.unshift({
          id: uid("chg"),
          placeId: place.id,
          kind: "spelling",
          oldSpelling: ref.citedSpelling,
          newSpelling: place.spelling,
          status: "open",
          foundAt: nowIso(),
        });
      } else {
        // 现行写法又变了：差异以最新写法为准（退回记录保留）。
        existing.kind = "spelling";
        existing.newSpelling = place.spelling;
      }
      if (!report.returnedSignIds.includes(sign.id)) report.returnedSignIds.push(sign.id);
    }
  }
  for (const sign of workspace.project.signs) {
    if (!report.returnedSignIds.includes(sign.id)) continue;
    // 草稿是还没提交的译文：不自动改状态、不改内容，只把差异列给校对员。
    if (sign.status !== "draft") sign.status = "changes";
  }
  report.returnedSigns = report.returnedSignIds.length;
  return report;
}

/* --------------------------- 应用部门下发的拼写表 --------------------------- */

/**
 * 整包应用拼写表。调用前应先 parseSpellingSheet；
 * 解析失败的包不进这里，旧数据原样保留，可修正后重试。
 * 表内未出现的地名条目保持不动。
 */
export function applySpellingSheet(workspace: WorkspaceState, sheet: ParsedSheet): ReconcileReport {
  const report: ReconcileReport = { added: 0, updated: 0, revoked: 0, returnedSignIds: [], returnedSigns: 0 };
  const ambiguities = [...workspace.ambiguities];
  const at = sheet.issuedAt ?? nowIso();

  sheet.rows.forEach((row, rowIndex) => {
    const { place, ambiguous } = matchPlace(workspace.places, row);
    if (ambiguous.length) {
      ambiguities.push(
        issue(
          "sheet",
          "multi-place-match",
          `拼写表第 ${rowIndex + 1} 行「${row.name ?? ""} ${row.spelling ?? ""}」同时对上多个地名条目，未自动认领。`,
          {
            拼写: row.spelling ?? "",
            地名: row.name ?? "",
            候选条目: ambiguous.map((p) => `${p.name}（${p.spelling}）`),
          },
          undefined,
          ambiguous.map((p) => p.id),
        ),
      );
      return;
    }

    const targetStatus = row.status === "revoked" ? "revoked" : "active";

    if (!place) {
      // 新增地名条目（部门定 id 时沿用，否则本地补一个）。
      const entry: PlaceEntry = {
        id: row.placeId || uid("place"),
        name: (row.name ?? "").trim(),
        spelling: row.spelling!.trim(),
        status: targetStatus,
        effectiveAt: row.effectiveAt || at,
        revokedAt: targetStatus === "revoked" ? row.revokedAt || at : undefined,
        history: [{ spelling: row.spelling!.trim(), status: targetStatus, at: row.effectiveAt || at, note: row.note }],
      };
      workspace.places.push(entry);
      if (targetStatus === "revoked") report.revoked += 1;
      else report.added += 1;
      return;
    }

    if (targetStatus === "revoked") {
      if (place.status !== "revoked") {
        place.status = "revoked";
        place.revokedAt = row.revokedAt || at;
        place.history.push({ spelling: place.spelling, status: "revoked", at: place.revokedAt, note: row.note });
        report.revoked += 1;
      }
      return;
    }

    const newSpelling = row.spelling!.trim();
    if (place.status === "revoked") {
      // 部门重新启用：按一次新生效处理。
      place.status = "active";
      place.revokedAt = undefined;
      place.effectiveAt = row.effectiveAt || at;
    }
    if (row.name) place.name = row.name.trim();
    if (normalizeSpelling(newSpelling) !== normalizeSpelling(place.spelling)) {
      place.spelling = newSpelling;
      place.effectiveAt = row.effectiveAt || at;
      place.history.push({ spelling: newSpelling, status: "active", at: place.effectiveAt, note: row.note });
      report.updated += 1;
    }
  });

  workspace.ambiguities = ambiguities;
  const signReport = reconcileSigns(workspace);
  return {
    added: report.added,
    updated: report.updated,
    revoked: report.revoked,
    returnedSigns: signReport.returnedSigns,
    returnedSignIds: signReport.returnedSignIds,
  };
}

/* ------------------------- 地名管理侧的直接维护动作 ------------------------- */

/** 管理员改拼写：写历史并对账。生效/废止同样走这里。 */
export function updatePlaceSpelling(
  workspace: WorkspaceState,
  placeId: string,
  next: { name?: string; spelling?: string; status?: "active" | "revoked"; effectiveAt?: string },
): ReconcileReport | null {
  const place = workspace.places.find((p) => p.id === placeId);
  if (!place) return null;
  const at = nowIso();
  if (next.name && next.name.trim() !== place.name) place.name = next.name.trim();
  if (next.status === "revoked" && place.status !== "revoked") {
    place.status = "revoked";
    place.revokedAt = at;
    place.history.push({ spelling: place.spelling, status: "revoked", at });
  } else if (next.status === "active" && place.status === "revoked") {
    place.status = "active";
    place.revokedAt = undefined;
    place.effectiveAt = next.effectiveAt || at;
    place.history.push({ spelling: place.spelling, status: "active", at: place.effectiveAt });
  }
  if (next.spelling && normalizeSpelling(next.spelling) !== normalizeSpelling(place.spelling)) {
    place.spelling = next.spelling.trim();
    place.effectiveAt = next.effectiveAt || at;
    place.history.push({ spelling: place.spelling, status: place.status, at: place.effectiveAt });
  }
  return reconcileSigns(workspace);
}

export function addPlace(workspace: WorkspaceState, input: { name: string; spelling: string }): PlaceEntry {
  const entry: PlaceEntry = {
    id: uid("place"),
    name: input.name.trim(),
    spelling: input.spelling.trim(),
    status: "active",
    effectiveAt: nowIso(),
    history: [{ spelling: input.spelling.trim(), status: "active", at: nowIso() }],
  };
  workspace.places.push(entry);
  return entry;
}

/* --------------------------- 校对台侧：引用与处理差异 --------------------------- */

/** 牌子引用一个地名，记下引用时牌子上的写法；拼写权威仍在地名条目侧。 */
export function attachPlaceRef(sign: SignItem, place: PlaceEntry, citedSpelling?: string) {
  if (sign.placeRefs.some((ref) => ref.placeId === place.id)) return;
  sign.placeRefs.push({ id: uid("ref"), placeId: place.id, citedSpelling: (citedSpelling ?? place.spelling).trim() });
}

/** 校对员处理退回：把牌子改成现行写法并核销差异（只动这个牌子自己的译文）。 */
export function resolveChangeWithCurrent(sign: SignItem, changeId: string, places: PlaceEntry[]) {
  const change = sign.spellingChanges.find((c) => c.id === changeId);
  if (!change || change.status !== "open") return false;
  const ref = sign.placeRefs.find((r) => r.placeId === change.placeId);
  const place = places.find((p) => p.id === change.placeId);
  if (!ref || !place || place.status === "revoked") return false;
  if (change.oldSpelling && sign.targetText.includes(change.oldSpelling)) {
    sign.targetText = sign.targetText.split(change.oldSpelling).join(place.spelling);
  }
  ref.citedSpelling = place.spelling;
  change.status = "resolved";
  change.resolvedAt = nowIso();
  return true;
}

/** 校对员已自行改好，只核销差异、同步引用写法。 */
export function markChangeResolved(sign: SignItem, changeId: string, places: PlaceEntry[]) {
  const change = sign.spellingChanges.find((c) => c.id === changeId);
  if (!change || change.status !== "open") return false;
  const place = places.find((p) => p.id === change.placeId);
  if (!place || place.status === "revoked") return false;
  const ref = sign.placeRefs.find((r) => r.placeId === change.placeId);
  if (ref) ref.citedSpelling = place.spelling;
  change.status = "resolved";
  change.resolvedAt = nowIso();
  return true;
}

/* ---------------------------- 旧稿升级：按拼写认领 ---------------------------- */

const LEGACY_TEXT_FIELDS: (keyof Pick<SignItem, "sourceText" | "targetText" | "scenario">)[] = [
  "sourceText",
  "targetText",
  "scenario",
];

/**
 * 旧稿（schema 1，无 placeRefs）升级：
 * 按牌面出现过的拼写认领到地名条目；一个拼写对上多处、一个地名有多种写法，
 * 都不自动选边，先摆到 ambiguities。返回新的 workspace（原对象不改）。
 */
export function upgradeLegacyProject(
  signs: SignItem[],
  places: PlaceEntry[],
): { signs: SignItem[]; ambiguities: AmbiguityIssue[] } {
  const ambiguities: AmbiguityIssue[] = [];
  const upgraded = signs.map((sign) => {
    const next: SignItem = structuredClone({ ...sign, placeRefs: [] as PlaceRef[], spellingChanges: sign.spellingChanges ?? [] });
    const texts = new Set<string>();
    [...LEGACY_TEXT_FIELDS.map((f) => sign[f]), ...sign.terms.map((t) => t.target)].forEach((value) => texts.add(value));

    for (const place of places) {
      const variants = [...new Set([place.spelling, ...place.history.map((h) => h.spelling)])];
      const matchedVariants = variants.filter((variant) =>
        [...texts].some((text) => text.includes(variant)),
      );
      if (!matchedVariants.length) continue;

      if (matchedVariants.length > 1) {
        ambiguities.push(
          issue(
            "upgrade",
            "multi-spelling",
            `标识 ${sign.code} 里同一地名「${place.name}」出现多种写法，未自动认领。`,
            { 写法: matchedVariants },
            [sign.id],
            [place.id],
          ),
        );
        continue;
      }

      // 该拼写是否也出现在别的地名条目上？
      const variantKey = normalizeSpelling(matchedVariants[0]);
      const owners = places.filter((p) =>
        [p.spelling, ...p.history.map((h) => h.spelling)].map(normalizeSpelling).includes(variantKey),
      );
      if (owners.length > 1) {
        ambiguities.push(
          issue(
            "upgrade",
            "multi-place-match",
            `标识 ${sign.code} 的拼写「${matchedVariants[0]}」同时对上多个地名条目，未自动认领。`,
            {
              拼写: matchedVariants[0],
              候选条目: owners.map((p) => `${p.name}（${p.spelling}）`),
            },
            [sign.id],
            owners.map((p) => p.id),
          ),
        );
        continue;
      }

      attachPlaceRef(next, place, matchedVariants[0]);
    }
    return next;
  });

  return { signs: upgraded, ambiguities };
}

/** 歧义裁决后补登记引用（校对台可在歧义面板上手动认领）。 */
export function claimPlaceForSign(
  workspace: WorkspaceState,
  ambiguityId: string,
  placeId: string,
  citedSpelling: string,
) {
  const ambiguity = workspace.ambiguities.find((a) => a.id === ambiguityId);
  if (!ambiguity) return;
  const place = workspace.places.find((p) => p.id === placeId);
  const sign = workspace.project.signs.find((s) => s.id === ambiguity.signIds?.[0]);
  if (!place || !sign) return;
  attachPlaceRef(sign, place, citedSpelling);
  ambiguity.acknowledged = true;
  reconcileSigns(workspace);
}
