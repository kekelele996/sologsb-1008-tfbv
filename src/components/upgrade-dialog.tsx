import { component$, useSignal, useTask$, type QRL } from "@builder.io/qwik";
import type { UpgradeScan } from "../places";

interface Props {
  open: boolean;
  scan: UpgradeScan | null;
  onClose$: QRL<() => void>;
  onApply$: QRL<(resolutions: Record<string, string | null>) => void>;
}

export const UpgradeDialog = component$((props: Props) => {
  const resolutions = useSignal<Record<string, string | null>>({});

  useTask$(({ track }) => {
    track(() => props.scan);
    if (props.scan) {
      const defaults: Record<string, string | null> = {};
      for (const amb of props.scan.ambiguousSpelling) {
        defaults[`${amb.signId}::${amb.spelling}`] = amb.matches[0]?.placeId ?? null;
      }
      resolutions.value = defaults;
    }
  });

  if (!props.open || !props.scan) return null;
  const scan = props.scan;
  const total = scan.autoClaims.length + scan.ambiguousSpelling.length;

  return (
    <div class="modal modal-open">
      <div class="modal-box max-w-2xl">
        <h3 class="text-lg font-bold">旧稿升级 · 按拼写认领地名</h3>
        <p class="py-2 text-xs text-slate-500">
          扫描未引用地名的标识，按中文原文与译文拼写匹配地名条目。唯一匹配自动认领；一个拼写对上多处、或一个地名有多种写法时先摆出来，由你确认。
        </p>

        {total === 0 && (
          <div class="rounded-xl border border-dashed p-6 text-center text-sm text-slate-400">
            没有可认领的地名。请先在地名管理中录入或导入拼写表。
          </div>
        )}

        {scan.autoClaims.length > 0 && (
          <div class="mb-4">
            <div class="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-slate-400">自动认领（{scan.autoClaims.length}）</div>
            <div class="space-y-1">
              {scan.autoClaims.map((claim) => (
                <div key={`${claim.signId}-${claim.placeId}`} class="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs">
                  <span class="font-mono font-bold text-slate-500">{claim.signId}</span>
                  <span>译文「{claim.found}」→ 认领 <strong>{claim.standard}</strong></span>
                </div>
              ))}
            </div>
          </div>
        )}

        {scan.multiSpelling.length > 0 && (
          <div class="mb-4">
            <div class="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-slate-400">一地多写（{scan.multiSpelling.length}）</div>
            <div class="space-y-1">
              {scan.multiSpelling.map((item) => (
                <div key={`${item.signId}-${item.placeId}`} class="rounded-lg bg-amber-50 px-3 py-2 text-xs">
                  <span class="font-mono font-bold text-slate-500">{item.signCode}</span>
                  <span> 地名 <strong>{item.standard}</strong> 在标识中有多种写法：{item.spellings.map((s) => `「${s}」`).join("、")}，将一并认领。</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {scan.ambiguousSpelling.length > 0 && (
          <div class="mb-2">
            <div class="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-slate-400">待确认拼写（{scan.ambiguousSpelling.length}）</div>
            <div class="space-y-3">
              {scan.ambiguousSpelling.map((amb) => {
                const key = `${amb.signId}::${amb.spelling}`;
                const value = resolutions.value[key] ?? "skip";
                return (
                  <div key={key} class="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
                    <div class="mb-2 text-xs">
                      <span class="font-mono font-bold text-slate-500">{amb.signCode}</span>
                      <span> 拼写「<strong>{amb.spelling}</strong>」对上多处地名，请选择认领条目：</span>
                    </div>
                    <div class="flex flex-wrap gap-3">
                      {amb.matches.map((match) => (
                        <label key={match.placeId} class="flex items-center gap-1 text-xs">
                          <input
                            type="radio"
                            name={key}
                            value={match.placeId}
                            checked={value === match.placeId}
                            onChange$={() => { resolutions.value = { ...resolutions.value, [key]: match.placeId }; }}
                          />
                          {match.standard}
                        </label>
                      ))}
                      <label class="flex items-center gap-1 text-xs text-slate-500">
                        <input
                          type="radio"
                          name={key}
                          value="skip"
                          checked={value === "skip"}
                          onChange$={() => { resolutions.value = { ...resolutions.value, [key]: null }; }}
                        />
                        跳过
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div class="modal-action">
          <button class="btn btn-sm btn-ghost" onClick$={props.onClose$}>取消</button>
          <button class="btn btn-sm btn-primary" onClick$={() => props.onApply$(resolutions.value)} disabled={total === 0}>应用认领</button>
        </div>
      </div>
      <div class="modal-backdrop" onClick$={props.onClose$}></div>
    </div>
  );
});
