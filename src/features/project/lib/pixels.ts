import { ProjectError } from "./errors";
import { MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE } from "./manifest";

/** ImageData → 无损 PNG 字节（规范化像素资源） */
export async function imageDataToPng(data: ImageData): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = data.width;
  canvas.height = data.height;
  canvas.getContext("2d")!.putImageData(data, 0, 0);
  return canvasToPngBytes(canvas);
}

export function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new ProjectError("asset-decode", "PNG 编码失败"));
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, "image/png"),
  );
}

/**
 * PNG 字节 → ImageData，要求尺寸与清单记录完全一致。
 * 关闭色彩空间转换，保证重新打开后像素与保存时位精确一致。
 */
export async function pngToImageData(
  bytes: Uint8Array,
  expectWidth: number,
  expectHeight: number,
): Promise<ImageData> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), {
      colorSpaceConversion: "none",
      premultiplyAlpha: "none",
    });
  } catch {
    throw new ProjectError("asset-decode", "规范化像素资源无法解码，可能已损坏");
  }
  try {
    if (bitmap.width > MAX_IMAGE_SIDE || bitmap.height > MAX_IMAGE_SIDE)
      throw new ProjectError(
        "image-too-large",
        `素材尺寸 ${bitmap.width} × ${bitmap.height} 超过 ${MAX_IMAGE_SIDE} px 上限`,
      );
    if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS)
      throw new ProjectError(
        "image-too-large",
        "素材像素总量超过上限，已拒绝打开",
      );
    if (bitmap.width !== expectWidth || bitmap.height !== expectHeight)
      throw new ProjectError(
        "asset-dimensions",
        `素材尺寸 ${bitmap.width} × ${bitmap.height} 与工程记录 ${expectWidth} × ${expectHeight} 不符`,
      );
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height, {
      colorSpace: "srgb",
    });
  } finally {
    bitmap.close();
  }
}

/** 由工作像素重新生成素材缩略图（与导入时一致：240 × 120 JPEG） */
export function thumbnailFromImageData(data: ImageData): string {
  const canvas = document.createElement("canvas");
  canvas.width = data.width;
  canvas.height = data.height;
  canvas.getContext("2d")!.putImageData(data, 0, 0);
  const thumb = document.createElement("canvas");
  thumb.width = 240;
  thumb.height = 120;
  thumb.getContext("2d")!.drawImage(canvas, 0, 0, 240, 120);
  return thumb.toDataURL("image/jpeg", 0.7);
}
