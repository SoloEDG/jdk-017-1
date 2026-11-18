export type ProjectErrorCode =
  | "not-a-zip"
  | "archive-too-large"
  | "too-many-entries"
  | "unsafe-entry"
  | "unsupported-method"
  | "bad-crc"
  | "bad-manifest"
  | "unsupported-version"
  | "asset-missing"
  | "asset-corrupt"
  | "asset-decode"
  | "asset-dimensions"
  | "image-too-large"
  | "no-asset";

/** 工程文件错误：code 用于程序化判断，detail 面向用户的一句话说明 */
export class ProjectError extends Error {
  readonly code: ProjectErrorCode;
  constructor(code: ProjectErrorCode, detail: string) {
    super(detail);
    this.name = "ProjectError";
    this.code = code;
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof ProjectError) return e.message;
  if (e instanceof Error) return e.message;
  return "未知错误";
}
