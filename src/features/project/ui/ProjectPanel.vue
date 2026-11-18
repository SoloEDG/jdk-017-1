<script setup lang="ts">
import { computed, ref } from "vue";
import {
  FileArchive,
  Save,
  FolderOpen,
  ShieldCheck,
  FileWarning,
} from "lucide-vue-next";
import type { StudioDocument } from "../../../shared/types";
import { useProject } from "../model/useProject";
import type { AssetProblem } from "../lib/unpack";

const { doc } = defineProps<{ doc: StudioDocument }>();
const {
  phase,
  saving,
  saveInfo,
  openError,
  problems,
  candidate,
  preference,
  rebindNote,
  save,
  open,
  rebind,
  commit,
  cancel,
} = useProject(doc);

const openInput = ref<HTMLInputElement>();
const rebindInput = ref<HTMLInputElement>();
let pendingProblem: AssetProblem | null = null;

function chooseOpen(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void open(f);
  (e.target as HTMLInputElement).value = "";
}
function askRebind(p: AssetProblem) {
  pendingProblem = p;
  rebindInput.value?.click();
}
function chooseRebind(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f && pendingProblem) void rebind(pendingProblem, f);
  (e.target as HTMLInputElement).value = "";
}

const activeKind = computed(() => {
  const m = candidate.value?.manifest;
  const ref = m?.assets.find((a) => a.hash === m.activeAsset);
  return ref?.kind === "encoded" ? "原始编码照片" : "规范化像素资源";
});
const shortHash = (hash: string) => hash.slice(7, 15);
</script>

<template>
  <section class="panel project-panel">
    <div class="section-label">
      <span>00 / 工程文件</span><FileArchive :size="15" />
    </div>
    <label class="field-label" for="project-name">工程名称</label>
    <input
      id="project-name"
      class="text-input"
      type="text"
      v-model="doc.name"
      maxlength="120"
      placeholder="未命名的星球"
    />
    <div class="format-row">
      <span>素材存储</span>
      <div class="segmented small">
        <button
          :class="{ active: preference === 'auto' }"
          @click="preference = 'auto'"
        >
          自动</button
        ><button
          :class="{ active: preference === 'encoded' }"
          @click="preference = 'encoded'"
        >
          原始编码</button
        ><button
          :class="{ active: preference === 'pixels' }"
          @click="preference = 'pixels'"
        >
          规范像素
        </button>
      </div>
    </div>
    <p class="mini">
      自动：≤ 16 MB 的 JPG / PNG / WebP 保留原始编码以减小体积；否则存无损像素，重新打开后导出与保存时位精确一致。
    </p>
    <button
      class="primary export-button"
      :disabled="!doc.asset || saving"
      @click="save"
    >
      <Save :size="16" />{{ saving ? "正在打包工程…" : "保存工程文件"
      }}<span v-if="!saving">↗</span>
    </button>
    <p v-if="saveInfo && phase === 'idle'" role="status" class="mini">
      {{ saveInfo }}
    </p>

    <div class="open-divider" />
    <button class="open-button" @click="openInput?.click()">
      <FolderOpen :size="15" />打开工程文件…
    </button>
    <input
      ref="openInput"
      hidden
      type="file"
      accept=".orbit,application/zip"
      @change="chooseOpen"
    />
    <input
      ref="rebindInput"
      hidden
      type="file"
      accept="image/jpeg,image/png,image/webp"
      @change="chooseRebind"
    />
    <p v-if="phase === 'idle'" class="mini">
      离线可打开。尺寸、引用与资源完整性会先在暂存区校验，全部通过才替换当前作品。
    </p>
    <p v-if="phase === 'reading'" role="status" class="mini">
      正在暂存区校验工程文件…
    </p>

    <div v-if="phase === 'error'" class="open-result">
      <p v-if="openError" role="alert" class="error">{{ openError }}</p>
      <div v-for="p in problems" :key="p.hash" class="problem">
        <FileWarning :size="16" />
        <div>
          <strong>{{ p.name }}</strong>
          <span>{{ p.detail }}</span>
        </div>
        <button class="rebind-button" @click="askRebind(p)">重新绑定</button>
      </div>
      <p v-if="rebindNote" role="status" class="mini">{{ rebindNote }}</p>
      <p class="mini">当前作品未受影响。</p>
      <button class="text-button" @click="cancel">放弃打开</button>
    </div>

    <div v-if="phase === 'confirm' && candidate" class="open-result">
      <div class="preview-card">
        <img
          v-if="candidate.previewUrl"
          :src="candidate.previewUrl"
          alt="保存时的构图预览"
        />
        <div>
          <strong>{{ candidate.name }}</strong>
          <span
            >{{ candidate.asset.name }} · {{ candidate.asset.width }} ×
            {{ candidate.asset.height }} px</span
          >
          <span
            >{{
              candidate.projection.mode === "planet" ? "小行星" : "时空隧道"
            }}
            · {{ activeKind }}</span
          >
        </div>
      </div>
      <p v-for="w in candidate.warnings" :key="w" class="mini">{{ w }}</p>
      <p v-if="rebindNote" role="status" class="mini">{{ rebindNote }}</p>
      <p
        v-for="s in candidate.substitutions"
        :key="s.fromHash"
        class="substitution"
      >
        素材已由你重新绑定：{{ s.name }}（指纹 {{ shortHash(s.fromHash) }}… →
        {{ shortHash(s.toHash) }}…）
      </p>
      <button class="primary export-button" @click="commit">
        <ShieldCheck :size="16" />校验通过，打开工程
      </button>
      <button class="text-button" @click="cancel">取消</button>
    </div>
  </section>
</template>
