export type ReviewStatus = "draft" | "pending" | "confirmed" | "changes";

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

export interface VersionSnapshot {
  id: string;
  label: string;
  createdAt: string;
  sourceText: string;
  targetText: string;
  status: ReviewStatus;
  terms: TermBinding[];
}

// 地名管理部门维护的条目：只管拼写、生效与废止。
export type PlaceNameStatus = "active" | "deprecated";

export interface PlaceNameEntry {
  id: string;
  standard: string; // 标准拼写
  aliases: string[]; // 其他写法（曾用拼写 / 异写）
  status: PlaceNameStatus; // 生效 / 废止
  effectiveAt: string; // 生效日期 ISO
  deprecatedAt?: string; // 废止日期 ISO
  updatedAt: string;
}

// 拼写表整包：地名管理部门下发的现行写法包。
export interface PlaceNamePackage {
  schema: 1;
  issuedAt: string;
  entries: PlaceNameEntry[];
}

// 标识校对台记录的对账差异：只列前后差异，不覆盖译文。
export type PlaceFindingKind = "spelling" | "deprecated";

export interface PlaceFinding {
  placeId: string;
  kind: PlaceFindingKind;
  found: string; // 译文中实际使用的写法
  standard: string; // 现行标准拼写
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
  comments: ReviewComment[];
  versions: VersionSnapshot[];
  emergencyRevision: boolean;
  placeRefs: string[]; // 引用的地名条目 id
  placeFindings: PlaceFinding[]; // 最近一次对账差异
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

export interface PersistedProject {
  schema: 1;
  project: SignProject;
}

export interface DiffToken {
  type: "same" | "add" | "remove";
  value: string;
}
