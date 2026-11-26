/**
 * Upload sizing for the WebGPU detector preprocessing.
 *
 * Kept dependency-free so the boundary can be unit tested without pulling in
 * onnxruntime-web or a real GPU device.
 */

export type TextureUploadPlan = {
  width: number;
  height: number;
  /** true when the page had to be shrunk to fit the adapter's limit. */
  scaled: boolean;
};

/** Most desktop adapters expose 8192; a few expose 16384. */
export const DEFAULT_MAX_TEXTURE_DIMENSION = 8192;

/**
 * Decide the texture size used to upload a page image.
 *
 * WebGPU refuses any texture larger than `maxTextureDimension2D`, and a failed
 * `createTexture` loses the whole device — after which every following page
 * silently drops to the CPU path. Manga and webtoon pages are routinely taller
 * than that limit, so they are scaled down for the upload only: the detector
 * input is far smaller than either dimension, so nothing measurable is lost.
 */
export function planTextureUpload(
  srcWidth: number,
  srcHeight: number,
  maxTextureSize: number,
): TextureUploadPlan {
  const width = Math.max(1, Math.round(srcWidth));
  const height = Math.max(1, Math.round(srcHeight));
  const limit = Math.max(
    1,
    Math.floor(maxTextureSize) || DEFAULT_MAX_TEXTURE_DIMENSION,
  );

  if (width <= limit && height <= limit) {
    return { width, height, scaled: false };
  }

  // One uniform scale keeps the aspect ratio; floor() guarantees the result
  // never rounds back up past the limit.
  const scale = Math.min(limit / width, limit / height);
  return {
    width: Math.max(1, Math.min(limit, Math.floor(width * scale))),
    height: Math.max(1, Math.min(limit, Math.floor(height * scale))),
    scaled: true,
  };
}
