import type {
  ImageCrop,
  PlatformProvider,
  PipelineCanvas,
  PipelineImageData,
} from "../runtime/platform";
import {
  isContextLostRuntimeError,
  type ModelRuntime,
  type RuntimeProvider,
  type TensorTransport,
  type WebNnDeviceType,
  type WorkerSessionHandle,
} from '@shinobu/model-runtime';
import { toErrorMessage } from '../errorMessage';
import { clamp } from "./utils";

export type InpaintResult = {
  canvas: PipelineCanvas;
  actualProvider: RuntimeProvider;
  actualWebnnDeviceType?: WebNnDeviceType;
};

export type PreparedInpaintSource = {
  sourceCanvas: PipelineCanvas;
  width: number;
  height: number;
  direct: boolean;
  rgba: Uint8ClampedArray;
  imageData?: PipelineImageData;
};

type InpaintInputNormalize = "zero_to_one" | "minus_one_to_one";
type InpaintOutputNormalize = InpaintInputNormalize | "zero_to_255";
type InpaintMaskFill = "zero_before_normalize" | "zero_after_normalize";

function inpaintPixelFastPath(): boolean {
  return (globalThis as typeof globalThis & {
    __shinobuColdStartInpaintPixels?: boolean;
  }).__shinobuColdStartInpaintPixels === true;
}

function inpaintDirectPixelFastPath(): boolean {
  return (globalThis as typeof globalThis & {
    __shinobuColdStartInpaintDirectPixels?: boolean;
  }).__shinobuColdStartInpaintDirectPixels === true;
}

function pickInpaintTensor(outputs: Record<string, TensorTransport>): TensorTransport | null {
  for (const value of Object.values(outputs)) {
    if (value.dims.length === 4 && value.dims[0] === 1 && value.dims[1] === 3) {
      return value;
    }
  }
  return null;
}

function preprocessInpaintImage(
  source: PipelineCanvas,
  mask: PipelineCanvas,
  size: number,
  normalize: InpaintInputNormalize,
  maskFill: InpaintMaskFill,
  platform: PlatformProvider,
  crop?: ImageCrop,
): {
  image: TensorTransport;
  mask: TensorTransport;
  sourceRgba: Uint8ClampedArray;
  maskBinary: Float32Array;
} {
  const useCrop = crop
    && (crop.x !== 0 || crop.y !== 0 || crop.width !== source.width || crop.height !== source.height);
  const imageCanvas = platform.createCanvas(size, size);
  const imageCtx = imageCanvas.getContext("2d", { willReadFrequently: true });
  if (!imageCtx) {
    throw new Error("去字 ONNX 图像预处理失败");
  }
  if (useCrop) {
    imageCtx.drawImage(source, crop!.x, crop!.y, crop!.width, crop!.height, 0, 0, size, size);
  } else {
    imageCtx.drawImage(source, 0, 0, size, size);
  }
  const imageData = imageCtx.getImageData(0, 0, size, size).data;

  const maskCanvas = platform.createCanvas(size, size);
  const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });
  if (!maskCtx) {
    throw new Error("去字 ONNX 遮罩预处理失败");
  }
  if (useCrop) {
    maskCtx.drawImage(mask, crop!.x, crop!.y, crop!.width, crop!.height, 0, 0, size, size);
  } else {
    maskCtx.drawImage(mask, 0, 0, size, size);
  }
  const maskData = maskCtx.getImageData(0, 0, size, size).data;

  const area = size * size;
  const imageOut = new Float32Array(3 * area);
  const maskOut = new Float32Array(area);
  const sourceRgba = inpaintPixelFastPath() ? imageData : new Uint8ClampedArray(imageData);
  for (let i = 0, p = 0; i < area; i += 1, p += 4) {
    const maskValue = maskData[p] > 127 ? 1 : 0;
    maskOut[i] = maskValue;
    const sourceR = imageData[p];
    const sourceG = imageData[p + 1];
    const sourceB = imageData[p + 2];
    if (normalize === "minus_one_to_one") {
      const r = sourceR / 127.5 - 1;
      const g = sourceG / 127.5 - 1;
      const b = sourceB / 127.5 - 1;
      if (maskValue === 1) {
        const fill = maskFill === "zero_after_normalize" ? 0 : -1;
        imageOut[i] = fill;
        imageOut[area + i] = fill;
        imageOut[2 * area + i] = fill;
      } else {
        imageOut[i] = r;
        imageOut[area + i] = g;
        imageOut[2 * area + i] = b;
      }
    } else {
      imageOut[i] = maskValue === 1 ? 0 : sourceR / 255;
      imageOut[area + i] = maskValue === 1 ? 0 : sourceG / 255;
      imageOut[2 * area + i] = maskValue === 1 ? 0 : sourceB / 255;
    }
  }
  return {
    image: { data: imageOut, dims: [1, 3, size, size], type: "float32" },
    mask: { data: maskOut, dims: [1, 1, size, size], type: "float32" },
    sourceRgba,
    maskBinary: maskOut
  };
}

/**
 * Whether a crop rect already covers the whole source canvas.
 *
 * `crop` is always expressed in *source* coordinates, so the comparison must use
 * the source size. Comparing against the destination size instead breaks the
 * moment a band happens to be exactly as big as the destination (e.g. a 720×720
 * first band of a 720×8439 strip): the whole strip then gets squashed into that
 * one band and pasted back, which shows up as stretched, repeated artwork.
 */
export function cropCoversSource(
  crop: ImageCrop | undefined,
  source: { width: number; height: number },
): boolean {
  if (!crop) return true;
  return crop.x === 0 && crop.y === 0
    && crop.width === source.width && crop.height === source.height;
}

function readCanvasRgba(
  source: PipelineCanvas,
  width: number,
  height: number,
  platform: PlatformProvider,
  crop?: ImageCrop,
): Uint8ClampedArray {
  const canvas = platform.createCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("去字 ONNX 读取原图失败");
  }
  if (cropCoversSource(crop, source)) {
    ctx.drawImage(source, 0, 0, width, height);
  } else {
    ctx.drawImage(source, crop!.x, crop!.y, crop!.width, crop!.height, 0, 0, width, height);
  }
  const data = ctx.getImageData(0, 0, width, height).data;
  return inpaintPixelFastPath() ? data : new Uint8ClampedArray(data);
}

function readDirectCanvasImageData(source: PipelineCanvas, width: number, height: number): PipelineImageData {
  const ctx = source.getContext("2d");
  if (!ctx) throw new Error("去字 ONNX 读取原图失败");
  return ctx.getImageData(0, 0, width, height);
}

export function prepareInpaintSource(sourceCanvas: PipelineCanvas, platform: PlatformProvider): PreparedInpaintSource {
  const { width, height } = sourceCanvas;
  const direct = inpaintDirectPixelFastPath();
  const imageData = direct ? readDirectCanvasImageData(sourceCanvas, width, height) : undefined;
  return {
    sourceCanvas, width, height, direct, imageData,
    rgba: imageData?.data ?? readCanvasRgba(sourceCanvas, width, height, platform),
  };
}

function readMaskBinary(
  mask: PipelineCanvas,
  width: number,
  height: number,
  platform: PlatformProvider,
  crop?: ImageCrop,
): Float32Array | Uint8Array {
  const direct = inpaintDirectPixelFastPath()
    && mask.width === width && mask.height === height && cropCoversSource(crop, mask);
  const canvas = direct ? mask : platform.createCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("去字 ONNX 读取遮罩失败");
  }
  if (!direct) {
    if (crop) {
      ctx.drawImage(mask, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
    } else {
      ctx.drawImage(mask, 0, 0, width, height);
    }
  }
  const data = ctx.getImageData(0, 0, width, height).data;
  const out = inpaintPixelFastPath() ? new Uint8Array(width * height) : new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) {
    out[i] = data[p] > 127 ? 1 : 0;
  }
  return out;
}

function resizeRgba(
  sourceRgba: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  outWidth: number,
  outHeight: number,
  platform: PlatformProvider,
): Uint8ClampedArray {
  const sourceCanvas = platform.createCanvas(sourceWidth, sourceHeight);
  const sourceCtx = sourceCanvas.getContext("2d");
  if (!sourceCtx) {
    throw new Error("去字 ONNX 图像缩放失败");
  }
  const sourceImage = sourceCtx.createImageData(sourceWidth, sourceHeight);
  sourceImage.data.set(sourceRgba);
  sourceCtx.putImageData(sourceImage, 0, 0);

  const outCanvas = platform.createCanvas(outWidth, outHeight);
  const outCtx = outCanvas.getContext("2d", { willReadFrequently: true });
  if (!outCtx) {
    throw new Error("去字 ONNX 图像缩放失败");
  }
  outCtx.drawImage(sourceCanvas, 0, 0, outWidth, outHeight);
  const data = outCtx.getImageData(0, 0, outWidth, outHeight).data;
  return inpaintPixelFastPath() ? data : new Uint8ClampedArray(data);
}

function decodeInpaintTensor(
  tensor: TensorTransport,
  width: number,
  height: number,
  normalize: InpaintOutputNormalize
): Uint8ClampedArray {
  const area = width * height;
  const data = tensor.data;
  if (!(data instanceof Float32Array)) {
    throw new Error("去字 ONNX 输出类型不支持");
  }
  const out = new Uint8ClampedArray(area * 4);
  for (let i = 0, p = 0; i < area; i += 1, p += 4) {
    const r = data[i];
    const g = data[area + i];
    const b = data[2 * area + i];
    const rr =
      normalize === "minus_one_to_one" ? (r + 1) * 127.5 : normalize === "zero_to_255" ? r : r * 255;
    const gg =
      normalize === "minus_one_to_one" ? (g + 1) * 127.5 : normalize === "zero_to_255" ? g : g * 255;
    const bb =
      normalize === "minus_one_to_one" ? (b + 1) * 127.5 : normalize === "zero_to_255" ? b : b * 255;
    out[p] = clamp(Math.round(rr), 0, 255);
    out[p + 1] = clamp(Math.round(gg), 0, 255);
    out[p + 2] = clamp(Math.round(bb), 0, 255);
    out[p + 3] = 255;
  }
  return out;
}

function composeInpaintResult(
  sourceRgba: Uint8ClampedArray,
  inpaintedRgba: Uint8ClampedArray,
  maskBinary: Float32Array | Uint8Array,
  width: number,
  height: number,
  platform: PlatformProvider,
  reusableSourceImage?: PipelineImageData,
): PipelineCanvas {
  const canvas = platform.createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("去字 ONNX 合成失败");
  }
  // getImageData owns this copy; patching it cannot mutate the input canvas.
  const image = reusableSourceImage ?? ctx.createImageData(width, height);
  const area = width * height;
  if (inpaintPixelFastPath() && image.data.byteOffset % 4 === 0
    && sourceRgba.byteOffset % 4 === 0 && inpaintedRgba.byteOffset % 4 === 0) {
    const source = new Uint32Array(sourceRgba.buffer, sourceRgba.byteOffset, area);
    const inpainted = new Uint32Array(inpaintedRgba.buffer, inpaintedRgba.byteOffset, area);
    const pixels = new Uint32Array(image.data.buffer, image.data.byteOffset, area);
    const opaqueAlpha = new Uint32Array(new Uint8Array([0, 0, 0, 255]).buffer)[0];
    for (let i = 0; i < area; i += 1) {
      pixels[i] = ((maskBinary[i] >= 0.5 ? inpainted[i] : source[i]) & ~opaqueAlpha) | opaqueAlpha;
    }
  } else for (let i = 0, p = 0; i < area; i += 1, p += 4) {
    const useInpainted = maskBinary[i] >= 0.5;
    image.data[p] = useInpainted ? inpaintedRgba[p] : sourceRgba[p];
    image.data[p + 1] = useInpainted ? inpaintedRgba[p + 1] : sourceRgba[p + 1];
    image.data[p + 2] = useInpainted ? inpaintedRgba[p + 2] : sourceRgba[p + 2];
    image.data[p + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function isLikelyInvalidInpaintResult(
  sourceRgba: Uint8ClampedArray,
  inpaintedRgba: Uint8ClampedArray,
  maskBinary: Float32Array
): boolean {
  let maskedCount = 0;
  let sourceLumaSum = 0;
  let inpaintLumaSum = 0;
  let nearlyBlackCount = 0;

  for (let i = 0, p = 0; i < maskBinary.length; i += 1, p += 4) {
    if (maskBinary[i] < 0.5) {
      continue;
    }
    maskedCount += 1;

    const sourceLuma =
      sourceRgba[p] * 0.299 + sourceRgba[p + 1] * 0.587 + sourceRgba[p + 2] * 0.114;
    const inpaintLuma =
      inpaintedRgba[p] * 0.299 + inpaintedRgba[p + 1] * 0.587 + inpaintedRgba[p + 2] * 0.114;

    sourceLumaSum += sourceLuma;
    inpaintLumaSum += inpaintLuma;
    if (inpaintLuma <= 8) {
      nearlyBlackCount += 1;
    }
  }

  if (maskedCount < 64) {
    return false;
  }

  const sourceMean = sourceLumaSum / maskedCount;
  const inpaintMean = inpaintLumaSum / maskedCount;
  const blackRatio = nearlyBlackCount / maskedCount;

  return sourceMean >= 40 && inpaintMean <= 10 && blackRatio >= 0.9;
}

async function runInpaintByOnnx(
  originalCanvas: PipelineCanvas,
  refinedMaskCanvas: PipelineCanvas,
  platform: PlatformProvider,
  modelRuntime: ModelRuntime,
  preparedSource?: PreparedInpaintSource,
  crop?: ImageCrop,
): Promise<InpaintResult> {
  const profile = (globalThis as typeof globalThis & {
    __shinobuColdStartInpaintProfile?: boolean;
  }).__shinobuColdStartInpaintProfile === true;
  const phases: Record<string, number> = {};
  let phaseStart = profile ? performance.now() : 0;
  const mark = (phase: string): void => {
    if (!profile) return;
    const now = performance.now();
    phases[phase] = now - phaseStart;
    phaseStart = now;
  };
  const model = await modelRuntime.readModel("inpaint");
  const primaryHandle = await modelRuntime.getSession("inpaint", ["webgpu", "webnn", "wasm"]);
  const size = model.input?.[0] ?? 512;
  const normalize = model.normalize ?? "zero_to_one";
  const outputNormalize = model.outputNormalize ?? normalize;
  const maskFill = model.maskFill ?? "zero_before_normalize";
  if (refinedMaskCanvas.width <= 0 || refinedMaskCanvas.height <= 0) {
    throw new Error("去字 ONNX 缺少有效 refined mask，已禁用文本框遮罩回退");
  }
  mark('setup');
  const feeds = preprocessInpaintImage(originalCanvas, refinedMaskCanvas, size, normalize, maskFill, platform, crop);
  mark('preprocess');
  const runWithHandle = async (handle: WorkerSessionHandle): Promise<Record<string, TensorTransport>> => {
    const imageName = handle.inputNames[0];
    const maskName = model.maskInputName ?? handle.inputNames[1];
    if (!imageName || !maskName) {
      throw new Error("去字 ONNX 模型输入定义不完整");
    }
    const result = await modelRuntime.run(handle.sessionId, {
      [imageName]: feeds.image,
      [maskName]: feeds.mask
    });
    if (result.error) throw new Error(result.error);
    return result.outputs;
  };

  const decodeOutputs = (outputs: Record<string, TensorTransport>): Uint8ClampedArray => {
    const outTensor = pickInpaintTensor(outputs);
    if (!outTensor) {
      throw new Error("去字 ONNX 模型输出未匹配到图像张量");
    }
    return decodeInpaintTensor(outTensor, size, size, outputNormalize);
  };

  let actualProvider: RuntimeProvider = primaryHandle.provider;
  let actualWebnnDeviceType = primaryHandle.webnnDeviceType;
  let outputTensors: Record<string, TensorTransport>;
  try {
    outputTensors = await runWithHandle(primaryHandle);
  } catch (error) {
    const message = toErrorMessage(error);
    const reason = isContextLostRuntimeError(error) ? "context lost" : "run failed";
    if (primaryHandle.provider === "wasm") {
      throw error;
    }

    const fallbackPlans: RuntimeProvider[][] = [];
    if (primaryHandle.provider === "webgpu") {
      fallbackPlans.push(["webnn", "wasm"]);
    }
    fallbackPlans.push(["wasm"]);

    let recovered: Record<string, TensorTransport> | null = null;
    let lastFallbackError: unknown = null;
    console.warn(`[inpaint] ${primaryHandle.provider} ${reason}, 尝试回退: ${message}`);

    for (const preferred of fallbackPlans) {
      try {
        const handle = await modelRuntime.getSession("inpaint", preferred);
        recovered = await runWithHandle(handle);
        if (handle.provider !== primaryHandle.provider) {
          console.warn(`[inpaint] 已回退到 ${handle.provider}`);
          actualProvider = handle.provider;
          actualWebnnDeviceType = handle.webnnDeviceType;
        }
        break;
      } catch (fallbackError) {
        lastFallbackError = fallbackError;
      }
    }

    if (!recovered) {
      const fallbackMessage = lastFallbackError ? toErrorMessage(lastFallbackError) : "未知错误";
      throw new Error(`去字推理失败且回退失败: ${message} | fallback: ${fallbackMessage}`);
    }

    outputTensors = recovered;
  }

  mark('modelRun');
  let inpaintedRgba = decodeOutputs(outputTensors);

  if (
    actualProvider === "webnn" &&
    isLikelyInvalidInpaintResult(feeds.sourceRgba, inpaintedRgba, feeds.maskBinary)
  ) {
    const wasmHandle = await modelRuntime.getSession("inpaint", ["wasm"]);
    const wasmOutputTensors = await runWithHandle(wasmHandle);
    inpaintedRgba = decodeOutputs(wasmOutputTensors);
    actualProvider = "wasm";
    actualWebnnDeviceType = undefined;
  }
  mark('decode');

  const outputWidth = crop ? crop.width : originalCanvas.width;
  const outputHeight = crop ? crop.height : originalCanvas.height;
  // Whole-canvas snapshots only apply when we are not reading a sub-rectangle.
  const usablePreparedSource = !crop
    && preparedSource?.sourceCanvas === originalCanvas
    && preparedSource.width === outputWidth && preparedSource.height === outputHeight
    && preparedSource.rgba.length === outputWidth * outputHeight * 4
    && preparedSource.direct === inpaintDirectPixelFastPath()
    && (!preparedSource.direct || (preparedSource.imageData?.width === outputWidth
      && preparedSource.imageData.height === outputHeight && preparedSource.imageData.data === preparedSource.rgba))
    ? preparedSource : undefined;
  const originalSourceImage = !crop && inpaintDirectPixelFastPath()
    ? readDirectCanvasImageData(originalCanvas, outputWidth, outputHeight)
    : undefined;
  const originalSourceRgba = usablePreparedSource?.rgba ?? originalSourceImage?.data
    ?? readCanvasRgba(originalCanvas, outputWidth, outputHeight, platform, crop);
  mark('readOriginal');
  const originalMaskBinary = readMaskBinary(refinedMaskCanvas, outputWidth, outputHeight, platform, crop);
  mark('readMask');
  const inpaintedRgbaAtOriginalSize = resizeRgba(inpaintedRgba, size, size, outputWidth, outputHeight, platform);
  mark('resize');

  const canvas = composeInpaintResult(
    originalSourceRgba,
    inpaintedRgbaAtOriginalSize,
    originalMaskBinary,
    outputWidth,
    outputHeight,
    platform,
    originalSourceImage,
  );
  mark('compose');
  if (profile) console.log('[shinobu:inpaint-profile]', JSON.stringify({ actualProvider, phases }));

  return { canvas, actualProvider, actualWebnnDeviceType };
}

/**
 * Height/width ratio above which the page is erased band by band.
 *
 * The inpaint model works on a 512² canvas. Squeezing a 720×8439 webtoon strip
 * whole into that input makes one model pixel cover ~16×16 source pixels, so
 * erased lettering turns into smeared blocks. Banding keeps the erased region
 * at (nearly) native resolution.
 */
export const INPAINT_TILE_TRIGGER_ASPECT = 2.2;

/** Coarse row projection of the refined mask, used to skip empty bands cheaply. */
function buildMaskRowIndex(
  maskCanvas: PipelineCanvas,
  platform: PlatformProvider,
  width: number,
  height: number,
  scale = 8,
): { rows: Uint8Array; scale: number } {
  const pw = Math.max(1, Math.round(width / scale));
  const ph = Math.max(1, Math.round(height / scale));
  const canvas = platform.createCanvas(pw, ph);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return { rows: new Uint8Array(0), scale };
  }
  ctx.drawImage(maskCanvas, 0, 0, pw, ph);
  const data = ctx.getImageData(0, 0, pw, ph).data;
  const rows = new Uint8Array(ph);
  for (let y = 0; y < ph; y += 1) {
    const rowStart = y * pw * 4;
    for (let x = 0; x < pw; x += 1) {
      if (data[rowStart + x * 4] > 96) {
        rows[y] = 1;
        break;
      }
    }
  }
  return { rows, scale };
}

function bandHasMask(
  index: { rows: Uint8Array; scale: number },
  y: number,
  height: number,
): boolean {
  if (index.rows.length === 0) return true;
  const start = Math.max(0, Math.floor(y / index.scale));
  const end = Math.min(index.rows.length, Math.ceil((y + height) / index.scale));
  // Include one row either side so a band edge never drops its only evidence.
  for (let row = Math.max(0, start - 1); row < Math.min(index.rows.length, end + 1); row += 1) {
    if (index.rows[row] === 1) return true;
  }
  return false;
}

/** Split a tall canvas into overlapping erasing bands. */
export function planInpaintBands(
  width: number,
  height: number,
  bandHeight: number,
  overlapRatio = 0.15,
): ImageCrop[] {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const safeBand = Math.min(safeHeight, Math.max(1, Math.round(bandHeight)));
  const stride = Math.max(1, Math.round(safeBand * (1 - Math.min(0.4, Math.max(0, overlapRatio)))));
  const bands: ImageCrop[] = [];
  for (let y = 0; y < safeHeight; y += stride) {
    bands.push({
      x: 0,
      y,
      width: safeWidth,
      height: Math.min(safeBand, safeHeight - y),
    });
    if (y + safeBand >= safeHeight) break;
  }
  return bands;
}

async function runInpaintByOnnxTiled(
  originalCanvas: PipelineCanvas,
  refinedMaskCanvas: PipelineCanvas,
  platform: PlatformProvider,
  modelRuntime: ModelRuntime,
): Promise<InpaintResult> {
  const model = await modelRuntime.readModel("inpaint");
  const size = model.input?.[0] ?? 512;
  const width = originalCanvas.width;
  const height = originalCanvas.height;

  // A square band keeps the model's scale factor uniform in both axes.
  const bandHeight = Math.min(height, Math.max(size, width));
  const bands = planInpaintBands(width, height, bandHeight);

  const outCanvas = platform.createCanvas(width, height);
  const outCtx = outCanvas.getContext("2d");
  if (!outCtx) {
    throw new Error("去字分带拼接画布创建失败");
  }
  outCtx.drawImage(originalCanvas, 0, 0);

  const rowIndex = buildMaskRowIndex(refinedMaskCanvas, platform, width, height);
  let actualProvider: RuntimeProvider = "wasm";
  let actualWebnnDeviceType: WebNnDeviceType | undefined;
  let erasedBands = 0;
  let skippedBands = 0;

  for (const crop of bands) {
    if (!bandHasMask(rowIndex, crop.y, crop.height)) {
      skippedBands += 1;
      continue;
    }
    const result = await runInpaintByOnnx(
      originalCanvas,
      refinedMaskCanvas,
      platform,
      modelRuntime,
      undefined,
      crop,
    );
    outCtx.drawImage(result.canvas, 0, crop.y);
    actualProvider = result.actualProvider ?? actualProvider;
    actualWebnnDeviceType = result.actualWebnnDeviceType ?? actualWebnnDeviceType;
    erasedBands += 1;
  }

  console.log(
    `[inpaint] 长条图分带擦除: ${width}x${height} → ${erasedBands} 带已擦除, ${skippedBands} 带跳过 `
    + `(带高 ${bandHeight})`
  );
  return { canvas: outCanvas, actualProvider, actualWebnnDeviceType };
}

export async function runInpaint(
  originalCanvas: PipelineCanvas,
  refinedMaskCanvas: PipelineCanvas,
  platform: PlatformProvider,
  modelRuntime: ModelRuntime,
  preparedSource?: PreparedInpaintSource,
): Promise<InpaintResult> {
  const { width, height } = originalCanvas;
  const maskMatchesCanvas = refinedMaskCanvas.width === width && refinedMaskCanvas.height === height;
  if (maskMatchesCanvas && height / Math.max(1, width) > INPAINT_TILE_TRIGGER_ASPECT) {
    return runInpaintByOnnxTiled(originalCanvas, refinedMaskCanvas, platform, modelRuntime);
  }
  return runInpaintByOnnx(originalCanvas, refinedMaskCanvas, platform, modelRuntime, preparedSource);
}
