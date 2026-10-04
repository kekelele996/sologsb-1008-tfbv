import { component$, useSignal, $, type QRL } from "@builder.io/qwik";
import type { PlaceNamePackage } from "../types";
import { parsePlacePackage } from "../places";

interface Props {
  open: boolean;
  onClose$: QRL<() => void>;
  onImport$: QRL<(table: PlaceNamePackage) => void>;
}

const SAMPLE = `{
  "schema": 1,
  "issuedAt": "2026-10-01T00:00:00.000Z",
  "entries": [
    {
      "id": "place-binhai-station",
      "standard": "滨海站",
      "aliases": [],
      "status": "active",
      "effectiveAt": "2019-12-01T00:00:00.000Z"
    }
  ]
}`;

export const ImportDialog = component$((props: Props) => {
  const text = useSignal("");
  const error = useSignal("");
  const fileName = useSignal("");

  const submit = $(() => {
    const result = parsePlacePackage(text.value);
    if (!result.ok) {
      error.value = result.error; // 解析失败：保留文本与旧表，可直接重试
      return;
    }
    error.value = "";
    text.value = "";
    fileName.value = "";
    props.onImport$(result.table);
  });

  const onFile = $((file: File) => {
    fileName.value = file.name;
    const reader = new FileReader();
    reader.onload = () => {
      text.value = String(reader.result ?? "");
      error.value = "";
    };
    reader.readAsText(file);
  });

  if (!props.open) return null;

  return (
    <div class="modal modal-open">
      <div class="modal-box max-w-2xl">
        <h3 class="text-lg font-bold">导入拼写表</h3>
        <p class="py-2 text-xs text-slate-500">
          粘贴地名管理部门下发的整包 JSON，或选择 .json 文件。整包解析失败会保留旧表与已退回标识，可修改后重试。
        </p>
        <div class="mb-2 flex items-center gap-2">
          <input
            type="file"
            accept=".json,application/json"
            class="file-input file-input-sm file-input-bordered w-full max-w-xs"
            onChange$={(_, el) => {
              const file = el.files?.[0];
              if (file) onFile(file);
            }}
          />
          {fileName.value && <span class="text-xs text-slate-500">{fileName.value}</span>}
        </div>
        <textarea
          class="textarea textarea-bordered min-h-56 w-full font-mono text-xs leading-5"
          placeholder={SAMPLE}
          value={text.value}
          onInput$={(_, el) => { text.value = el.value; if (error.value) error.value = ""; }}
        />
        {error.value && (
          <div class="alert alert-error mt-3 py-2 text-xs">
            <span>整包解析失败：{error.value}。旧表与已退回标识已保留，修正后可重试。</span>
          </div>
        )}
        <div class="modal-action">
          <button class="btn btn-sm btn-ghost" onClick$={props.onClose$}>取消</button>
          <button class="btn btn-sm btn-primary" onClick$={submit} disabled={!text.value.trim()}>解析并对账</button>
        </div>
      </div>
      <div class="modal-backdrop" onClick$={props.onClose$}></div>
    </div>
  );
});
