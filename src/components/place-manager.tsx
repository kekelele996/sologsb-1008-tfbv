import { $, component$, useSignal, type QRL } from "@builder.io/qwik";
import type { PlaceNameEntry, PlaceNamePackage, PlaceNameStatus } from "../types";
import { uid } from "../data";

interface Props {
  table: PlaceNamePackage;
  onChange$: QRL<(next: PlaceNamePackage, shouldReconcile: boolean, message: string) => void>;
  onImportClick$: QRL<() => void>;
}

const STATUS_LABELS: Record<PlaceNameStatus, string> = {
  active: "生效",
  deprecated: "废止",
};

const splitAliases = (value: string) =>
  value.split(/[、,，;；\n]/).map((item) => item.trim()).filter(Boolean);

export const PlaceManager = component$((props: Props) => {
  const editingId = useSignal<string | null>(null);
  const formStandard = useSignal("");
  const formAliases = useSignal("");
  const formStatus = useSignal<PlaceNameStatus>("active");
  const formEffective = useSignal("");
  const formDeprecated = useSignal("");

  const startAdd = $(() => {
    editingId.value = null;
    formStandard.value = "";
    formAliases.value = "";
    formStatus.value = "active";
    formEffective.value = new Date().toISOString().slice(0, 10);
    formDeprecated.value = "";
  });

  const startEdit = $((entry: PlaceNameEntry) => {
    editingId.value = entry.id;
    formStandard.value = entry.standard;
    formAliases.value = entry.aliases.join("、");
    formStatus.value = entry.status;
    formEffective.value = entry.effectiveAt.slice(0, 10);
    formDeprecated.value = entry.deprecatedAt ? entry.deprecatedAt.slice(0, 10) : "";
  });

  const cancelEdit = $(() => {
    editingId.value = null;
  });

  const saveEdit = $(() => {
    const standard = formStandard.value.trim();
    if (!standard) return;
    const aliases = splitAliases(formAliases.value);
    const effectiveAt = formEffective.value ? new Date(formEffective.value).toISOString() : new Date().toISOString();
    const deprecatedAt = formStatus.value === "deprecated" && formDeprecated.value
      ? new Date(formDeprecated.value).toISOString()
      : undefined;
    let next: PlaceNamePackage;
    let message: string;
    let shouldReconcile = false;
    if (editingId.value) {
      const previous = props.table.entries.find((entry) => entry.id === editingId.value);
      next = {
        ...props.table,
        entries: props.table.entries.map((entry) => {
          if (entry.id !== editingId.value) return entry;
          const mergedAliases = [...aliases];
          if (previous && previous.standard !== standard && !mergedAliases.includes(previous.standard)) {
            mergedAliases.push(previous.standard); // 改了拼写，旧写法留档
          }
          return { ...entry, standard, aliases: mergedAliases, status: formStatus.value, effectiveAt, deprecatedAt, updatedAt: new Date().toISOString() };
        }),
      };
      message = `地名「${standard}」已更新`;
      shouldReconcile = true;
    } else {
      const entry: PlaceNameEntry = {
        id: uid("place"),
        standard,
        aliases,
        status: formStatus.value,
        effectiveAt,
        deprecatedAt,
        updatedAt: new Date().toISOString(),
      };
      next = { ...props.table, entries: [...props.table.entries, entry] };
      message = `地名「${standard}」已录入`;
    }
    editingId.value = null;
    props.onChange$(next, shouldReconcile, message);
  });

  const toggleStatus = $((entry: PlaceNameEntry) => {
    const status: PlaceNameStatus = entry.status === "active" ? "deprecated" : "active";
    const next: PlaceNamePackage = {
      ...props.table,
      entries: props.table.entries.map((item) =>
        item.id === entry.id
          ? { ...item, status, deprecatedAt: status === "deprecated" ? new Date().toISOString() : undefined, updatedAt: new Date().toISOString() }
          : item,
      ),
    };
    props.onChange$(next, status === "deprecated", `地名「${entry.standard}」已${STATUS_LABELS[status]}`);
  });

  const exportTable = $(() => {
    const blob = new Blob([JSON.stringify(props.table, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `拼写表-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  });

  const isEditing = editingId.value !== null || formStandard.value !== "" || formAliases.value !== "";

  return (
    <div class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-lg font-bold">地名管理</h2>
          <p class="text-xs text-slate-500">地名管理部门维护标准拼写、生效与废止；标识校对台只引用条目，两边各管各的。</p>
        </div>
        <div class="flex gap-2">
          <button class="btn btn-sm btn-outline" onClick$={props.onImportClick$}>导入拼写表</button>
          <button class="btn btn-sm btn-outline" onClick$={exportTable}>导出拼写表</button>
          <button class="btn btn-sm btn-primary" onClick$={startAdd}>新增地名</button>
        </div>
      </div>

      {isEditing && (
        <section class="card border border-blue-200 bg-blue-50/40 shadow-sm">
          <div class="card-body gap-3 p-4">
            <div class="text-xs font-bold uppercase tracking-[0.16em] text-blue-600">
              {editingId.value ? "编辑地名" : "新增地名"}
            </div>
            <div class="grid grid-cols-2 gap-3">
              <label class="form-control">
                <span class="label-text mb-1 text-xs font-bold text-slate-500">标准拼写</span>
                <input class="input input-sm input-bordered" value={formStandard.value} onInput$={(_, el) => formStandard.value = el.value} placeholder="如：滨海站" />
              </label>
              <label class="form-control">
                <span class="label-text mb-1 text-xs font-bold text-slate-500">其他写法（顿号或逗号分隔）</span>
                <input class="input input-sm input-bordered" value={formAliases.value} onInput$={(_, el) => formAliases.value = el.value} placeholder="如：滨海北站" />
              </label>
              <label class="form-control">
                <span class="label-text mb-1 text-xs font-bold text-slate-500">状态</span>
                <select class="select select-sm select-bordered" value={formStatus.value} onChange$={(_, el) => formStatus.value = el.value as PlaceNameStatus}>
                  <option value="active">生效</option>
                  <option value="deprecated">废止</option>
                </select>
              </label>
              <label class="form-control">
                <span class="label-text mb-1 text-xs font-bold text-slate-500">生效日期</span>
                <input type="date" class="input input-sm input-bordered" value={formEffective.value} onInput$={(_, el) => formEffective.value = el.value} />
              </label>
              {formStatus.value === "deprecated" && (
                <label class="form-control">
                  <span class="label-text mb-1 text-xs font-bold text-slate-500">废止日期</span>
                  <input type="date" class="input input-sm input-bordered" value={formDeprecated.value} onInput$={(_, el) => formDeprecated.value = el.value} />
                </label>
              )}
            </div>
            <div class="flex justify-end gap-2">
              <button class="btn btn-sm btn-ghost" onClick$={cancelEdit}>取消</button>
              <button class="btn btn-sm btn-primary" onClick$={saveEdit} disabled={!formStandard.value.trim()}>保存并对账</button>
            </div>
          </div>
        </section>
      )}

      <section class="card border border-slate-200 bg-white shadow-sm">
        <div class="card-body p-0">
          <div class="overflow-x-auto">
            <table class="table table-sm">
              <thead>
                <tr class="text-slate-500">
                  <th>标准拼写</th>
                  <th>其他写法</th>
                  <th>状态</th>
                  <th>生效日期</th>
                  <th>废止日期</th>
                  <th class="text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {props.table.entries.length === 0 && (
                  <tr><td colSpan={6} class="py-8 text-center text-slate-400">还没有地名条目，可新增或导入拼写表。</td></tr>
                )}
                {props.table.entries.map((entry) => (
                  <tr key={entry.id} class={entry.status === "deprecated" ? "opacity-60" : ""}>
                    <td class="font-bold">{entry.standard}</td>
                    <td class="text-xs text-slate-500">{entry.aliases.length ? entry.aliases.join("、") : "—"}</td>
                    <td>
                      <span class={`badge badge-sm ${entry.status === "active" ? "badge-success" : "badge-neutral"}`}>
                        {STATUS_LABELS[entry.status]}
                      </span>
                    </td>
                    <td class="text-xs">{entry.effectiveAt.slice(0, 10)}</td>
                    <td class="text-xs">{entry.deprecatedAt ? entry.deprecatedAt.slice(0, 10) : "—"}</td>
                    <td class="text-right">
                      <div class="flex justify-end gap-1">
                        <button class="btn btn-xs btn-ghost" onClick$={() => startEdit(entry)}>编辑</button>
                        <button class="btn btn-xs btn-ghost text-error" onClick$={() => toggleStatus(entry)}>
                          {entry.status === "active" ? "废止" : "恢复生效"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
});
