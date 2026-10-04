import { $, component$, useSignal, useVisibleTask$, type QRL } from "@builder.io/qwik";
import { type DocumentHead } from "@builder.io/qwik-city";
import { createSeedWorkspace, STATUS_LABELS, uid } from "../data";
import type {
  AmbiguityIssue,
  PersistedProjectV1,
  PersistedWorkspaceV2,
  PlaceEntry,
  ReviewStatus,
  SignItem,
  WorkspaceState,
} from "../types";
import { analyzeSign, cloneTerms, diffText } from "../utils";
import {
  SheetParseError,
  parseSpellingSheet,
  applySpellingSheet,
  reconcileSigns,
  updatePlaceSpelling,
  addPlace,
  attachPlaceRef,
  resolveChangeWithCurrent,
  markChangeResolved,
  upgradeLegacyProject,
  claimPlaceForSign,
  normalizeSpelling,
  type ReconcileReport,
} from "../places";

const STORAGE_KEY = "sologsb-1008-project-v1";
const WIDTHS = [320, 480, 720, 960] as const;

const SAMPLE_SHEET = `{
  "source": "市地名管理事务中心",
  "issuedAt": "2026-10-04T00:00:00.000Z",
  "places": [
    { "placeId": "place-yellow-river", "name": "黄河路", "spelling": "Huanghe Road", "status": "active" },
    { "placeId": "place-emerald-park", "name": "翠竹公园", "spelling": "Cuizhu Park", "status": "active" },
    { "placeId": "place-people-hospital", "name": "人民医院", "status": "revoked" }
  ]
}`;

export const head: DocumentHead = {
  title: "公共标识多语言校对台",
  meta: [
    { name: "description", content: "公共标识译文、术语、地名引用、版本和版面风险校对工作台" },
  ],
};

function statusClass(status: ReviewStatus) {
  if (status === "confirmed") return "badge-success";
  if (status === "changes") return "badge-error";
  if (status === "pending") return "badge-warning";
  return "badge-neutral";
}

const openChanges = (sign: SignItem) => sign.spellingChanges.filter((change) => change.status === "open");

export default component$(() => {
  const workspace = useSignal<WorkspaceState>(createSeedWorkspace());
  const past = useSignal<WorkspaceState[]>([]);
  const future = useSignal<WorkspaceState[]>([]);
  const hydrated = useSignal(false);
  const online = useSignal(true);
  const view = useSignal<"review" | "places">("review");
  const previewWidth = useSignal(480);
  const previewFont = useSignal(42);
  const selectedVersionId = useSignal("");
  const termSource = useSignal("");
  const termTarget = useSignal("");
  const commentDraft = useSignal("");
  const replyDraft = useSignal("");
  const replyingTo = useSignal("");
  const toast = useSignal("");
  const previewId = useSignal("");
  const readOnly = useSignal(false);
  const upgradeNote = useSignal("");

  // 地名管理侧的界面状态
  const newPlaceName = useSignal("");
  const newPlaceSpelling = useSignal("");
  const editingPlaceId = useSignal("");
  const editName = useSignal("");
  const editSpelling = useSignal("");
  const expandedPlaceId = useSignal("");
  const sheetText = useSignal("");
  const sheetError = useSignal("");
  const addRefPlaceId = useSignal("");

  const project = () => workspace.value.project;
  const places = () => workspace.value.places;
  const placeById = (id: string) => workspace.value.places.find((place) => place.id === id);
  const active = () =>
    project().signs.find((sign) => sign.id === (previewId.value || project().activeSignId)) ?? project().signs[0];

  const commit = $((label: string, update: (draft: WorkspaceState) => void) => {
    past.value = [...past.value.slice(-49), structuredClone(workspace.value)];
    future.value = [];
    const draft = structuredClone(workspace.value);
    update(draft);
    draft.project.updatedAt = new Date().toISOString();
    workspace.value = draft;
  });

  const updateActive = $((label: string, update: (sign: SignItem, draft: WorkspaceState) => void) => {
    commit(label, (draft) => {
      const sign = draft.project.signs.find((item) => item.id === draft.project.activeSignId);
      if (sign) update(sign, draft);
    });
  });

  const undo = $(() => {
    if (!past.value.length) return;
    const previous = past.value.at(-1)!;
    future.value = [structuredClone(workspace.value), ...future.value].slice(0, 50);
    past.value = past.value.slice(0, -1);
    workspace.value = previous;
    toast.value = "已撤销";
  });

  const redo = $(() => {
    if (!future.value.length) return;
    const next = future.value[0];
    past.value = [...past.value.slice(-49), structuredClone(workspace.value)];
    future.value = future.value.slice(1);
    workspace.value = next;
    toast.value = "已重做";
  });

  const navigateSign = $((direction: 1 | -1) => {
    if (readOnly.value) return;
    const signs = workspace.value.project.signs;
    const index = Math.max(0, signs.findIndex((sign) => sign.id === workspace.value.project.activeSignId));
    const nextSign = signs[(index + direction + signs.length) % signs.length];
    commit("切换标识", (draft) => { draft.project.activeSignId = nextSign.id; });
    selectedVersionId.value = "";
  });

  const setStatus = $((status: ReviewStatus) => {
    commit("更新审校状态", (draft) => {
      const sign = draft.project.signs.find((item) => item.id === draft.project.activeSignId);
      if (!sign) return;
      if (sign.emergencyRevision && status === "confirmed") {
        sign.status = "pending";
      } else {
        sign.status = status;
      }
    });
  });

  const toggleEmergency = $(() => {
    commit("切换紧急修订", (draft) => {
      const sign = draft.project.signs.find((item) => item.id === draft.project.activeSignId);
      if (!sign) return;
      sign.emergencyRevision = !sign.emergencyRevision;
      if (sign.emergencyRevision) sign.status = "changes";
    });
  });

  const saveVersion = $(() => {
    const sign = workspace.value.project.signs.find((item) => item.id === workspace.value.project.activeSignId);
    if (!sign) return;
    const versionId = uid("version");
    commit("保存版本快照", (draft) => {
      const current = draft.project.signs.find((item) => item.id === draft.project.activeSignId);
      if (!current) return;
      current.versions.unshift({
        id: versionId,
        label: `版本 ${current.versions.length + 1}`,
        createdAt: new Date().toISOString(),
        sourceText: current.sourceText,
        targetText: current.targetText,
        status: current.status,
        terms: cloneTerms(current.terms),
      });
      current.versions = current.versions.slice(0, 12);
    });
    selectedVersionId.value = versionId;
    toast.value = "版本快照已保存";
  });

  const addTerm = $(() => {
    const source = termSource.value.trim();
    const target = termTarget.value.trim();
    if (!source || !target) return;
    updateActive("绑定术语", (sign) => {
      sign.terms.push({ id: uid("term"), source, target, required: true, confirmed: false });
      sign.status = "pending";
    });
    termSource.value = "";
    termTarget.value = "";
  });

  const addComment = $(() => {
    const body = commentDraft.value.trim();
    if (!body) return;
    updateActive("添加审校意见", (sign) => {
      sign.comments.unshift({
        id: uid("comment"),
        author: "当前审校员",
        body,
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
      });
      sign.status = sign.status === "confirmed" ? "changes" : sign.status;
    });
    commentDraft.value = "";
  });

  const addReply = $((commentId: string) => {
    const body = replyDraft.value.trim();
    if (!body) return;
    updateActive("回复审校意见", (sign) => {
      const comment = sign.comments.find((item) => item.id === commentId);
      comment?.replies.push({ id: uid("reply"), author: "当前审校员", body, createdAt: new Date().toISOString() });
    });
    replyDraft.value = "";
    replyingTo.value = "";
  });

  /* --------------------------- 地名引用与对账退回处理 --------------------------- */

  const addRef = $(() => {
    const placeId = addRefPlaceId.value;
    if (!placeId) return;
    updateActive("登记地名引用", (sign, draft) => {
      const place = draft.places.find((item) => item.id === placeId);
      if (place) attachPlaceRef(sign, place);
    });
    addRefPlaceId.value = "";
  });

  const removeRef = $((refId: string) => {
    if (!refId) return;
    updateActive("移除地名引用", (sign) => {
      const ref = sign.placeRefs.find((item) => item.id === refId);
      sign.placeRefs = sign.placeRefs.filter((item) => item.id !== refId);
      if (ref) {
        // 引用没了，该地名挂着的退回差异一并关闭。
        for (const change of sign.spellingChanges) {
          if (change.placeId === ref.placeId && change.status === "open") {
            change.status = "resolved";
            change.resolvedAt = new Date().toISOString();
          }
        }
      }
    });
  });

  const applyCurrentSpelling = $((changeId: string) => {
    updateActive("按现行写法改正", (sign, draft) => {
      resolveChangeWithCurrent(sign, changeId, draft.places);
    });
  });

  const acknowledgeChange = $((changeId: string) => {
    updateActive("核销拼写差异", (sign, draft) => {
      markChangeResolved(sign, changeId, draft.places);
    });
  });

  const closeRevokedRef = $((placeId: string) => {
    updateActive("废止地名后移除引用", (sign) => {
      const refId = sign.placeRefs.find((ref) => ref.placeId === placeId)?.id;
      if (!refId) return;
      sign.placeRefs = sign.placeRefs.filter((ref) => ref.id !== refId);
      for (const change of sign.spellingChanges) {
        if (change.placeId === placeId && change.status === "open") {
          change.status = "resolved";
          change.resolvedAt = new Date().toISOString();
        }
      }
    });
  });

  /* ------------------------------- 地名管理动作 ------------------------------- */

  const createPlace = $(() => {
    const name = newPlaceName.value.trim();
    const spelling = newPlaceSpelling.value.trim();
    if (!name || !spelling) return;
    commit("新增地名条目", (draft) => addPlace(draft, { name, spelling }));
    newPlaceName.value = "";
    newPlaceSpelling.value = "";
    toast.value = "地名条目已登记";
  });

  const savePlaceEdit = $((placeId: string) => {
    let report!: ReconcileReport;
    commit("修改地名拼写并对账", (draft) => {
      const result = updatePlaceSpelling(draft, placeId, { name: editName.value, spelling: editSpelling.value });
      if (result) report = result;
    });
    editingPlaceId.value = "";
    if (report) toast.value = `已对账：${report.returnedSigns} 块标识引用了改动地名，已退回「需修改」`;
  });

  const togglePlaceStatus = $((placeId: string) => {
    const place = workspace.value.places.find((item) => item.id === placeId);
    if (!place) return;
    let report!: ReconcileReport;
    commit(place.status === "active" ? "废止地名" : "地名重新生效", (draft) => {
      const result = updatePlaceSpelling(draft, placeId, {
        status: place.status === "active" ? "revoked" : "active",
      });
      if (result) report = result;
    });
    if (report) toast.value = `已对账：${report.returnedSigns} 块标识受到影响`;
  });

  const runReconcile = $(() => {
    let report!: ReconcileReport;
    commit("按现行写法对账", (draft) => { report = reconcileSigns(draft); });
    toast.value = report.returnedSigns
      ? `对账完成：${report.returnedSigns} 块标识已退回「需修改」`
      : "对账完成：所有引用与现行写法一致";
  });

  const applySheet = $(() => {
    sheetError.value = "";
    // 先整包解析；失败就停在原地，输入框内容留着，可改完重试，旧数据一条不动。
    let sheet: ReturnType<typeof parseSpellingSheet>;
    try {
      sheet = parseSpellingSheet(sheetText.value);
    } catch (error) {
      sheetError.value = error instanceof SheetParseError ? error.message : `解析失败：${(error as Error).message}`;
      return;
    }
    let report!: ReconcileReport;
    commit("整包应用拼写表", (draft) => {
      report = applySpellingSheet(draft, sheet);
      draft.lastSheetReport = {
        at: new Date().toISOString(),
        added: report.added,
        updated: report.updated,
        revoked: report.revoked,
        returnedSigns: report.returnedSigns,
      };
    });
    sheetText.value = "";
    toast.value =
      `拼写表已整包生效：新增 ${report.added}、改拼 ${report.updated}、废止 ${report.revoked}；` +
      (report.returnedSigns
        ? `${report.returnedSigns} 块引用改动地名的标识已退回「需修改」（草稿未提交的不盖写）。`
        : "没有标识引用到改动地名。");
  });

  const resolveAmbiguity = $((ambiguityId: string, placeId: string, citedSpelling: string) => {
    commit("裁决认领歧义", (draft) => claimPlaceForSign(draft, ambiguityId, placeId, citedSpelling));
    toast.value = "已按裁决认领到地名条目";
  });

  const dismissAmbiguity = $((ambiguityId: string) => {
    commit("搁置歧义", (draft) => {
      const item = draft.ambiguities.find((ambiguity) => ambiguity.id === ambiguityId);
      if (item) item.acknowledged = true;
    });
  });

  const sharePreview: QRL<() => void> = $(() => {
    const current = workspace.value.project.signs.find((item) => item.id === workspace.value.project.activeSignId);
    if (!current) return;
    const url = `${window.location.origin}${window.location.pathname}?preview=${encodeURIComponent(current.id)}`;
    void navigator.clipboard?.writeText(url).catch(() => undefined);
    toast.value = "只读预览链接已复制";
  });

  const preview = () => analyzeSign(active(), previewWidth.value, previewFont.value);
  const selectedVersion = () => active().versions.find((version) => version.id === selectedVersionId.value) ?? active().versions[0];
  const comparison = () => {
    const version = selectedVersion();
    return version ? diffText(version.targetText, active().targetText) : [];
  };

  useVisibleTask$(({ track }) => {
    track(() => hydrated.value);
    if (!hydrated.value) {
      try {
        const raw = localStorage.getItem(STORAGE_KEY) ?? "";
        if (raw) {
          const stored = JSON.parse(raw) as
            | PersistedWorkspaceV2
            | PersistedProjectV1
            | { schema?: number; project?: WorkspaceState["project"]; workspace?: WorkspaceState };
          const v2 = "workspace" in stored && stored.schema === 2 ? (stored as PersistedWorkspaceV2) : undefined;
          if (v2?.workspace.project.signs.length) {
            // 补齐后续版本新增字段。
            const workspaceDraft = v2.workspace;
            for (const sign of workspaceDraft.project.signs) {
              sign.placeRefs ??= [];
              sign.spellingChanges ??= [];
            }
            workspaceDraft.ambiguities ??= [];
            workspace.value = workspaceDraft;
          } else if ("project" in stored && stored.schema !== 2 && stored.project?.signs?.length) {
            // 旧稿升级：地名条目与标识译文各归各位，按拼写认领引用。
            const legacyProject = stored.project;
            const seed = createSeedWorkspace();
            const legacySigns: SignItem[] = legacyProject.signs.map((sign) => ({
              ...sign,
              placeRefs: sign.placeRefs ?? [],
              spellingChanges: sign.spellingChanges ?? [],
            }));
            const { signs, ambiguities } = upgradeLegacyProject(legacySigns, seed.places);
            workspace.value = {
              places: seed.places,
              project: { ...legacyProject, signs },
              ambiguities,
            };
            upgradeNote.value = ambiguities.length
              ? `旧稿已升级：${ambiguities.length} 处拼写认领存在歧义，已摆到「地名管理」待人工裁决。`
              : "旧稿已升级为「地名条目 + 标识引用」两侧分管结构。";
          }
        }
        const requestedPreview = new URLSearchParams(window.location.search).get("preview") ?? "";
        previewId.value = requestedPreview;
        readOnly.value = Boolean(requestedPreview);
      } catch {
        // Keep bundled sample data when storage is unavailable or malformed.
      }
      hydrated.value = true;
    }
  });

  useVisibleTask$(({ track, cleanup }) => {
    track(() => hydrated.value);
    if (!hydrated.value) return;
    track(() => workspace.value);
    const timer = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ schema: 2, workspace: workspace.value }));
    }, 450);
    cleanup(() => window.clearTimeout(timer));
  });

  useVisibleTask$(({ cleanup }) => {
    const updateOnline = () => { online.value = navigator.onLine; };
    updateOnline();
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
      } else if (event.key.toLowerCase() === "j") {
        event.preventDefault();
        navigateSign(1);
      } else if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        navigateSign(-1);
      } else if (event.key === "[") {
        const index = WIDTHS.indexOf(previewWidth.value as (typeof WIDTHS)[number]);
        previewWidth.value = WIDTHS[Math.max(0, index - 1)];
      } else if (event.key === "]") {
        const index = WIDTHS.indexOf(previewWidth.value as (typeof WIDTHS)[number]);
        previewWidth.value = WIDTHS[Math.min(WIDTHS.length - 1, index + 1)];
      } else if (event.key === "-") {
        previewFont.value = Math.max(28, previewFont.value - 4);
      } else if (event.key === "=") {
        previewFont.value = Math.min(88, previewFont.value + 4);
      }
    };
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    window.addEventListener("keydown", keydown);
    cleanup(() => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
      window.removeEventListener("keydown", keydown);
    });
  });

  if (readOnly.value) {
    const sign = active();
    const analysis = analyzeSign(sign, previewWidth.value, previewFont.value);
    return (
      <main data-theme="corporate" class="min-h-screen bg-slate-100 p-6">
        <div class="mx-auto max-w-5xl">
          <div class="mb-4 flex items-center justify-between">
            <div>
              <div class="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Read-only preview</div>
              <h1 class="text-2xl font-bold text-slate-800">{sign.code} · {sign.scenario}</h1>
            </div>
            <span class={`badge ${statusClass(sign.status)}`}>{STATUS_LABELS[sign.status]}</span>
          </div>
          <section class="rounded-3xl bg-white p-14 shadow-xl">
            <div class="mb-3 text-center text-xs text-slate-400">中文原文</div>
            <p class="mx-auto mb-10 max-w-2xl text-center text-lg text-slate-600">{sign.sourceText}</p>
            <div class="mx-auto border-y-4 border-slate-800 py-10 text-center">
              <p class="whitespace-pre-line font-black leading-tight tracking-wide text-slate-900" style={{ fontSize: `${previewFont.value}px` }}>{analysis.visible.join("\n")}</p>
            </div>
            <div class="mt-5 text-center text-sm text-slate-500">{sign.targetLanguage} · {sign.regulation}</div>
          </section>
          <p class="mt-4 text-center text-xs text-slate-400">此链接读取当前浏览器中的本地版本，仅用于演示只读预览。</p>
        </div>
      </main>
    );
  }

  const pendingAmbiguities = () => workspace.value.ambiguities.filter((item) => !item.acknowledged);
  const availablePlacesForRef = () => places().filter((place) => !active().placeRefs.some((ref) => ref.placeId === place.id));

  const renderAmbiguity = (ambiguity: AmbiguityIssue) => {
    const sign = ambiguity.signIds?.map((id) => project().signs.find((item) => item.id === id)).find(Boolean);
    const variants = (ambiguity.details?.写法 ?? []) as string[];
    const candidateIds = ambiguity.placeIds ?? [];
    const spellingHint = (ambiguity.details?.拼写 ?? "") as string;
    return (
      <article key={ambiguity.id} class="rounded-xl border-l-4 border-warning bg-amber-50 p-3 text-sm">
        <div class="flex items-start justify-between gap-3">
          <p class="font-semibold text-amber-900">{ambiguity.message}</p>
          <button class="btn btn-xs btn-ghost shrink-0" onClick$={() => dismissAmbiguity(ambiguity.id)}>已知晓，搁置</button>
        </div>
        {sign && <p class="mt-1 text-xs text-slate-500">涉及标识：{sign.code} · {sign.scenario}</p>}
        <div class="mt-2 flex flex-wrap gap-2">
          {ambiguity.kind === "multi-spelling" && candidateIds[0] && variants.map((variant) => (
            <button key={variant} class="btn btn-xs btn-outline btn-warning" onClick$={() => resolveAmbiguity(ambiguity.id, candidateIds[0], variant)}>
              认领为「{placeById(candidateIds[0])?.name}」· 牌面写法 {variant}
            </button>
          ))}
          {ambiguity.kind === "multi-place-match" && candidateIds.map((id) => (
            <button key={id} class="btn btn-xs btn-outline btn-warning" onClick$={() => resolveAmbiguity(ambiguity.id, id, spellingHint)}>
              认领到「{placeById(id)?.name}（{placeById(id)?.spelling}）」
            </button>
          ))}
        </div>
      </article>
    );
  };

  const renderPlacesView = () => (
    <div class="mx-auto max-w-6xl space-y-5 p-6">
      <div class="flex items-end justify-between">
        <div>
          <div class="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">Place Registry</div>
          <h1 class="text-2xl font-bold text-slate-800">地名管理</h1>
          <p class="mt-1 text-sm text-slate-500">地名条目的拼写、生效与废止只在这里维护；校对台只登记牌子引用了谁、引用时是什么写法。</p>
        </div>
        <button class="btn btn-outline" onClick$={runReconcile}>按现行写法重新对账</button>
      </div>

      {pendingAmbiguities().length > 0 && (
        <section class="card border border-amber-300 bg-white shadow-sm">
          <div class="card-body p-5">
            <div class="flex items-center justify-between">
              <h2 class="font-bold text-amber-800">待裁决的认领歧义（{pendingAmbiguities().length}）</h2>
              <span class="badge badge-warning">一个拼写对上多处 / 一个地名有多种写法</span>
            </div>
            <div class="mt-3 space-y-3">{pendingAmbiguities().map(renderAmbiguity)}</div>
          </div>
        </section>
      )}

      {workspace.value.lastSheetReport && (
        <section class="card border border-slate-200 bg-white shadow-sm">
          <div class="card-body p-5">
            <h2 class="font-bold">最近一次拼写表对账</h2>
            <div class="mt-3 grid grid-cols-5 gap-2 text-center text-sm">
              <div class="rounded-lg bg-slate-100 p-3"><strong class="block text-xl">{workspace.value.lastSheetReport.added}</strong><span class="text-xs">新增条目</span></div>
              <div class="rounded-lg bg-slate-100 p-3"><strong class="block text-xl">{workspace.value.lastSheetReport.updated}</strong><span class="text-xs">拼写改动</span></div>
              <div class="rounded-lg bg-slate-100 p-3"><strong class="block text-xl">{workspace.value.lastSheetReport.revoked}</strong><span class="text-xs">废止</span></div>
              <div class="rounded-lg bg-red-50 p-3"><strong class="block text-xl text-red-700">{workspace.value.lastSheetReport.returnedSigns}</strong><span class="text-xs">退回标识</span></div>
              <div class="rounded-lg bg-slate-100 p-3"><strong class="block text-xs">{new Date(workspace.value.lastSheetReport.at).toLocaleString()}</strong><span class="text-xs">下发时间</span></div>
            </div>
          </div>
        </section>
      )}

      <section class="card border border-slate-200 bg-white shadow-sm">
        <div class="card-body p-5">
          <div class="flex items-center justify-between">
            <div>
              <h2 class="font-bold">整包导入拼写表</h2>
              <p class="text-xs text-slate-500">支持 JSON（{`{places:[{placeId,name,spelling,status}]}`}）或 TSV（表头含 name、spelling）。整包解析失败时不落地任何改动，改完可重试，已退回的标识原样保留。</p>
            </div>
            <button class="btn btn-xs btn-ghost" onClick$={() => { sheetText.value = SAMPLE_SHEET; sheetError.value = ""; }}>填入示例</button>
          </div>
          <textarea
            class="textarea textarea-bordered mt-3 min-h-40 w-full font-mono text-xs leading-5"
            placeholder="粘贴地名管理部门下发的整包拼写表…"
            value={sheetText.value}
            onInput$={(_, element) => sheetText.value = element.value}
          />
          {sheetError.value && (
            <div class="alert alert-error mt-3 py-2 text-xs">
              <span>整包未被接收：{sheetError.value}</span>
            </div>
          )}
          <div class="mt-3 flex justify-end">
            <button class="btn btn-primary" disabled={!sheetText.value.trim()} onClick$={applySheet}>整包解析并生效、对账</button>
          </div>
        </div>
      </section>

      <section class="card border border-slate-200 bg-white shadow-sm">
        <div class="card-body p-5">
          <h2 class="font-bold">地名条目（{places().length}）</h2>
          <div class="mt-4 space-y-3">
            {places().map((place) => {
              const referencedBy = project().signs.filter((sign) => sign.placeRefs.some((ref) => ref.placeId === place.id));
              const isEditing = editingPlaceId.value === place.id;
              const isExpanded = expandedPlaceId.value === place.id;
              return (
                <div key={place.id} class="rounded-xl border border-slate-200 p-4">
                  {isEditing ? (
                    <div class="grid grid-cols-[1fr_1fr_auto] gap-2">
                      <input class="input input-sm input-bordered" value={editName.value} onInput$={(_, el) => (editName.value = el.value)} aria-label="地名" />
                      <input class="input input-sm input-bordered font-mono" value={editSpelling.value} onInput$={(_, el) => (editSpelling.value = el.value)} aria-label="标准拼写" />
                      <div class="flex gap-1">
                        <button class="btn btn-sm btn-primary" onClick$={() => savePlaceEdit(place.id)}>保存并对账</button>
                        <button class="btn btn-sm btn-ghost" onClick$={() => (editingPlaceId.value = "")}>取消</button>
                      </div>
                    </div>
                  ) : (
                    <div class="flex flex-wrap items-center gap-3">
                      <div class="min-w-56 flex-1">
                        <div class="font-bold">{place.name}</div>
                        <div class="font-mono text-sm text-slate-600">{place.spelling}</div>
                      </div>
                      <span class={`badge badge-sm ${place.status === "active" ? "badge-success" : "badge-error"}`}>
                        {place.status === "active" ? "现行有效" : "已废止"}
                      </span>
                      <span class="text-xs text-slate-400">{referencedBy.length} 块牌子引用 · 生效 {new Date(place.effectiveAt).toLocaleDateString()}</span>
                      <div class="flex gap-1">
                        <button
                          class="btn btn-xs btn-ghost"
                          onClick$={() => { editingPlaceId.value = place.id; editName.value = place.name; editSpelling.value = place.spelling; }}
                        >改拼写</button>
                        <button class={`btn btn-xs ${place.status === "active" ? "btn-error btn-outline" : "btn-success btn-outline"}`} onClick$={() => togglePlaceStatus(place.id)}>
                          {place.status === "active" ? "废止" : "重新生效"}
                        </button>
                        <button class="btn btn-xs btn-ghost" onClick$={() => (expandedPlaceId.value = isExpanded ? "" : place.id)}>
                          {isExpanded ? "收起历史" : `历史 ${place.history.length}`}
                        </button>
                      </div>
                    </div>
                  )}
                  {isExpanded && (
                    <ul class="mt-3 space-y-1 border-t border-slate-100 pt-2 text-xs text-slate-500">
                      {[...place.history].reverse().map((record, index) => (
                        <li key={index} class="flex justify-between font-mono">
                          <span>{record.spelling}</span>
                          <span>{record.status === "revoked" ? "废止" : "生效"} · {new Date(record.at).toLocaleString()}{record.note ? ` · ${record.note}` : ""}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
          <div class="mt-4 grid grid-cols-[1fr_1fr_auto] gap-2 border-t border-slate-100 pt-4">
            <input class="input input-sm input-bordered" placeholder="新地名，如「临海路」" value={newPlaceName.value} onInput$={(_, el) => (newPlaceName.value = el.value)} />
            <input class="input input-sm input-bordered font-mono" placeholder="部门审定拼写，如「Linhai Lu」" value={newPlaceSpelling.value} onInput$={(_, el) => (newPlaceSpelling.value = el.value)} />
            <button class="btn btn-sm btn-primary" onClick$={createPlace}>登记地名</button>
          </div>
        </div>
      </section>
    </div>
  );

  const renderReviewView = () => (
    <div class="grid min-h-[calc(100vh-64px)] grid-cols-[270px_minmax(560px,1fr)_430px] gap-px bg-slate-300">
      <aside class="overflow-y-auto bg-slate-50 p-3">
        <div class="mb-3 rounded-xl bg-white p-4 shadow-sm">
          <div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">标识清单</div>
          <div class="mt-1 text-lg font-bold text-slate-800">{project().signs.length} 处标识</div>
          <p class="mt-1 text-xs leading-5 text-slate-500">{project().location}</p>
        </div>
        <div class="space-y-2">
          {project().signs.map((sign, index) => {
            const risk = analyzeSign(sign, previewWidth.value, previewFont.value);
            const changes = openChanges(sign);
            return (
              <button
                key={sign.id}
                class={`w-full rounded-xl border p-3 text-left transition ${sign.id === project().activeSignId ? "border-blue-400 bg-blue-50 shadow-sm" : "border-slate-200 bg-white hover:border-slate-300"}`}
                onClick$={() => {
                  commit("切换标识", (draft) => { draft.project.activeSignId = sign.id; });
                  selectedVersionId.value = "";
                }}
              >
                <div class="flex items-center justify-between">
                  <span class="font-mono text-xs font-bold text-slate-500">{sign.code}</span>
                  <span class={`badge badge-sm ${statusClass(sign.status)}`}>{STATUS_LABELS[sign.status]}</span>
                </div>
                <div class="mt-2 line-clamp-2 text-sm font-semibold text-slate-700">{sign.sourceText}</div>
                <div class="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                  <span>{sign.targetLanguage}</span>
                  <span class={risk.risk === "high" ? "font-bold text-error" : risk.risk === "medium" ? "font-bold text-warning" : "text-success"}>
                    {risk.risk === "high" ? "高风险" : risk.risk === "medium" ? "需留意" : "版面正常"}
                  </span>
                </div>
                {changes.length > 0 && (
                  <div class="badge badge-error badge-sm mt-2 gap-1">地名退回 ×{changes.length}</div>
                )}
                <span class="sr-only">第 {index + 1} 条</span>
              </button>
            );
          })}
        </div>
      </aside>

      <main class="min-w-0 bg-white">
        <div class="border-b border-slate-200 bg-slate-50 px-6 py-4">
          <div class="flex items-start justify-between gap-5">
            <div>
              <div class="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">{active().code} · {active().scenario}</div>
              <h1 class="mt-1 text-xl font-bold">中文原文与译文校对</h1>
            </div>
            <div class="join">
              {(["draft", "pending", "changes", "confirmed"] as ReviewStatus[]).map((status) => (
                <button key={status} class={`btn join-item btn-sm ${active().status === status ? "btn-primary" : "btn-outline"}`} onClick$={() => setStatus(status)}>{STATUS_LABELS[status]}</button>
              ))}
            </div>
          </div>
        </div>

        <div class="space-y-5 p-6">
          {active().status === "draft" && openChanges(active()).length > 0 && (
            <div class="alert alert-warning py-2 text-xs">
              该译文还是草稿、尚未提交，对账只把拼写差异列在这里，不会盖写内容，也不改变状态。
            </div>
          )}

          <section class="card border border-slate-200 bg-white shadow-sm">
            <div class="card-body gap-4 p-5">
              <div class="flex items-center justify-between">
                <div><div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Source</div><h2 class="font-bold">中文原文</h2></div>
                <span class="badge badge-ghost">简体中文</span>
              </div>
              <textarea
                class="textarea textarea-bordered min-h-24 w-full text-base leading-7"
                value={active().sourceText}
                onInput$={(_, element) => updateActive("修改中文原文", (sign) => { sign.sourceText = element.value; sign.status = "draft"; })}
              />
            </div>
          </section>

          <section class="card border border-slate-200 bg-white shadow-sm">
            <div class="card-body gap-4 p-5">
              <div class="grid grid-cols-2 gap-4">
                <label class="form-control">
                  <span class="label-text mb-1 text-xs font-bold text-slate-500">目标语言</span>
                  <select class="select select-bordered" value={active().targetLanguage} onChange$={(_, element) => updateActive("修改目标语言", (sign) => { sign.targetLanguage = element.value; sign.status = "pending"; })}>
                    {["English", "日本語", "Français", "Deutsch", "한국어", "Español"].map((language) => <option key={language}>{language}</option>)}
                  </select>
                </label>
                <label class="form-control">
                  <span class="label-text mb-1 text-xs font-bold text-slate-500">适用场景</span>
                  <input class="input input-bordered" value={active().scenario} onInput$={(_, element) => updateActive("修改适用场景", (sign) => { sign.scenario = element.value; })} />
                </label>
              </div>
              <label class="form-control">
                <span class="label-text mb-1 text-xs font-bold text-slate-500">法规或规范提示</span>
                <input class="input input-bordered" value={active().regulation} onInput$={(_, element) => updateActive("修改法规提示", (sign) => { sign.regulation = element.value; })} />
              </label>
              <div class="divider my-0"></div>
              <div class="flex items-center justify-between">
                <div><div class="text-xs font-bold uppercase tracking-[0.16em] text-blue-500">Target</div><h2 class="font-bold">目标语言译文</h2></div>
                <button class="btn btn-sm btn-outline" onClick$={saveVersion}>保存版本快照</button>
              </div>
              <textarea
                class="textarea textarea-bordered min-h-36 w-full text-lg leading-8"
                value={active().targetText}
                onInput$={(_, element) => updateActive("修改译文", (sign) => { sign.targetText = element.value; sign.status = sign.emergencyRevision ? "changes" : "pending"; })}
              />
              <div class="flex flex-wrap gap-2">
                {active().terms.map((termItem) => {
                  const matched = active().targetText.toLocaleLowerCase().includes(termItem.target.toLocaleLowerCase());
                  return (
                    <button
                      key={termItem.id}
                      title="点击切换术语确认状态"
                      class={`badge badge-lg gap-1 ${matched && termItem.confirmed ? "badge-success" : matched ? "badge-warning" : "badge-error"}`}
                      onClick$={() => updateActive("确认术语", (sign) => {
                        const current = sign.terms.find((item) => item.id === termItem.id);
                        if (current) current.confirmed = !current.confirmed;
                      })}
                    >
                      {termItem.source} → {termItem.target} {matched ? (termItem.confirmed ? "✓" : "!") : "×"}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          <section class="card border border-slate-200 bg-white shadow-sm">
            <div class="card-body p-5">
              <div class="flex items-center justify-between">
                <div>
                  <h2 class="font-bold">地名引用</h2>
                  <p class="text-xs text-slate-500">校对台只登记牌子引用了哪些地名、引用时牌面写法是什么；拼写的权威在「地名管理」侧。</p>
                </div>
                <span class="badge badge-outline">{active().placeRefs.length} 处引用</span>
              </div>
              <div class="mt-3 space-y-2">
                {active().placeRefs.length === 0 && <div class="rounded-xl border border-dashed p-4 text-center text-xs text-slate-400">这块牌子还没有引用地名条目。</div>}
                {active().placeRefs.map((ref) => {
                  const place = placeById(ref.placeId);
                  if (!place) {
                    return (
                      <div key={ref.id} class="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm">
                        <span class="text-red-700">引用的地名条目已不存在（{ref.placeId}）</span>
                        <button class="btn btn-xs btn-ghost text-error" onClick$={() => removeRef(ref.id)}>移除引用</button>
                      </div>
                    );
                  }
                  const same = place.status === "active" && normalizeSpelling(ref.citedSpelling) === normalizeSpelling(place.spelling);
                  return (
                    <div key={ref.id} class="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                      <div class="min-w-40 flex-1">
                        <div class="font-bold">{place.name}</div>
                        <div class="font-mono text-xs text-slate-500">牌面：{ref.citedSpelling}</div>
                      </div>
                      {place.status === "revoked" ? (
                        <span class="badge badge-error badge-sm">地名已废止</span>
                      ) : same ? (
                        <span class="badge badge-success badge-sm">与现行一致</span>
                      ) : (
                        <div class="text-xs">
                          <span class="badge badge-error badge-sm mr-2">写法已改动</span>
                          <span class="font-mono text-slate-500">现行：{place.spelling}</span>
                        </div>
                      )}
                      <button class="btn btn-xs btn-ghost text-error" onClick$={() => removeRef(ref.id)}>移除引用</button>
                    </div>
                  );
                })}
              </div>
              {availablePlacesForRef().length > 0 && (
                <div class="mt-3 grid grid-cols-[1fr_auto] gap-2">
                  <select class="select select-sm select-bordered" value={addRefPlaceId.value} onChange$={(_, el) => (addRefPlaceId.value = el.value)}>
                    <option value="">选择要登记引用的地名…</option>
                    {availablePlacesForRef().map((place: PlaceEntry) => (
                      <option key={place.id} value={place.id}>{`${place.name}（${place.status === "active" ? place.spelling : "已废止"}）`}</option>
                    ))}
                  </select>
                  <button class="btn btn-sm btn-primary" disabled={!addRefPlaceId.value} onClick$={addRef}>登记引用</button>
                </div>
              )}
            </div>
          </section>

          <section class="card border border-slate-200 bg-white shadow-sm">
            <div class="card-body p-5">
              <div class="flex items-center justify-between">
                <div>
                  <h2 class="font-bold">拼写差异（对账退回）</h2>
                  <p class="text-xs text-slate-500">地名部门改了拼写后，引用到该地名的标识在这里列前后差异并退回「需修改」；处理完一处核销一处。</p>
                </div>
                <span class="badge badge-outline">{openChanges(active()).length} 条待处理</span>
              </div>
              <div class="mt-3 space-y-2">
                {active().spellingChanges.length === 0 && <div class="rounded-xl border border-dashed p-4 text-center text-xs text-slate-400">还没有对账差异。</div>}
                {active().spellingChanges.map((change) => {
                  const place = placeById(change.placeId);
                  return (
                    <div key={change.id} class={`rounded-lg border px-3 py-2 text-sm ${change.status === "open" ? "border-red-300 bg-red-50" : "border-slate-200 bg-slate-50 opacity-70"}`}>
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="font-bold">{place?.name ?? "未知地名"}</span>
                        <span class={`badge badge-xs ${change.status === "open" ? "badge-error" : "badge-ghost"}`}>{change.status === "open" ? "待修改" : "已核销"}</span>
                        <span class="text-xs text-slate-400">{new Date(change.foundAt).toLocaleString()}</span>
                      </div>
                      {change.kind === "revoked" ? (
                        <p class="mt-1 text-red-700">该地名已被地名管理部门废止，原牌面写法「{change.oldSpelling}」不得继续使用，请改写或移除引用。</p>
                      ) : (
                        <p class="mt-1 font-mono text-xs">
                          <span class="text-red-700 line-through">{change.oldSpelling}</span>
                          <span class="mx-2">→</span>
                          <span class="text-green-700">{change.newSpelling}</span>
                        </p>
                      )}
                      {change.status === "open" && (
                        <div class="mt-2 flex flex-wrap gap-2">
                          {change.kind === "spelling" && (
                            <button class="btn btn-xs btn-primary" onClick$={() => applyCurrentSpelling(change.id)}>按现行写法改正并核销</button>
                          )}
                          {change.kind === "spelling" && (
                            <button class="btn btn-xs btn-outline" onClick$={() => acknowledgeChange(change.id)}>我已自行改好，核销</button>
                          )}
                          {change.kind === "revoked" && (
                            <button class="btn btn-xs btn-error btn-outline" onClick$={() => closeRevokedRef(change.placeId)}>移除引用并关闭</button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <section class="card border border-slate-200 bg-white shadow-sm">
            <div class="card-body p-5">
              <div class="flex items-center justify-between">
                <div><h2 class="font-bold">术语绑定</h2><p class="text-xs text-slate-500">必选术语未出现在译文中时会实时告警。</p></div>
                <span class="badge badge-outline">{active().terms.length} 条</span>
              </div>
              <div class="mt-4 grid grid-cols-[1fr_1fr_auto] gap-2">
                <input class="input input-sm input-bordered" placeholder="中文术语" value={termSource.value} onInput$={(_, element) => termSource.value = element.value} />
                <input class="input input-sm input-bordered" placeholder="目标语言固定译法" value={termTarget.value} onInput$={(_, element) => termTarget.value = element.value} />
                <button class="btn btn-sm btn-primary" onClick$={addTerm}>绑定</button>
              </div>
              <div class="mt-3 grid gap-2 md:grid-cols-2">
                {active().terms.map((termItem) => (
                  <div key={termItem.id} class="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                    <div class="min-w-0">
                      <div class="truncate text-xs font-bold">{termItem.source}</div>
                      <div class="truncate text-xs text-slate-500">{termItem.target}</div>
                    </div>
                    <div class="flex gap-1">
                      <button class={`btn btn-xs ${termItem.confirmed ? "btn-success" : "btn-ghost"}`} onClick$={() => updateActive("确认术语", (sign) => { const target = sign.terms.find((item) => item.id === termItem.id); if (target) target.confirmed = !target.confirmed; })}>确认</button>
                      <button class="btn btn-xs btn-ghost text-error" onClick$={() => updateActive("删除术语", (sign) => { sign.terms = sign.terms.filter((item) => item.id !== termItem.id); })}>删除</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section class="card border border-slate-200 bg-white shadow-sm">
            <div class="card-body p-5">
              <h2 class="font-bold">审校意见与回复</h2>
              <div class="mt-3 flex gap-2">
                <textarea class="textarea textarea-bordered min-h-20 flex-1" placeholder="记录措辞、文化适配或法规依据…" value={commentDraft.value} onInput$={(_, element) => commentDraft.value = element.value} />
                <button class="btn btn-primary self-end" onClick$={addComment}>添加意见</button>
              </div>
              <div class="mt-4 space-y-3">
                {active().comments.length === 0 && <div class="rounded-xl border border-dashed p-6 text-center text-sm text-slate-400">还没有审校意见。</div>}
                {active().comments.map((comment) => (
                  <article key={comment.id} class={`rounded-xl border-l-4 bg-slate-50 p-3 ${comment.resolved ? "border-success opacity-60" : "border-warning"}`}>
                    <div class="flex items-center justify-between text-xs"><strong>{comment.author}</strong><span class="text-slate-400">{new Date(comment.createdAt).toLocaleString()}</span></div>
                    <p class="my-2 text-sm">{comment.body}</p>
                    {comment.replies.map((reply) => (
                      <div key={reply.id} class="ml-4 my-1 border-l-2 border-slate-200 pl-3 text-xs"><strong>{reply.author}</strong>：{reply.body}</div>
                    ))}
                    {replyingTo.value === comment.id ? (
                      <div class="mt-2 flex gap-2">
                        <input class="input input-xs input-bordered flex-1" value={replyDraft.value} onInput$={(_, element) => replyDraft.value = element.value} />
                        <button class="btn btn-xs btn-primary" onClick$={() => addReply(comment.id)}>发送</button>
                      </div>
                    ) : (
                      <div class="mt-2 flex gap-2">
                        <button class="btn btn-xs btn-ghost" onClick$={() => { replyingTo.value = comment.id; }}>回复</button>
                        <button class="btn btn-xs btn-ghost" onClick$={() => updateActive("更新意见状态", (sign) => { const item = sign.comments.find((entry) => entry.id === comment.id); if (item) item.resolved = !item.resolved; })}>{comment.resolved ? "重新打开" : "标记已解决"}</button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </div>
          </section>
        </div>
      </main>

      <aside class="overflow-y-auto bg-slate-50 p-4">
        <section class="sticky top-4 space-y-4">
          <div class="card border border-slate-200 bg-white shadow-sm">
            <div class="card-body p-4">
              <div class="flex items-center justify-between">
                <div><div class="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Live Preview</div><h2 class="font-bold">版面实时预览</h2></div>
                <span class={`badge ${preview().risk === "high" ? "badge-error" : preview().risk === "medium" ? "badge-warning" : "badge-success"}`}>
                  {preview().risk === "high" ? "溢出风险" : preview().risk === "medium" ? "接近边界" : "版面安全"}
                </span>
              </div>
              <div class="mt-3 flex gap-1">
                {WIDTHS.map((width) => <button key={width} class={`btn btn-xs flex-1 ${previewWidth.value === width ? "btn-primary" : "btn-outline"}`} onClick$={() => previewWidth.value = width}>{width}px</button>)}
              </div>
              <div class="mt-2 flex items-center gap-3 text-xs">
                <span class="w-20">字号 {previewFont.value}px</span>
                <input type="range" min="28" max="88" step="2" class="range range-primary range-xs flex-1" value={previewFont.value} onInput$={(_, element) => previewFont.value = Number(element.value)} />
              </div>
              <div class="mt-4 overflow-hidden rounded-xl bg-slate-800 p-3">
                <div class="mx-auto grid min-h-48 place-items-center overflow-hidden border-4 border-white bg-[#174f3d] p-3 text-center text-white" style={{ width: `${previewWidth.value}px`, maxWidth: "100%" }}>
                  <div>
                    <div style={{ fontSize: `${previewFont.value}px` }} class="font-black leading-[1.18] tracking-wide">{preview().visible.map((line, index) => <div key={index}>{line || " "}</div>)}</div>
                  </div>
                </div>
              </div>
              <div class="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                <div class="rounded-lg bg-slate-100 p-2"><strong class="block text-lg">{preview().lines.length}</strong><span>预计行数</span></div>
                <div class="rounded-lg bg-slate-100 p-2"><strong class="block text-lg">{active().targetText.length}</strong><span>字符数</span></div>
                <div class="rounded-lg bg-slate-100 p-2"><strong class={`block text-lg ${preview().missingTerms.length ? "text-error" : "text-success"}`}>{preview().missingTerms.length}</strong><span>缺失术语</span></div>
              </div>
              {(preview().overflow || preview().tooLong) && <div class="alert alert-error mt-3 py-2 text-xs">{preview().overflow ? "当前字号下内容超过三行，可能截断。" : "译文接近标识建议字符上限。"}</div>}
            </div>
          </div>

          <div class="card border border-slate-200 bg-white shadow-sm">
            <div class="card-body p-4">
              <div class="flex items-center justify-between">
                <div><h2 class="font-bold">版本比较</h2><p class="text-xs text-slate-500">旧版快照与当前译文逐词对比。</p></div>
                <span class="badge badge-outline">{active().versions.length} 版</span>
              </div>
              {active().versions.length ? (
                <>
                  <select class="select select-sm select-bordered mt-3 w-full" value={selectedVersionId.value || active().versions[0].id} onChange$={(_, element) => selectedVersionId.value = element.value}>
                    {active().versions.map((version) => <option key={version.id} value={version.id}>{`${version.label} · ${new Date(version.createdAt).toLocaleTimeString()}`}</option>)}
                  </select>
                  <div class="mt-3 rounded-lg bg-slate-900 p-3 text-sm leading-7 text-slate-100">
                    {comparison().map((token, index) => (
                      <span key={index} class={token.type === "add" ? "rounded bg-green-400/25 text-green-200" : token.type === "remove" ? "bg-red-400/25 text-red-200 line-through" : ""}>{token.value}</span>
                    ))}
                  </div>
                  <div class="mt-2 flex gap-3 text-[11px]"><span class="text-green-700">绿：新增</span><span class="text-red-700">红：删除</span></div>
                </>
              ) : (
                <div class="mt-3 rounded-xl border border-dashed p-5 text-center text-xs text-slate-400">保存当前译文后会在这里生成可比较版本。</div>
              )}
            </div>
          </div>

          <div class="rounded-xl bg-[#17324d] p-4 text-xs text-slate-200">
            <div class="mb-2 font-bold text-white">键盘操作</div>
            <div class="grid grid-cols-2 gap-y-1"><span><kbd class="kbd kbd-xs">J/K</kbd> 切换标识</span><span><kbd class="kbd kbd-xs">[ ]</kbd> 预览宽度</span><span><kbd class="kbd kbd-xs">- =</kbd> 字号</span><span><kbd class="kbd kbd-xs">Ctrl/⌘ Z</kbd> 撤销</span></div>
          </div>
        </section>
      </aside>
    </div>
  );

  return (
    <div data-theme="corporate" class="min-h-screen bg-slate-100 pb-9 text-slate-800">
      <header class="navbar sticky top-0 z-40 min-h-16 border-b border-slate-700 bg-[#17324d] px-5 text-white shadow-lg">
        <div class="navbar-start gap-3">
          <div class="grid h-10 w-10 place-items-center rounded-xl border border-white/20 bg-white/10 font-black">译</div>
          <div>
            <div class="text-xs uppercase tracking-[0.2em] text-sky-200">Public Sign Review</div>
            <div class="font-bold">公共标识多语言校对台</div>
          </div>
        </div>
        <div class="navbar-center hidden lg:flex">
          <div class="join">
            <button class={`btn join-item btn-sm ${view.value === "review" ? "btn-active btn-primary" : "bg-white/10 text-white"}`} onClick$={() => (view.value = "review")}>标识校对台</button>
            <button class={`btn join-item btn-sm ${view.value === "places" ? "btn-active btn-primary" : "bg-white/10 text-white"}`} onClick$={() => (view.value = "places")}>
              地名管理{pendingAmbiguities().length > 0 && <span class="badge badge-warning badge-xs ml-1">{pendingAmbiguities().length}</span>}
            </button>
          </div>
        </div>
        <div class="navbar-end gap-2">
          {view.value === "review" && (
            <>
              <span class={`badge ${online.value ? "badge-success" : "badge-warning"} badge-outline`}>{online.value ? "在线" : "离线草稿"}</span>
              <button class="btn btn-sm border-white/20 bg-white/10 text-white hover:bg-white/20" onClick$={sharePreview}>复制只读链接</button>
              <button class={`btn btn-sm ${active().emergencyRevision ? "btn-error" : "btn-warning"}`} onClick$={toggleEmergency}>
                {active().emergencyRevision ? "退出紧急修订" : "紧急修订"}
              </button>
            </>
          )}
          <button class="btn btn-ghost btn-sm" disabled={!past.value.length} onClick$={undo}>撤销</button>
          <button class="btn btn-ghost btn-sm" disabled={!future.value.length} onClick$={redo}>重做</button>
        </div>
      </header>

      <div class="flex gap-1 bg-[#17324d] px-5 pb-2 lg:hidden">
        <button class={`btn join-item btn-xs ${view.value === "review" ? "btn-active btn-primary" : "bg-white/10 text-white"}`} onClick$={() => (view.value = "review")}>标识校对台</button>
        <button class={`btn join-item btn-xs ${view.value === "places" ? "btn-active btn-primary" : "bg-white/10 text-white"}`} onClick$={() => (view.value = "places")}>地名管理</button>
      </div>

      {upgradeNote.value && (
        <div class="alert alert-info rounded-none py-2 text-xs">
          <span>{upgradeNote.value}</span>
          <button class="btn btn-xs btn-ghost" onClick$={() => (upgradeNote.value = "")}>关闭</button>
        </div>
      )}

      {view.value === "places" ? renderPlacesView() : renderReviewView()}

      {toast.value && <div class="toast toast-end z-50"><div class="alert alert-success"><span>{toast.value}</span></div></div>}
    </div>
  );
});
