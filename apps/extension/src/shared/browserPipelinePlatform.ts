/**
 * Browser PlatformProvider — uses native DOM APIs.
 *
 * All methods are trivial wrappers around document.createElement, etc.
 * The DOM types (HTMLCanvasElement, HTMLImageElement) structurally
 * satisfy PipelineCanvas / PipelineImage, so we return them directly.
 */

import type {
  ImageCrop,
  PipelineCanvas,
  PipelineFontDescriptors,
  PipelineImage,
  PipelineImageData,
  PipelinePlatform,
} from '@shinobu/image-pipeline';
import { base64ToBlob, canvasToPngBlobSync } from '@shinobu/image-pipeline/protocol';
import { encodeCanvasToPngInWorker } from './pngWorkerEncoder';

const pendingFonts = new Map<string, Promise<void>>();

function registerFont(
  path: string,
  family: string,
  descriptors?: PipelineFontDescriptors,
): void {
  const key = `${path}\u0000${family}\u0000${descriptors?.style ?? ''}\u0000${descriptors?.weight ?? ''}`;
  if (pendingFonts.has(key)) return;

  const task = (async () => {
    // An optional benchmark observer separates font I/O from FontFace parsing.
    const observe = (globalThis as {
      __shinobuColdStartInitMark?: (record: Record<string, unknown>) => void;
    }).__shinobuColdStartInitMark;
    const mark = (phase: string, startedAt: number, data?: Record<string, unknown>) => {
      if (!observe) return;
      try {
        observe({ phase, family, startedAt, durationMs: performance.now() - startedAt, ...data });
      } catch {
        // Diagnostic callbacks never affect font loading or output.
      }
    };
    const startedAt = observe ? performance.now() : 0;
    let stageStartedAt = startedAt;
    let status = 'failed';
    try {
      const response = await fetch(path);
      mark('font.fetch', stageStartedAt, { httpStatus: response.status });
      if (!response.ok) {
        throw new Error(`字体下载失败: ${response.status}`);
      }
      stageStartedAt = observe ? performance.now() : 0;
      const bytes = await response.arrayBuffer();
      mark('font.body', stageStartedAt, { bytes: bytes.byteLength });
      stageStartedAt = observe ? performance.now() : 0;
      let face: FontFace;
      if ((globalThis as { __shinobuColdStartFontBlobUrl?: boolean }).__shinobuColdStartFontBlobUrl === true
        && typeof URL.createObjectURL === 'function') {
        try {
          let fontUrl: string | undefined;
          try {
            // A Blob FontResource can use Chromium's background font decoder.
            // Keep exactly the fetched bytes and let FontFace retain the loaded data.
            fontUrl = URL.createObjectURL(new Blob([bytes], { type: 'font/woff2' }));
            const constructStartedAt = observe ? performance.now() : 0;
            face = new FontFace(family, `url("${fontUrl}")`, descriptors);
            mark('font.blob-url-construct', constructStartedAt);
            await face.load();
            mark('font.blob-url-loaded', stageStartedAt);
          } finally {
            if (fontUrl !== undefined) URL.revokeObjectURL(fontUrl);
          }
        } catch {
          // CSP/API/URL-load failures keep the original binary-font behavior.
          mark('font.blob-url-fallback', stageStartedAt);
          face = new FontFace(family, bytes, descriptors);
          await face.load();
        }
      } else {
        face = new FontFace(family, bytes, descriptors);
        await face.load();
      }
      mark('font.face-load', stageStartedAt);
      stageStartedAt = observe ? performance.now() : 0;
      document.fonts.add(face);
      mark('font.add', stageStartedAt);
      status = 'success';
    } finally {
      mark('font.register', startedAt, { status });
    }
  })();
  pendingFonts.set(key, task);
}

export const browserPipelinePlatform: PipelinePlatform = {
  createCanvas(width: number, height: number): PipelineCanvas {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },

  createImage(): PipelineImage {
    return new Image();
  },

  loadImage(src: string): Promise<PipelineImage> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = src;
    });
  },

  createImageBitmap(image: PipelineImage, crop?: ImageCrop): Promise<ImageBitmap> {
    if (!crop) {
      return globalThis.createImageBitmap(image as HTMLImageElement);
    }
    const surface = document.createElement('canvas');
    surface.width = Math.max(1, Math.round(crop.width));
    surface.height = Math.max(1, Math.round(crop.height));
    const context = surface.getContext('2d', { alpha: false });
    if (!context) {
      throw new Error('创建切片画布失败');
    }
    context.drawImage(
      image as CanvasImageSource,
      crop.x, crop.y, crop.width, crop.height,
      0, 0, surface.width, surface.height,
    );
    return globalThis.createImageBitmap(surface);
  },

  createImageData(width: number, height: number): PipelineImageData {
    return new ImageData(width, height);
  },

  encodeCanvasToPng(canvas: PipelineCanvas): Blob | Promise<Blob> {
    if ((globalThis as { __shinobuColdStartWorkerPng?: boolean })
      .__shinobuColdStartWorkerPng === true && typeof Worker !== 'undefined'
      && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined') {
      return encodeCanvasToPngInWorker(canvas);
    }
    if ((globalThis as { __shinobuColdStartOffscreenPng?: boolean })
      .__shinobuColdStartOffscreenPng === true && typeof OffscreenCanvas !== 'undefined') {
      const surface = new OffscreenCanvas(canvas.width, canvas.height);
      const context = surface.getContext('2d');
      if (!context) throw new Error('导出译图失败');
      context.globalCompositeOperation = 'copy';
      context.drawImage(canvas as HTMLCanvasElement, 0, 0);
      return surface.convertToBlob({ type: 'image/png' }).finally(() => {
        surface.width = 0;
        surface.height = 0;
      });
    }
    // Chromium's async Blob export can wait 1s for an idle task in an
    // offscreen document. This host has no visible UI, so encode synchronously.
    return canvasToPngBlobSync(canvas);
  },

  /**
   * 回传用编码：WebP（有损 0.95）。720×2800 的译图 PNG 常有 10–12MB，
   * 每张都要过 offscreen → background → content 两跳，体积直接决定等待时间；
   * WebP 同画质只有 1/10 左右，文字边缘在 0.95 档基本看不出差别。
   */
  encodeCanvasForTransfer(canvas: PipelineCanvas): Blob | Promise<Blob> {
    const quality = 0.95;
    if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
      return canvas.convertToBlob({ type: 'image/webp', quality }).catch(() => canvasToPngBlobSync(canvas));
    }
    const surface = canvas as HTMLCanvasElement;
    try {
      const dataUrl = surface.toDataURL('image/webp', quality);
      const prefix = 'data:image/webp;base64,';
      if (dataUrl.startsWith(prefix)) {
        return base64ToBlob(dataUrl.slice(prefix.length), 'image/webp');
      }
    } catch {
      // 浏览器不支持 WebP 导出时退回 PNG。
    }
    return canvasToPngBlobSync(canvas);
  },

  registerFont,

  async waitForFonts(): Promise<void> {
    await Promise.all(pendingFonts.values());
  },
};
