export type ReviewStatus = "draft" | "pending" | "confirmed" | "changes";

export type PlaceStatus = "active" | "revoked";

export interface PlaceEntry {
  id: string;
  /** 地名管理部门登记的地名，如「滨海中心站」 */
  name: string;
  /** 部门审定的现行标准拼写，如「Binhai Zhongxin Zhan」 */
  spelling: string;
  status: PlaceStatus;
  /** 部门通知的生效时间 */
  effectiveAt: string;
  /** 被废止的时间，仅在 status === "revoked" 时有意义 */
  revokedAt?: string;
  /** 历次审定拼写，便于审计；不参与现行对账 */
  history: { spelling: string; status: PlaceStatus; at: string; note?: string }[];
}

export interface Reply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  replies: Reply[];
}

export interface TermBinding {
  id: string;
  source: string;
  target: string;
  required: boolean;
  confirmed: boolean;
}

/** 校对台侧的地名引用：牌子只记「引用了哪个地名 + 牌子上的拼写 + 审校状态」 */
export interface PlaceRef {
  id: string;
  placeId: string;
  /** 牌子当前印的拼写（可能滞后于地名部门的现行拼写） */
  citedSpelling: string;
}

export type SpellingChangeKind = "spelling" | "revoked";
export type SpellingChangeStatus = "open" | "resolved";

/** 对账结果：引用到改动地名后，挂在标识上的前后差异 */
export interface SpellingChange {
  id: string;
  placeId: string;
  kind: SpellingChangeKind;
  /** 改动前（牌子上原印的写法） */
  oldSpelling: string;
  /** 改动后（地名部门的现行写法；废止时为空） */
  newSpelling: string;
  status: SpellingChangeStatus;
  /** 对账发现时间 */
  foundAt: string;
  resolvedAt?: string;
}

export interface VersionSnapshot {
  id: string;
  label: string;
  createdAt: string;
  sourceText: string;
  targetText: string;
  status: ReviewStatus;
  terms: TermBinding[];
}

export interface SignItem {
  id: string;
  code: string;
  sourceText: string;
  targetLanguage: string;
  targetText: string;
  scenario: string;
  regulation: string;
  status: ReviewStatus;
  terms: TermBinding[];
  /** 校对台登记的地名引用，拼写权威在地名条目侧 */
  placeRefs: PlaceRef[];
  /** 历次拼写表对账挂到牌子上的前后差异 */
  spellingChanges: SpellingChange[];
  comments: ReviewComment[];
  versions: VersionSnapshot[];
  emergencyRevision: boolean;
  updatedAt: string;
}

export interface SignProject {
  id: string;
  title: string;
  location: string;
  activeSignId: string;
  signs: SignItem[];
  updatedAt: string;
}

export type AmbiguitySource = "upgrade" | "sheet" | "claim";
export type AmbiguityKind = "multi-place-match" | "multi-spelling" | "unknown-place" | "sheet-row";

/** 认领/对账时摆出来待人工裁决的歧义，不自动选边 */
export interface AmbiguityIssue {
  id: string;
  source: AmbiguitySource;
  kind: AmbiguityKind;
  message: string;
  signIds?: string[];
  placeIds?: string[];
  /** 命中的拼写/写法等现场信息 */
  details?: Record<string, string | string[]>;
  createdAt: string;
  acknowledged: boolean;
}

/** 整个工作台状态：地名管理（places）与校对台（project）各管各的 */
export interface WorkspaceState {
  places: PlaceEntry[];
  project: SignProject;
  ambiguities: AmbiguityIssue[];
  /** 最近一次拼写表对账简报 */
  lastSheetReport?: {
    at: string;
    added: number;
    updated: number;
    revoked: number;
    returnedSigns: number;
    parseFailed?: boolean;
    error?: string;
  };
}

/** 旧版本地存档（升级前） */
export interface PersistedProjectV1 {
  schema: 1;
  project: SignProject;
}

export interface PersistedWorkspaceV2 {
  schema: 2;
  workspace: WorkspaceState;
}

export interface DiffToken {
  type: "same" | "add" | "remove";
  value: string;
}
