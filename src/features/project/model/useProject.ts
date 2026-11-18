import { markRaw, ref } from "vue";
import type { StudioDocument } from "../../../shared/types";
import { errorMessage, ProjectError } from "../lib/errors";
import { decodeStaged, rebindAsset, type StagedProject } from "../lib/open";
import { buildProjectFile, type PayloadPreference } from "../lib/save";
import { stageArchive, type AssetProblem, type StagedArchive } from "../lib/unpack";
import { ZIP_LIMITS } from "../lib/zip";

export type ProjectPhase = "idle" | "reading" | "confirm" | "error";

export function useProject(doc: StudioDocument) {
  const phase = ref<ProjectPhase>("idle");
  const saving = ref(false);
  const saveInfo = ref("");
  const openError = ref("");
  const problems = ref<AssetProblem[]>([]);
  const candidate = ref<StagedProject | null>(null);
  const preference = ref<PayloadPreference>("auto");
  const rebindNote = ref("");

  let staged: StagedArchive | null = null;
  let projectId: string = crypto.randomUUID();
  let createdAt = new Date().toISOString();

  function resetOpenState() {
    if (candidate.value?.previewUrl)
      URL.revokeObjectURL(candidate.value.previewUrl);
    candidate.value = null;
    staged = null;
    problems.value = [];
    openError.value = "";
    rebindNote.value = "";
  }

  async function save() {
    if (saving.value) return;
    saving.value = true;
    saveInfo.value = "";
    try {
      const result = await buildProjectFile(doc, {
        preference: preference.value,
        id: projectId,
        createdAt,
      });
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (doc.asset) doc.asset.hash = result.manifest.activeAsset;
      const mb = (result.totalBytes / 1024 / 1024).toFixed(2);
      const kindLabel =
        result.kind === "encoded" ? "原始编码照片" : "规范化像素资源";
      saveInfo.value = [
        `工程已保存（${kindLabel} · ${mb} MB），可离线带走继续创作`,
        ...result.warnings,
      ].join("；");
    } catch (e) {
      saveInfo.value = errorMessage(e);
    } finally {
      saving.value = false;
    }
  }

  async function open(file: File) {
    if (phase.value === "reading") return;
    resetOpenState();
    phase.value = "reading";
    try {
      if (file.size > ZIP_LIMITS.maxTotalBytes)
        throw new ProjectError(
          "archive-too-large",
          `文件体积 ${Math.ceil(file.size / 1024 / 1024)} MB 超过 ${ZIP_LIMITS.maxTotalBytes / 1024 / 1024} MB 上限，已拒绝打开`,
        );
      const bytes = new Uint8Array(await file.arrayBuffer());
      const archive = await stageArchive(bytes);
      staged = archive;
      if (archive.problems.length > 0) {
        problems.value = [...archive.problems];
        phase.value = "error";
        return;
      }
      candidate.value = await decodeStaged(archive);
      phase.value = "confirm";
    } catch (e) {
      openError.value = errorMessage(e);
      phase.value = "error";
    }
  }

  async function rebind(problem: AssetProblem, file: File) {
    if (!staged) return;
    rebindNote.value = "";
    try {
      const result = await rebindAsset(staged, problem.hash, file);
      problems.value = [...staged.problems];
      rebindNote.value = result.identical
        ? `「${result.name}」指纹与记录一致，已找回原素材`
        : `「${result.name}」指纹与记录不同，将在你确认后替换原素材（不会静默换图）`;
      if (staged.problems.length === 0) {
        candidate.value = await decodeStaged(staged);
        phase.value = "confirm";
      }
    } catch (e) {
      rebindNote.value = errorMessage(e);
    }
  }

  /** 一次切换整个工作区：全部校验通过后才提交，中途失败不会进入这里 */
  function commit() {
    const c = candidate.value;
    if (!c) return;
    doc.name = c.name;
    doc.asset = markRaw(c.asset);
    Object.assign(doc.projection, c.projection);
    Object.assign(doc.edge, c.edge);
    projectId = c.manifest.id;
    createdAt = c.manifest.createdAt;
    resetOpenState();
    phase.value = "idle";
    saveInfo.value = "工程已打开，可继续创作";
  }

  function cancel() {
    resetOpenState();
    phase.value = "idle";
  }

  return {
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
  };
}
