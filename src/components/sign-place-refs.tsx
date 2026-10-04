import { $, component$, useSignal, type QRL } from "@builder.io/qwik";
import type { PlaceNamePackage, SignItem } from "../types";

interface Props {
  sign: SignItem;
  table: PlaceNamePackage;
  onAddRef$: QRL<(placeId: string) => void>;
  onRemoveRef$: QRL<(placeId: string) => void>;
  onReconcile$: QRL<() => void>;
  onUpgrade$: QRL<() => void>;
}

export const SignPlaceRefs = component$((props: Props) => {
  const addPlaceId = useSignal("");
  const entryMap = new Map(props.table.entries.map((entry) => [entry.id, entry]));
  const referenced = new Set(props.sign.placeRefs ?? []);
  const candidates = props.table.entries.filter((entry) => !referenced.has(entry.id));

  const add = $(() => {
    if (!addPlaceId.value) return;
    props.onAddRef$(addPlaceId.value);
    addPlaceId.value = "";
  });

  return (
    <section class="card border border-slate-200 bg-white shadow-sm">
      <div class="card-body p-5">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="font-bold">地名引用</h2>
            <p class="text-xs text-slate-500">标识校对台只记录引用了哪些地名与审校状态；拼写、生效与废止由地名管理部门维护。</p>
          </div>
          <div class="flex gap-2">
            <button class="btn btn-sm btn-outline" onClick$={props.onUpgrade$}>升级旧稿</button>
            <button class="btn btn-sm btn-primary" onClick$={props.onReconcile$}>对账</button>
          </div>
        </div>

        {(props.sign.placeFindings ?? []).length > 0 && (
          <div class="space-y-2">
            {(props.sign.placeFindings ?? []).map((finding) => {
              const entry = entryMap.get(finding.placeId);
              return (
                <div key={`${finding.placeId}-${finding.found}`} class="rounded-lg border-l-4 border-error bg-red-50 px-3 py-2 text-xs">
                  {finding.kind === "deprecated" ? (
                    <span>
                      引用的地名 <strong>{entry?.standard ?? finding.standard}</strong> 已废止，标识仍写作「{finding.found}」，请按现行写法修改后重新审校。
                    </span>
                  ) : (
                    <span>
                      地名拼写已更新：<span class="line-through text-slate-500">「{finding.found}」</span>
                      {" → "}
                      <strong class="text-error">「{finding.standard}」</strong>
                      ，请退回修改译文，未提交的草稿不会被覆盖。
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div class="space-y-2">
          {(props.sign.placeRefs ?? []).length === 0 && (
            <div class="rounded-xl border border-dashed p-4 text-center text-xs text-slate-400">
              还没有引用地名。可在下方添加引用，或用「升级旧稿」按拼写批量认领。
            </div>
          )}
          {(props.sign.placeRefs ?? []).map((placeId) => {
            const entry = entryMap.get(placeId);
            if (!entry) {
              return (
                <div key={placeId} class="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-xs">
                  <span class="text-slate-400">地名条目 {placeId} 已不存在</span>
                  <button class="btn btn-xs btn-ghost text-error" onClick$={() => props.onRemoveRef$(placeId)}>移除</button>
                </div>
              );
            }
            return (
              <div key={placeId} class="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                <div class="min-w-0">
                  <div class="flex items-center gap-2 text-xs font-bold">
                    {entry.standard}
                    <span class={`badge badge-xs ${entry.status === "active" ? "badge-success" : "badge-neutral"}`}>
                      {entry.status === "active" ? "生效" : "废止"}
                    </span>
                  </div>
                  {entry.aliases.length > 0 && (
                    <div class="truncate text-[11px] text-slate-400">其他写法：{entry.aliases.join("、")}</div>
                  )}
                </div>
                <button class="btn btn-xs btn-ghost text-error" onClick$={() => props.onRemoveRef$(placeId)}>移除</button>
              </div>
            );
          })}
        </div>

        <div class="flex gap-2">
          <select
            class="select select-sm select-bordered flex-1"
            value={addPlaceId.value}
            onChange$={(_, el) => { addPlaceId.value = el.value; }}
          >
            <option value="">添加地名引用…</option>
            {candidates.map((entry) => (
              <option key={entry.id} value={entry.id}>{`${entry.standard}${entry.status === "deprecated" ? "（已废止）" : ""}`}</option>
            ))}
          </select>
          <button class="btn btn-sm btn-primary" onClick$={add} disabled={!addPlaceId.value}>引用</button>
        </div>
      </div>
    </section>
  );
});
