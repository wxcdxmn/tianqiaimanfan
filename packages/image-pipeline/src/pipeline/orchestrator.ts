import type {
  PipelineArtifacts,
  PipelineConfig,
  PipelineProgress,
  PipelineStageRegions,
  PipelineTypesetDebugLog,
  RuntimeStageStatus,
  StageTiming,
  TextRegion,
  TranslationDebugInfo,
  MaskDebugLayers,
} from "../types";
import type { PlatformProvider, PipelineCanvas } from "../runtime/platform";
import { fileToImage, imageToCanvas } from "./image";
import { detectTextRegionsWithMask, type DetectionFallbackStrategy } from './detect';
import {
  materializePrecomputedDetection,
  type PrecomputedTextDetection,
} from './detect/precomputedDetection';
import { runOcr } from "./ocr";
import { isSiteWatermarkRegion } from "./ocr/watermark";
import { expandOcrRetryBox, isUsableOcrRetry, MAX_OCR_RETRIES } from "./ocr/retry";
import { preparePaddleOcrRuntime, warmupPaddleOcrRuntime } from "./ocr/paddleocrProvider";
import { prepareInpaintSource, runInpaint, type PreparedInpaintSource } from "./inpaint";
import { drawTypeset } from "./typeset";
import { drawRegions } from "./visualize";
import { mergeStackedTextFragments, mergeTextLines } from "./textlineMerge";
import { planUntranslatedRestore } from "./untranslatedRestore";
import {
  filterOcrRegions,
} from "./ocrPostFilter";
import { OCR_POST_FILTER_RULE_ID } from "./ocrPostFilter/rule";
import { MaskRefinementImageError, prepareTextMaskGray, refineTextMask, type PreparedTextMaskGray } from "./maskRefinement";
import { prepareReadingPanels, sortRegionsForRender, type PreparedReadingPanels } from "./readingOrder";
import { detectBubbles, matchRegionsToBubbles, type BubbleDetection } from "./bubbleDetect";
import {
  type ModelRuntime,
  type WorkerSessionHandle,
} from '@shinobu/model-runtime';
import {
  toDiagnosticError,
  type DiagnosticLogCategory,
  type DiagnosticLogObserver,
} from "@shinobu/diagnostics";
import { createCancelledError } from "../protocol";
import type { TextTranslator } from '@shinobu/text-translation';
import { hasTranslatableText } from '../translatableText';
import { describeVisionRegions, type VisionRegionClassifier } from './visionRegionFilter';
import { buildEraseLayerCanvases } from '../editor/eraseLayers';
import type { EditableLayerCanvases, RegionMaskOwnership } from '../editor/types';
import {
  isPipelineFailureEnvelope,
  type PipelineFailureEnvelope,
} from "@shinobu/image-pipeline";

type ProgressCallback = (progress: PipelineProgress) => void;

/**
 * 换模型补识别的触发门槛：既要有足够多的漏识框（避免为 1-2 个音效字多跑一遍模型），
 * 也要漏识占比足够高（正常页面偶发漏一两行不值得换模型）。
 */
const MIN_OCR_ALTERNATE_MODEL_REGIONS = 3;
const MIN_OCR_ALTERNATE_MODEL_SHARE = 0.25;

/**
 * 没拿到译文的区域把原始像素贴回去。
 *
 * 去字阶段与翻译阶段并行，去字时并不知道哪些框最终会翻译失败；失败的框于是被擦成空白，
 * 排版又跳过它们，读者看到的是一片被抹掉的对白。这里按框把原图局部还原，
 * 让「没翻译」表现为「这处没动过」。被还原的框同时标记 translationFailed，
 * 排版阶段据此跳过，避免再把原文叠一遍。
 */
function restoreUntranslatedRegions(
  cleaned: PipelineCanvas,
  original: PipelineCanvas,
  regions: TextRegion[],
): Set<string> {
  const restored = new Set<string>();
  const { restore } = planUntranslatedRestore(regions);
  if (restore.length === 0) {
    return restored;
  }
  const targetContext = cleaned.getContext('2d');
  const sourceContext = original.getContext('2d');
  if (!targetContext || !sourceContext) {
    return restored;
  }
  for (const region of restore) {
    const x = Math.max(0, Math.floor(region.box.x));
    const y = Math.max(0, Math.floor(region.box.y));
    const right = Math.min(cleaned.width, Math.ceil(region.box.x + region.box.width));
    const bottom = Math.min(cleaned.height, Math.ceil(region.box.y + region.box.height));
    const width = right - x;
    const height = bottom - y;
    if (width <= 0 || height <= 0) {
      continue;
    }
    try {
      targetContext.putImageData(sourceContext.getImageData(x, y, width, height), x, y);
      region.translationFailed = true;
      restored.add(region.id);
    } catch {
      // 跨域画布或像素读取失败：保持擦除结果，不阻断整页。
      break;
    }
  }
  return restored;
}

export type PipelineRunOptions = {
  signal?: AbortSignal;
  stopAfter?: "order";
  platform?: PlatformProvider;
  modelRuntime?: ModelRuntime;
  detectionFallbackStrategy: DetectionFallbackStrategy;
  textTranslator?: TextTranslator;
  classifyVisionRegions?: VisionRegionClassifier;
  observer?: DiagnosticLogObserver;
  precomputedDetection?: PrecomputedTextDetection;
  collectEditableLayers?: boolean;
};

type PaddleOcrRuntimeProbeMode = "legacy" | "prepare" | "warmup";
type PaddleOcrRuntimeProbeSchedule = "after-detect" | "bubble-start" | "after-bubble" | "ocr-start";
type InpaintRuntimeProbeSchedule = "current" | "after-detect" | "bubble-start" | "after-bubble" | "ocr-start";
type BubbleRuntimeProbeSchedule = "current" | "after-detect";

type PipelineRuntimeFlags = typeof globalThis & {
  __shinobuPaddleOcrRuntimeProbe?: PaddleOcrRuntimeProbeMode;
  __shinobuPaddleOcrRuntimeProbeSchedule?: PaddleOcrRuntimeProbeSchedule;
  __shinobuInpaintRuntimeProbeSchedule?: InpaintRuntimeProbeSchedule;
  __shinobuBubbleRuntimeProbeSchedule?: BubbleRuntimeProbeSchedule;
  __shinobuPaddleOcrWarmupInputWidth?: number;
  __shinobuPaddleOcrWarmupBatchSize?: number;
};

function getPaddleOcrRuntimeProbeMode(): PaddleOcrRuntimeProbeMode {
  return (globalThis as PipelineRuntimeFlags).__shinobuPaddleOcrRuntimeProbe ?? "legacy";
}

function getPaddleOcrRuntimeProbeSchedule(): PaddleOcrRuntimeProbeSchedule {
  return (globalThis as PipelineRuntimeFlags).__shinobuPaddleOcrRuntimeProbeSchedule ?? "after-detect";
}

function getInpaintRuntimeProbeSchedule(): InpaintRuntimeProbeSchedule {
  return (globalThis as PipelineRuntimeFlags).__shinobuInpaintRuntimeProbeSchedule ?? "current";
}

function getBubbleRuntimeProbeSchedule(): BubbleRuntimeProbeSchedule {
  return (globalThis as PipelineRuntimeFlags).__shinobuBubbleRuntimeProbeSchedule ?? "current";
}

async function probePaddleOcrRuntime(
  modelRuntime: ModelRuntime,
): Promise<RuntimeStageStatus> {
  const mode = getPaddleOcrRuntimeProbeMode();
  if (mode === "warmup") {
    const flags = globalThis as PipelineRuntimeFlags;
    const warmup = await warmupPaddleOcrRuntime({
      inputWidth: flags.__shinobuPaddleOcrWarmupInputWidth,
      batchSize: flags.__shinobuPaddleOcrWarmupBatchSize,
    }, modelRuntime);
    const providerLabel = warmup.provider === "webnn"
      ? `${warmup.provider}/${warmup.webnnDeviceType ?? "default"}`
      : warmup.provider;
    return {
      model: "ocr",
      enabled: true,
      provider: warmup.provider,
      webnnDeviceType: warmup.provider === "webnn" ? warmup.webnnDeviceType ?? "default" : undefined,
      detail: `Paddle OCR warmup 完成 (${providerLabel}, ${warmup.inputDims.join("x")}, run=${Math.round(warmup.runMs)}ms)`,
    };
  }

  const runtime = await preparePaddleOcrRuntime(modelRuntime);
  const webnnDeviceType = runtime.sessionHandle.provider === "webnn" ? runtime.sessionHandle.webnnDeviceType ?? "default" : undefined;
  const providerLabel = runtime.sessionHandle.provider === "webnn"
    ? `${runtime.sessionHandle.provider}/${webnnDeviceType}`
    : runtime.sessionHandle.provider;
  return {
    model: "ocr",
    enabled: true,
    provider: runtime.sessionHandle.provider,
    webnnDeviceType,
    detail: `Paddle OCR 模型已加载 (${runtime.modelName}, ${providerLabel})`,
  };
}

function buildEraseDebugCanvas(
  originalCanvas: PipelineCanvas,
  debugLayers: MaskDebugLayers,
  platform: PlatformProvider,
  baseCanvas?: PipelineCanvas
): PipelineCanvas {
  const { refinedMask, perRegionDilated, globalDilated, scaledWidth, scaledHeight } = debugLayers;
  const width = originalCanvas.width;
  const height = originalCanvas.height;

  const canvas = platform.createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return canvas;
  }
  ctx.drawImage(baseCanvas ?? originalCanvas, 0, 0);

  // Upscale each layer mask to original resolution via intermediate canvas
  const toScaledCanvas = (mask: Uint8Array): PipelineCanvas => {
    const src = platform.createCanvas(scaledWidth, scaledHeight);
    const srcCtx = src.getContext("2d");
    if (!srcCtx) {
      return src;
    }
    const imageData = srcCtx.createImageData(scaledWidth, scaledHeight);
    for (let i = 0, p = 0; i < mask.length; i += 1, p += 4) {
      const v = mask[i] > 0 ? 255 : 0;
      imageData.data[p] = v;
      imageData.data[p + 1] = v;
      imageData.data[p + 2] = v;
      imageData.data[p + 3] = 255;
    }
    srcCtx.putImageData(imageData, 0, 0);

    const dst = platform.createCanvas(width, height);
    const dstCtx = dst.getContext("2d");
    if (!dstCtx) {
      return dst;
    }
    dstCtx.imageSmoothingEnabled = true;
    dstCtx.drawImage(src, 0, 0, width, height);
    return dst;
  };

  // Green: refinedMask (before any dilation)
  // Yellow: perRegionDilated - refinedMask (per-region dilation increment)
  // Red: globalDilated - perRegionDilated (global dilation increment)

  const greenCanvas = toScaledCanvas(refinedMask);
  const yellowRaw = new Uint8Array(scaledWidth * scaledHeight);
  const redRaw = new Uint8Array(scaledWidth * scaledHeight);
  for (let i = 0; i < refinedMask.length; i += 1) {
    const isRefined = refinedMask[i] > 0;
    const isPerRegion = perRegionDilated[i] > 0;
    const isGlobal = globalDilated[i] > 0;
    if (isRefined) {
      // Green layer (refinedMask base)
    } else if (isPerRegion) {
      yellowRaw[i] = 1;
    } else if (isGlobal) {
      redRaw[i] = 1;
    }
  }
  const yellowCanvas = toScaledCanvas(yellowRaw);
  const redCanvas = toScaledCanvas(redRaw);

  // Overlay each color layer with transparency
  ctx.globalAlpha = 0.5;
  ctx.globalCompositeOperation = "source-over";

  // Green overlay
  const greenData = greenCanvas.getContext("2d")?.getImageData(0, 0, width, height);
  if (greenData) {
    for (let p = 0; p < greenData.data.length; p += 4) {
      if (greenData.data[p] > 127) {
        greenData.data[p] = 0;
        greenData.data[p + 1] = 255;
        greenData.data[p + 2] = 0;
        greenData.data[p + 3] = 128;
      } else {
        greenData.data[p + 3] = 0;
      }
    }
    greenCanvas.getContext("2d")?.putImageData(greenData, 0, 0);
  }
  ctx.drawImage(greenCanvas, 0, 0);

  // Yellow overlay
  const yellowData = yellowCanvas.getContext("2d")?.getImageData(0, 0, width, height);
  if (yellowData) {
    for (let p = 0; p < yellowData.data.length; p += 4) {
      if (yellowData.data[p] > 127) {
        yellowData.data[p] = 255;
        yellowData.data[p + 1] = 255;
        yellowData.data[p + 2] = 0;
        yellowData.data[p + 3] = 128;
      } else {
        yellowData.data[p + 3] = 0;
      }
    }
    yellowCanvas.getContext("2d")?.putImageData(yellowData, 0, 0);
  }
  ctx.drawImage(yellowCanvas, 0, 0);

  // Red overlay
  const redData = redCanvas.getContext("2d")?.getImageData(0, 0, width, height);
  if (redData) {
    for (let p = 0; p < redData.data.length; p += 4) {
      if (redData.data[p] > 127) {
        redData.data[p] = 255;
        redData.data[p + 1] = 0;
        redData.data[p + 2] = 0;
        redData.data[p + 3] = 128;
      } else {
        redData.data[p + 3] = 0;
      }
    }
    redCanvas.getContext("2d")?.putImageData(redData, 0, 0);
  }
  ctx.drawImage(redCanvas, 0, 0);

  ctx.globalAlpha = 1;
  return canvas;
}

function report(cb: ProgressCallback, stage: string, detail: string): void {
  cb({ stage, operation: stage, detail });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw createCancelledError(typeof signal.reason === "string" ? signal.reason : undefined);
}

function logPipelineStage(
  observer: DiagnosticLogObserver | undefined,
  config: PipelineConfig,
  category: DiagnosticLogCategory,
  message: string,
  data?: Record<string, unknown>,
  error?: unknown,
): void {
  if (!config.diagnosticRunId || !observer) return;
  observer.emit({
    runId: config.diagnosticRunId,
    level: error === undefined ? "info" : "error",
    category,
    source: { context: 'pipeline-host', module: 'orchestrator.ts' },
    message,
    data,
    error: error === undefined ? undefined : toDiagnosticError(error),
  });
}

function toErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function hasPipelineFailure(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "failure" in error
    && isPipelineFailureEnvelope(error.failure);
}

type RegionQuad = NonNullable<TextRegion["quad"]>;

function cloneRegionQuad(quad: RegionQuad): RegionQuad {
  return quad.map((point) => ({ ...point })) as RegionQuad;
}

function cloneTextRegions(regions: TextRegion[]): TextRegion[] {
  return regions.map((region) => {
    return {
      ...region,
      box: { ...region.box },
      quad: region.quad ? cloneRegionQuad(region.quad) : undefined,
      fgColor: region.fgColor ? [...region.fgColor] : undefined,
      bgColor: region.bgColor ? [...region.bgColor] : undefined,
      translatedColumns: region.translatedColumns ? [...region.translatedColumns] : undefined,
      sourceLineGeometries: region.sourceLineGeometries?.map((geometry) => ({
        ...geometry,
        box: { ...geometry.box },
        quad: geometry.quad ? cloneRegionQuad(geometry.quad) : undefined,
      })),
      bubbleBox: region.bubbleBox ? { ...region.bubbleBox } : undefined,
      // Stage snapshots are diagnostics, not render inputs. Retaining masks here
      // multiplies memory without adding useful inspection data.
      bubbleMask: undefined,
    };
  });
}

export class PipelineStageError extends Error {
  readonly stage: string;
  readonly stageLabel: string;
  readonly artifacts: PipelineArtifacts;
  readonly failure: PipelineFailureEnvelope;

  constructor(
    stage: string,
    stageLabel: string,
    detail: string,
    artifacts: PipelineArtifacts,
    scope: PipelineFailureEnvelope["scope"],
    cause?: unknown,
  ) {
    super(`${stageLabel}失败: ${detail}`, cause === undefined ? undefined : { cause });
    this.name = "PipelineStageError";
    this.stage = stage;
    this.stageLabel = stageLabel;
    this.artifacts = artifacts;
    this.failure = {
      code: "PIPELINE_STAGE_FAILED",
      stage,
      scope,
      retryable: false,
      messageKey: "pipeline.failure.stage",
      diagnostics: {
        name: this.name,
      },
    };
  }

  get code(): string {
    return this.failure.code;
  }
}

async function probeRuntime(
  modelRuntime: ModelRuntime,
  model: "detector" | "bubble" | "ocr" | "inpaint",
): Promise<RuntimeStageStatus> {
  try {
    let handle: WorkerSessionHandle;
    if (model === "ocr") {
      if (getPaddleOcrRuntimeProbeMode() !== "legacy") {
        return await probePaddleOcrRuntime(modelRuntime);
      }
      const paddleRuntime = await preparePaddleOcrRuntime(modelRuntime);
      handle = paddleRuntime.sessionHandle;
    } else {
      handle = await modelRuntime.getSession(model);
    }
    const webnnDeviceType = handle.provider === "webnn" ? handle.webnnDeviceType ?? "default" : undefined;
    const providerLabel = handle.provider === "webnn" ? `${handle.provider}/${webnnDeviceType}` : handle.provider;
    return {
      model,
      enabled: true,
      provider: handle.provider,
      webnnDeviceType,
      detail: `${model} 模型已加载 (${providerLabel})`
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const stageDetail =
      model === "ocr"
        ? `${model} 模型未启用，OCR 阶段已禁用回退: ${detail}`
        : model === "bubble"
          ? `${model} 模型未启用，气泡检测无法继续: ${detail}`
          : `${model} 模型未启用，使用检测回退流程: ${detail}`;
    return {
      model,
      enabled: false,
      detail: stageDetail
    };
  }
}

export async function runPipeline(
  file: File,
  config: PipelineConfig,
  onProgress: ProgressCallback,
  options: PipelineRunOptions,
): Promise<PipelineArtifacts> {
  const platform = options.platform;
  if (!platform) {
    throw new Error('未配置 PipelinePlatform');
  }
  const modelRuntime = options.modelRuntime;
  if (!modelRuntime) {
    throw new Error('未配置 ModelRuntime');
  }
  const stageTimings: StageTiming[] = [];
  const signal = options.signal;
  const stopAfterOrder = options.stopAfter === "order";
  const collectStagePreviews = (globalThis as typeof globalThis & {
    __shinobuColdStartPixelFastPath?: boolean;
  }).__shinobuColdStartPixelFastPath !== true || stopAfterOrder
    || config.typesetDebug || config.eraseDebug || config.collectDebugLog;

  throwIfCancelled(signal);
  report(onProgress, "load", "加载图片");
  const loadT0 = performance.now();
  const image = await fileToImage(file, platform);
  throwIfCancelled(signal);
  const originalCanvas = imageToCanvas(image, platform);
  stageTimings.push({ stage: "load", label: "加载图片", durationMs: performance.now() - loadT0 });

  const runtimeStages: RuntimeStageStatus[] = [];
  const stageRegions: PipelineStageRegions = {
    detected: [],
    ocr: [],
    merged: [],
    ordered: [],
  };

  let latestRegions: PipelineArtifacts["detectedRegions"] = [];
  let detectionCanvas: PipelineCanvas = originalCanvas;
  let ocrCanvas: PipelineCanvas = originalCanvas;
  let segmentationCanvas: PipelineCanvas | null = null;
  let cleanedCanvas: PipelineCanvas = originalCanvas;
  let resultCanvas: PipelineCanvas = originalCanvas;
  let debugOriginalCanvas: PipelineCanvas | null = null;
  let eraseDebugCanvas: PipelineCanvas | null = null;
  let typesetDebugLog: PipelineTypesetDebugLog | null = null;
  let translationDebug: TranslationDebugInfo | null = null;
  let ocrDebug: PipelineArtifacts['ocrDebug'] = null;
  let ocrPostFilterDebug: PipelineArtifacts['ocrPostFilterDebug'] = null;
  let detectionMaskCanvas: PipelineCanvas | null = null;
  let refinedMaskCanvas: PipelineCanvas | null = null;
  let debugLayers: MaskDebugLayers | null = null;
  let regionOwnership: RegionMaskOwnership | undefined;
  let editableLayers: EditableLayerCanvases | undefined = options.collectEditableLayers ? { erase: [], text: [] } : undefined;

  const buildArtifacts = (): PipelineArtifacts => ({
    original: image,
    detectedRegions: latestRegions,
    stageRegions,
    detectionCanvas,
    ocrCanvas,
    segmentationCanvas,
    cleanedCanvas,
    resultCanvas,
    debugOriginalCanvas,
    typesetDebugLog,
    translationDebug,
    ocrDebug,
    ocrPostFilterDebug,
    runtimeStages,
    stageTimings,
    ...(editableLayers ? { editableLayers } : {}),
  });

  const setRuntimeStage = (status: RuntimeStageStatus): void => {
    const index = runtimeStages.findIndex((stage) => stage.model === status.model);
    if (index >= 0) runtimeStages[index] = status;
    else runtimeStages.push(status);
  };

  const getRuntimeStage = (model: RuntimeStageStatus["model"]): RuntimeStageStatus | undefined =>
    runtimeStages.find((stage) => stage.model === model);

  throwIfCancelled(signal);
  report(onProgress, "preload", "加载检测模型");
  const preloadT0 = performance.now();
  let preparedPanels: PreparedReadingPanels | undefined;
  let preparedMaskGray: PreparedTextMaskGray | undefined;
  let preparedInpaintSource: PreparedInpaintSource | undefined;
  let sourcePreReadStarted = false;
  const sourcePreReadEnabled = (globalThis as {
    __shinobuColdStartSourcePreRead?: boolean;
  }).__shinobuColdStartSourcePreRead === true && !stopAfterOrder && !options.precomputedDetection;
  const onDetectorSubmitted = sourcePreReadEnabled ? () => {
    if (sourcePreReadStarted || signal?.aborted) return;
    sourcePreReadStarted = true;
    const observe = (globalThis as {
      __shinobuColdStartInitMark?: (record: Record<string, unknown>) => void;
    }).__shinobuColdStartInitMark;
    const startedAt = observe ? performance.now() : 0;
    let originalStartedAt = startedAt;
    // Normal detector masks are returned at original dimensions. The consumer
    // checks the actual scaled dimensions and falls back if a host differs.
    try { preparedMaskGray = prepareTextMaskGray(originalCanvas, originalCanvas.height, platform); }
    catch { /* Leave the normal mask stage responsible for its own error. */ }
    if (observe) originalStartedAt = performance.now();
    try { preparedInpaintSource = prepareInpaintSource(originalCanvas, platform); }
    catch { /* Leave the normal inpaint stage responsible for its own error. */ }
    if (observe) {
      try {
        const finishedAt = performance.now();
        observe({ phase: 'source.preread', startedAt, durationMs: finishedAt - startedAt,
          grayMs: originalStartedAt - startedAt, originalMs: finishedAt - originalStartedAt,
          grayPrepared: preparedMaskGray !== undefined, originalPrepared: preparedInpaintSource !== undefined,
          width: originalCanvas.width, height: originalCanvas.height,
          scaledWidth: preparedMaskGray?.scaledWidth, scaledHeight: preparedMaskGray?.scaledHeight,
        });
      } catch { /* Optional diagnostics cannot affect the real model request. */ }
    }
  } : undefined;
  if (options.precomputedDetection) {
    setRuntimeStage({
      model: 'detector',
      enabled: true,
      engine: 'onnx',
      detail: 'detector 使用阅读会话预检测结果',
    });
  } else {
    const detectorProbe = probeRuntime(modelRuntime, "detector");
    if ((globalThis as { __shinobuColdStartPanelOverlap?: boolean }).__shinobuColdStartPanelOverlap === true) {
      // Compute from the unchanged source while the existing Session load is pending.
      // Panel errors remain the reading-order fallback; always observe detectorProbe.
      preparedPanels = prepareReadingPanels(originalCanvas, platform);
    }
    setRuntimeStage(await detectorProbe);
  }
  throwIfCancelled(signal);
  stageTimings.push({ stage: "preload", label: "加载检测模型", durationMs: performance.now() - preloadT0 });

  let ocrRuntimeProbePromise: Promise<RuntimeStageStatus> | null = null;
  let inpaintRuntimeProbePromise: Promise<RuntimeStageStatus> | null = null;
  let bubbleRuntimeProbePromise: Promise<RuntimeStageStatus> | null = null;
  const ocrRuntimeProbeSchedule = getPaddleOcrRuntimeProbeSchedule();
  const inpaintRuntimeProbeSchedule = getInpaintRuntimeProbeSchedule();
  const bubbleRuntimeProbeSchedule = getBubbleRuntimeProbeSchedule();

  const startOcrRuntimeProbe = (): Promise<RuntimeStageStatus> => {
    if (!ocrRuntimeProbePromise) {
      ocrRuntimeProbePromise = probeRuntime(modelRuntime, "ocr");
    }
    return ocrRuntimeProbePromise;
  };

  const startInpaintRuntimeProbe = (): Promise<RuntimeStageStatus> => {
    if (!inpaintRuntimeProbePromise) {
      inpaintRuntimeProbePromise = probeRuntime(modelRuntime, "inpaint");
    }
    return inpaintRuntimeProbePromise;
  };

  const startBubbleRuntimeProbe = (): Promise<RuntimeStageStatus> => {
    if (!bubbleRuntimeProbePromise) {
      bubbleRuntimeProbePromise = probeRuntime(modelRuntime, "bubble");
    }
    return bubbleRuntimeProbePromise;
  };

  throwIfCancelled(signal);
  report(onProgress, "detect", "文本检测");
  try {
    const t0 = performance.now();
    const detected = options.precomputedDetection
      ? await materializePrecomputedDetection(options.precomputedDetection, image, platform)
      : await detectTextRegionsWithMask(
          image,
          platform,
          modelRuntime,
          options.detectionFallbackStrategy,
          onDetectorSubmitted,
        );
    throwIfCancelled(signal);
    latestRegions = detected.regions;
    stageRegions.detected = cloneTextRegions(latestRegions);
    detectionMaskCanvas = detected.rawMaskCanvas;
    segmentationCanvas = detected.rawMaskCanvas;
    detectionCanvas = collectStagePreviews
      ? drawRegions(originalCanvas, detected.regions, "文本检测", () => "文本框", platform)
      : originalCanvas;
    ocrCanvas = detectionCanvas;
    cleanedCanvas = ocrCanvas;
    resultCanvas = cleanedCanvas;
    const detectorRuntime = getRuntimeStage("detector");
    if (detected.engine !== "onnx") {
      setRuntimeStage({
        model: "detector",
        enabled: true,
        engine: detected.engine,
        detail: `detector 已回退到 ${detected.engine ?? "unknown"}: ${detected.fallbackReason ?? "未提供原因"}`,
      });
    } else if (detected.actualProvider && detected.actualProvider !== detectorRuntime?.provider) {
      const providerLabel = detected.actualProvider === "webnn"
        ? `${detected.actualProvider}/${detected.actualWebnnDeviceType ?? "default"}`
        : detected.actualProvider;
      setRuntimeStage({
        model: "detector",
        enabled: true,
        engine: "onnx",
        provider: detected.actualProvider,
        webnnDeviceType: detected.actualWebnnDeviceType,
        detail: `detector 推理已回退到 (${providerLabel})`
      });
    } else if (detectorRuntime) {
      setRuntimeStage({ ...detectorRuntime, engine: "onnx" });
    }
    const durationMs = performance.now() - t0;
    stageTimings.push({ stage: "detect", label: "文本检测", durationMs });
    logPipelineStage(options.observer, config, "pipeline.detect", "文本检测完成", {
      engine: detected.engine,
      fallbackReason: detected.fallbackReason,
      provider: detected.actualProvider,
      webnnDeviceType: detected.actualWebnnDeviceType,
      regionCount: detected.regions.length,
      durationMs,
    });
    if (detected.regions.length === 0) {
      cleanedCanvas = originalCanvas;
      resultCanvas = originalCanvas;
      report(onProgress, "done", "完成");
      return buildArtifacts();
    }
    if (ocrRuntimeProbeSchedule === "after-detect") {
      startOcrRuntimeProbe();
    }
    if (!stopAfterOrder && inpaintRuntimeProbeSchedule === "after-detect") {
      startInpaintRuntimeProbe();
    }
    if (bubbleRuntimeProbeSchedule === "after-detect") {
      startBubbleRuntimeProbe();
    }
  } catch (error) {
    logPipelineStage(options.observer, config, "pipeline.detect", "文本检测失败", undefined, error);
    throw new PipelineStageError("detect", "文本检测", toErrorDetail(error), buildArtifacts(), "runtime", error);
  }

  let detectedBubbles: BubbleDetection[] = [];
  throwIfCancelled(signal);
  try {
    if (ocrRuntimeProbeSchedule === "bubble-start") {
      startOcrRuntimeProbe();
    }
    if (!stopAfterOrder && inpaintRuntimeProbeSchedule === "bubble-start") {
      startInpaintRuntimeProbe();
    }
    report(onProgress, "bubble", "气泡检测");
    if (bubbleRuntimeProbeSchedule !== "current") {
      const bubblePreloadT0 = performance.now();
      setRuntimeStage(await startBubbleRuntimeProbe());
      throwIfCancelled(signal);
      stageTimings.push({
        stage: "preload_bubble",
        label: "加载气泡模型",
        durationMs: performance.now() - bubblePreloadT0,
      });
    }
    const t0 = performance.now();
    const bubbleResult = await detectBubbles(image, platform, modelRuntime);
    throwIfCancelled(signal);
    detectedBubbles = bubbleResult.bubbles;
    const bubbleProviderLabel = bubbleResult.actualProvider === "webnn"
      ? `${bubbleResult.actualProvider}/${bubbleResult.actualWebnnDeviceType ?? "default"}`
      : bubbleResult.actualProvider;
    setRuntimeStage({
      model: "bubble",
      enabled: true,
      provider: bubbleResult.actualProvider,
      webnnDeviceType: bubbleResult.actualWebnnDeviceType,
      detail: `bubble 模型已运行 (${bubbleProviderLabel})`,
    });
    const durationMs = performance.now() - t0;
    stageTimings.push({ stage: "bubble", label: "气泡检测", durationMs });
    logPipelineStage(options.observer, config, "pipeline.bubble", "气泡检测完成", {
      bubbleCount: bubbleResult.bubbles.length,
      provider: bubbleResult.actualProvider,
      webnnDeviceType: bubbleResult.actualWebnnDeviceType,
      durationMs,
    });
    if (ocrRuntimeProbeSchedule === "after-bubble") {
      startOcrRuntimeProbe();
    }
    if (!stopAfterOrder && inpaintRuntimeProbeSchedule === "after-bubble") {
      startInpaintRuntimeProbe();
    }
  } catch (error) {
    logPipelineStage(options.observer, config, "pipeline.bubble", "气泡检测失败", undefined, error);
    throw new PipelineStageError("bubble", "气泡检测", toErrorDetail(error), buildArtifacts(), "runtime", error);
  }

  throwIfCancelled(signal);
  report(onProgress, "ocr", "OCR 日文识别");

  /**
   * 检测到但识别为空的框：向外扩张一点再识别一次。
   * 只在空框数量合理时执行，异常页不会因此拖慢整页处理。
   */
  async function retryEmptyOcrRegions(): Promise<void> {
    const emptyRegions = latestRegions.filter((region) => !region.sourceText.trim());
    if (emptyRegions.length === 0 || emptyRegions.length > MAX_OCR_RETRIES) return;
    const retryInputs = emptyRegions.map((region) => ({
      ...region,
      box: expandOcrRetryBox(region.box, image.naturalWidth, image.naturalHeight),
    }));
    try {
      const retry = await runOcr(image, retryInputs, config.ocrEngine, platform, {
        compactActiveBatch: config.ocrCompactActiveBatch,
      }, modelRuntime);
      const byId = new Map(retry.regions.map((region) => [region.id, region]));
      let recovered = 0;
      latestRegions = latestRegions.map((region) => {
        const hit = byId.get(region.id);
        if (!hit || !isUsableOcrRetry(hit.sourceText, hit.prob)) return region;
        recovered += 1;
        return {
          ...region,
          sourceText: hit.sourceText,
          quad: hit.quad ?? region.quad,
          prob: hit.prob ?? region.prob,
          direction: hit.direction ?? region.direction,
          fgColor: hit.fgColor ?? region.fgColor,
          bgColor: hit.bgColor ?? region.bgColor,
        };
      });
      if (recovered > 0) {
        console.info(`[ocr] 空结果补识别: ${recovered}/${emptyRegions.length} 个框恢复出原文`);
      }
    } catch (error) {
      console.warn("[ocr] 空结果补识别失败，忽略:", error instanceof Error ? error.message : error);
    }
  }

  /**
   * 换模型补识别。
   *
   * provider 只返回识别通过的框，被读空的框不会出现在 ocrResult.regions 里，
   * 这些区域后续既不翻译也不擦除，就是读者看到的"明明有对白却没翻"。
   * 当漏识比例偏高时（门控选错模型、某一模型读不了这种字形），用另一个识别模型
   * 对这些框再跑一次，只写回通过可用性校验的结果，擦除仍使用原始紧框。
   */
  async function retryMissedRegionsWithAlternateModel(
    detected: TextRegion[],
    ocr: { debug: { languageGate?: { chosen: string } }; regions: TextRegion[] },
  ): Promise<void> {
    if (detected.length === 0) return;
    const acceptedIds = new Set(latestRegions.map((region) => region.id));
    const missed = detected.filter((region) => !acceptedIds.has(region.id));
    if (missed.length < MIN_OCR_ALTERNATE_MODEL_REGIONS) return;
    if (missed.length / detected.length < MIN_OCR_ALTERNATE_MODEL_SHARE) return;

    const currentModel = ocr.debug.languageGate?.chosen ?? config.ocrEngine ?? "";
    const currentIsKorean = /korean/i.test(currentModel);
    const alternateEngine = currentIsKorean ? "paddleocr_v6_medium" : "paddleocr_v5_korean";

    const retryInputs = missed.map((region) => ({
      ...region,
      box: expandOcrRetryBox(region.box, image.naturalWidth, image.naturalHeight),
    }));

    try {
      // skipLanguageGate：换模型是明确的意图，不要再让门控把模型换回去。
      const retry = await runOcr(image, retryInputs, alternateEngine, platform, {
        compactActiveBatch: config.ocrCompactActiveBatch,
        skipLanguageGate: true,
      }, modelRuntime);
      const originalBoxById = new Map(missed.map((region) => [region.id, region.box]));
      const recovered = new Map<string, TextRegion>();
      for (const region of retry.regions) {
        if (!isUsableOcrRetry(region.sourceText, region.prob)) continue;
        const box = originalBoxById.get(region.id);
        recovered.set(region.id, box ? { ...region, box } : region);
      }
      if (recovered.size === 0) return;

      // 按检测顺序重组，保持原有的阅读顺序与排版层序。
      const keptById = new Map(latestRegions.map((region) => [region.id, region]));
      const merged: TextRegion[] = [];
      for (const region of detected) {
        const hit = keptById.get(region.id) ?? recovered.get(region.id);
        if (hit) merged.push(hit);
      }
      latestRegions = merged;
      console.info(
        `[ocr] 换模型补识别(${alternateEngine}): ${recovered.size}/${missed.length} 个漏识框恢复出原文`,
      );
    } catch (error) {
      console.warn("[ocr] 换模型补识别失败，忽略:", error instanceof Error ? error.message : error);
    }
  }

  try {
    if (!stopAfterOrder && inpaintRuntimeProbeSchedule === "ocr-start") {
      startInpaintRuntimeProbe();
    }
    const t0 = performance.now();
    setRuntimeStage(await startOcrRuntimeProbe());
    throwIfCancelled(signal);
    if (!stopAfterOrder && inpaintRuntimeProbeSchedule === "current") {
      startInpaintRuntimeProbe();
    }
    // 识别前的全部检测框：OCR provider 只返回识别通过的框，被读空的框会直接
    // 从结果里消失（这些对白就会"检测到了但没翻"），所以要先留一份底。
    const detectedBeforeOcr = latestRegions;
    const ocrResult = await runOcr(image, latestRegions, config.ocrEngine, platform, {
      compactActiveBatch: config.ocrCompactActiveBatch,
    }, modelRuntime);
    throwIfCancelled(signal);
    latestRegions = ocrResult.regions;
    // 检测到但读空的框（描边字/上伸部下伸部被裁）向外扩一点补识别一次，
    // 读出来的结果写回同一 id，擦除仍用原始紧框。
    await retryEmptyOcrRegions();
    throwIfCancelled(signal);
    // 仍有大量框整条读空时，换另一个识别模型再补一次：韩文页被门控误判成默认模型、
    // 或某一模型的词典天生读不了这种字形时，这一步能把对白救回来。
    await retryMissedRegionsWithAlternateModel(detectedBeforeOcr, ocrResult);
    throwIfCancelled(signal);
    stageRegions.ocr = cloneTextRegions(latestRegions);
    ocrDebug = ocrResult.debug;
    ocrCanvas = !collectStagePreviews || latestRegions.length === 0
      ? originalCanvas
      : drawRegions(originalCanvas, latestRegions, "OCR 识别", (region) => region.sourceText, platform);
    cleanedCanvas = ocrCanvas;
    resultCanvas = cleanedCanvas;
    const ocrRuntime = getRuntimeStage("ocr");
    if (ocrResult.actualProvider !== ocrRuntime?.provider) {
      const providerLabel = ocrResult.actualProvider === "webnn"
        ? `${ocrResult.actualProvider}/${ocrResult.actualWebnnDeviceType ?? "default"}`
        : ocrResult.actualProvider;
      setRuntimeStage({
        model: "ocr",
        enabled: true,
        provider: ocrResult.actualProvider,
        webnnDeviceType: ocrResult.actualWebnnDeviceType,
        detail: `ocr 推理已回退到 (${providerLabel})`
      });
    }
    const ocrDurationMs = performance.now() - t0;
    stageTimings.push({ stage: "ocr", label: "OCR 日文识别", durationMs: ocrDurationMs });
    logPipelineStage(options.observer, config, "pipeline.ocr", "OCR 识别完成", {
      engine: config.ocrEngine,
      provider: ocrResult.actualProvider,
      webnnDeviceType: ocrResult.actualWebnnDeviceType,
      regionCount: ocrResult.regions.length,
      durationMs: ocrDurationMs,
      debug: ocrResult.debug,
    });
    if (ocrResult.regions.length === 0) {
      cleanedCanvas = originalCanvas;
      resultCanvas = originalCanvas;
      report(onProgress, "done", "完成");
      return buildArtifacts();
    }
    if (!stopAfterOrder) {
      const inpaintPreloadT0 = performance.now();
      setRuntimeStage(await startInpaintRuntimeProbe());
      throwIfCancelled(signal);
      stageTimings.push({
        stage: "preload_inpaint",
        label: "加载去字模型",
        durationMs: performance.now() - inpaintPreloadT0,
      });
    }
  } catch (error) {
    logPipelineStage(options.observer, config, "pipeline.ocr", "OCR 识别失败", undefined, error);
    throw new PipelineStageError("ocr", "OCR", toErrorDetail(error), buildArtifacts(), "runtime", error);
  }

  throwIfCancelled(signal);
  report(onProgress, "merge", "合并文本行");
  try {
    const t0 = performance.now();
    const beforeMergeCount = latestRegions.length;
    const lineMerged = mergeTextLines(latestRegions, image.naturalWidth, image.naturalHeight);
    // 兜底：把“首行窄框 + 余下多行块”这类被上游漏合的碎片合回一段，
    // 否则两组译文会各自排版并叠在同一个气泡里。
    latestRegions = mergeStackedTextFragments(lineMerged);
    stageRegions.merged = cloneTextRegions(latestRegions);
    stageTimings.push({ stage: "merge", label: "合并文本行", durationMs: performance.now() - t0 });
    // 合并前后的区域数决定了这一页会发多少个翻译请求：OCR 行数远大于合并后的块数时，
    // 说明一整个气泡被当成一段；反过来合并数≈OCR 数说明气泡被切碎了，译文会断句。
    logPipelineStage(options.observer, config, "pipeline.stage", "文本行合并完成", {
      ocrRegionCount: beforeMergeCount,
      mergedRegionCount: latestRegions.length,
      withTextCount: latestRegions.filter((region) => region.sourceText.trim() !== '').length,
    });
  } catch (error) {
    throw new PipelineStageError("merge", "文本行合并", toErrorDetail(error), buildArtifacts(), "image", error);
  }

  if (detectedBubbles.length > 0) {
    const matchResult = matchRegionsToBubbles(latestRegions, detectedBubbles);
    if (matchResult.unmatchedCount > 0) {
      // Free-floating lettering (sound effects, narration) legitimately has no
      // bubble; this is a diagnostic detail, not a failure.
      console.debug(
        `[bubble] ${matchResult.unmatchedCount} 个文字区域未匹配到气泡:`,
        matchResult.unmatchedRegionIds,
      );
    }
  }
  // Matched masks remain reachable through their regions; unmatched masks can
  // be reclaimed before the remaining stages allocate render canvases.
  detectedBubbles = [];

  if ((config.ocrPostFilter ?? "balanced") === "off") {
    ocrPostFilterDebug = {
      mode: "off",
      ruleId: OCR_POST_FILTER_RULE_ID,
      candidateCount: 0,
      filteredCount: 0,
      filteredRegionIds: [],
      decisions: [],
      durationMs: 0,
      skippedReason: "disabled",
    };
  } else if (!detectionMaskCanvas) {
    ocrPostFilterDebug = {
      mode: "balanced",
      ruleId: OCR_POST_FILTER_RULE_ID,
      candidateCount: 0,
      filteredCount: 0,
      filteredRegionIds: [],
      decisions: [],
      durationMs: 0,
      skippedReason: "no-mask",
    };
  } else {
    throwIfCancelled(signal);
    report(onProgress, "ocr_postfilter", "过滤 OCR 误识别");
    const t0 = performance.now();
    try {
      const result = await filterOcrRegions(
        image,
        detectionMaskCanvas,
        latestRegions,
        {
          platform,
          modelRuntime,
          providerName: config.ocrEngine,
        },
      );
      throwIfCancelled(signal);
      latestRegions = result.regions;
      ocrPostFilterDebug = result.debug;
      logPipelineStage(options.observer, config, "pipeline.ocr", "OCR 后处理完成", {
        ruleId: result.debug.ruleId,
        candidateCount: result.debug.candidateCount,
        filteredCount: result.debug.filteredCount,
        filteredRegionIds: result.debug.filteredRegionIds,
        durationMs: result.debug.durationMs,
      });
    } catch (error) {
      const detail = toErrorDetail(error);
      console.warn(`[ocr-postfilter] 后处理失败，保留全部区域: ${detail}`);
      ocrPostFilterDebug = {
        mode: "balanced",
        ruleId: OCR_POST_FILTER_RULE_ID,
        candidateCount: 0,
        filteredCount: 0,
        filteredRegionIds: [],
        decisions: [],
        durationMs: performance.now() - t0,
        skippedReason: "error",
        error: detail,
      };
      logPipelineStage(
        options.observer,
        config,
        "pipeline.ocr",
        "OCR 后处理失败，已保留全部区域",
        undefined,
        error,
      );
    } finally {
      stageTimings.push({
        stage: "ocr_postfilter",
        label: "过滤 OCR 误识别",
        durationMs: performance.now() - t0,
      });
    }
  }

  // 站点水印（域名、页顶细条标语）不该被翻译，也不该被擦除：
  // 小字 OCR 译文往往残缺（如「MANGA18FX.COM」→「Rad Maga One Eg Fe」），
  // 擦除渐变背景还容易留灰块。过滤后整段水印保持原样。
  if (latestRegions.length > 0) {
    const keptRegions: typeof latestRegions = [];
    let watermarkCount = 0;
    for (const region of latestRegions) {
      if (isSiteWatermarkRegion(region, image.naturalWidth, image.naturalHeight)) {
        watermarkCount += 1;
      } else {
        keptRegions.push(region);
      }
    }
    if (watermarkCount > 0) {
      latestRegions = keptRegions;
      console.info(`[ocr] 跳过站点水印文字: ${watermarkCount} 个区域不翻译不擦除`);
    }
  }

  if (config.llmOcrFilter && config.translator === 'llm' && latestRegions.length > 0) {
    throwIfCancelled(signal);
    report(onProgress, 'llm_ocr_filter', '大模型误识别过滤');
    const t0 = performance.now();
    try {
      if (!options.classifyVisionRegions) throw new Error('未配置大模型误识别过滤器');
      const described = describeVisionRegions(latestRegions, stageRegions.detected, originalCanvas, platform);
      const filteredIds = await options.classifyVisionRegions(described, signal);
      throwIfCancelled(signal);
      const validIds = new Set(latestRegions.map((region) => region.id));
      if (!Array.isArray(filteredIds) || !filteredIds.every((id) => typeof id === 'string' && validIds.has(id))) {
        throw new Error('大模型误识别过滤返回了无效的区域 ID');
      }
      const filtered = new Set(filteredIds);
      latestRegions = latestRegions.filter((region) => !filtered.has(region.id));
      logPipelineStage(options.observer, config, 'pipeline.ocr', '大模型误识别过滤完成', {
        candidateCount: described.length,
        filteredRegionIds: filteredIds,
      });
    } catch (error) {
      throwIfCancelled(signal);
      console.warn(`[llm-ocr-filter] 过滤失败，保留全部区域: ${toErrorDetail(error)}`);
      logPipelineStage(options.observer, config, 'pipeline.ocr', '大模型误识别过滤失败，已保留全部区域', undefined, error);
    } finally {
      stageTimings.push({ stage: 'llm_ocr_filter', label: '大模型误识别过滤', durationMs: performance.now() - t0 });
    }
  }

  throwIfCancelled(signal);
  report(onProgress, "order", "文本顺序排序");
  try {
    const t0 = performance.now();
    latestRegions = preparedPanels === undefined
      ? sortRegionsForRender(latestRegions, originalCanvas, platform)
      : sortRegionsForRender(latestRegions, originalCanvas, platform, preparedPanels);
    stageRegions.ordered = cloneTextRegions(latestRegions);
    stageTimings.push({ stage: "order", label: "文本顺序排序", durationMs: performance.now() - t0 });
  } catch (error) {
    throw new PipelineStageError("order", "顺序排序", toErrorDetail(error), buildArtifacts(), "image", error);
  }

  const orderedRegions = latestRegions;
  if (!hasTranslatableText({ ordered: orderedRegions })) {
    latestRegions = [];
    stageRegions.ocr = [];
    stageRegions.merged = [];
    stageRegions.ordered = [];
    cleanedCanvas = originalCanvas;
    resultCanvas = originalCanvas;
    report(onProgress, "done", "完成");
    return buildArtifacts();
  }
  if (stopAfterOrder) {
    report(onProgress, "done", "完成");
    return buildArtifacts();
  }

  type ParallelTranslateStatus = "pending" | "running" | "done";
  type ParallelEraseStatus = "pending" | "mask_refine" | "inpaint" | "done";

  let parallelTranslateStatus: ParallelTranslateStatus = "pending";
  let parallelEraseStatus: ParallelEraseStatus = "pending";
  let translateTiming: StageTiming | null = null;
  let maskRefineTiming: StageTiming | null = null;
  let inpaintTiming: StageTiming | null = null;
  let parallelTimingsFlushed = false;

  const flushParallelTimings = (): void => {
    if (parallelTimingsFlushed) {
      return;
    }
    if (translateTiming) {
      stageTimings.push(translateTiming);
    }
    if (maskRefineTiming) {
      stageTimings.push(maskRefineTiming);
    }
    if (inpaintTiming) {
      stageTimings.push(inpaintTiming);
    }
    parallelTimingsFlushed = true;
  };

  const getTranslateDetail = (): string => {
    if (parallelTranslateStatus === "running") {
      return "\u7ffb\u8bd1\u4e2d";
    }
    if (parallelTranslateStatus === "done") {
      return "\u7ffb\u8bd1\u5b8c\u6210";
    }
    return "\u7ffb\u8bd1\u5f85\u6267\u884c";
  };

  const getEraseDetail = (): string => {
    if (parallelEraseStatus === "mask_refine") {
      return "\u7ec6\u5316\u906e\u7f69\u4e2d";
    }
    if (parallelEraseStatus === "inpaint") {
      return "\u53bb\u5b57\u4e2d";
    }
    if (parallelEraseStatus === "done") {
      return "\u53bb\u5b57\u5b8c\u6210";
    }
    return "\u53bb\u5b57\u5f85\u6267\u884c";
  };

  const reportParallel = (): void => {
    report(onProgress, "parallel", `${getTranslateDetail()} | ${getEraseDetail()}`);
  };

  reportParallel();
  const parallelT0 = performance.now();

  const shouldSkipTranslate = config.processMode === 'erase' || config.processMode === 'original' || config.eraseDebug;

  const translateTask = shouldSkipTranslate
    ? Promise.resolve(orderedRegions)
    : (async (): Promise<PipelineArtifacts["detectedRegions"]> => {
        throwIfCancelled(signal);
        parallelTranslateStatus = "running";
        reportParallel();
        try {
          const t0 = performance.now();
          if (!options.textTranslator) {
            throw new Error('未配置 TextTranslator');
          }
          const translated = await options.textTranslator.translateRegions({
            regions: orderedRegions,
            config,
            signal,
          });
          throwIfCancelled(signal);
          const translatedRegions = translated.regions;
          translateTiming = { stage: "translate", label: "\u7ffb\u8bd1\u4e3a\u4e2d\u6587", durationMs: performance.now() - t0 };
          translationDebug = translated.translationDebug;
          parallelTranslateStatus = "done";
          reportParallel();
          return translatedRegions;
        } catch (error) {
          if (hasPipelineFailure(error)) throw error;
          throw new PipelineStageError("translate", "\u7ffb\u8bd1", toErrorDetail(error), buildArtifacts(), "runtime", error);
        }
      })();

  const eraseTask = (async (): Promise<PipelineCanvas> => {
    throwIfCancelled(signal);
    if (!detectionMaskCanvas) {
      throw new PipelineStageError("mask_refine", "\u906e\u7f69\u7ec6\u5316", "\u68c0\u6d4b\u9636\u6bb5\u672a\u63d0\u4f9b\u539f\u59cb mask\uff0c\u5df2\u7981\u7528\u6587\u672c\u6846\u906e\u7f69\u56de\u9000", buildArtifacts(), "runtime");
    }

    parallelEraseStatus = "mask_refine";
    reportParallel();
    try {
      const t0 = performance.now();
      const regionsWithText = orderedRegions.filter(r => r.sourceText.trim() !== '' && !r.translationFailed);
      const refineResult = refineTextMask(originalCanvas, regionsWithText, detectionMaskCanvas, platform, {
        method: "fit_text",
        kernelSize: 3
      }, config.eraseDebug, preparedMaskGray, options.collectEditableLayers);
      preparedMaskGray = undefined;
      throwIfCancelled(signal);
      refinedMaskCanvas = refineResult.refinedMaskCanvas;
      regionOwnership = refineResult.regionOwnership;
      if (refineResult.rectFallbackRegionIds && refineResult.rectFallbackRegionIds.length > 0) {
        logPipelineStage(
          options.observer,
          config,
          "pipeline.inpaint",
          "检测遮罩未覆盖，改用文字框兜底擦除",
          {
            fallbackCount: refineResult.rectFallbackRegionIds.length,
            regionCount: regionsWithText.length,
            regionIds: refineResult.rectFallbackRegionIds.slice(0, 20),
          },
        );
      }
      if (refineResult.inkFillRegionIds && refineResult.inkFillRegionIds.length > 0) {
        logPipelineStage(
          options.observer,
          config,
          "pipeline.inpaint",
          "检测遮罩漏掉笔画，已按框内笔画补擦",
          {
            inkFillCount: refineResult.inkFillRegionIds.length,
            regionCount: regionsWithText.length,
            regionIds: refineResult.inkFillRegionIds.slice(0, 20),
          },
        );
      }
      if (refineResult.debugLayers) {
        debugLayers = refineResult.debugLayers;
        eraseDebugCanvas = buildEraseDebugCanvas(originalCanvas, refineResult.debugLayers, platform, undefined);
      }
      maskRefineTiming = { stage: "mask_refine", label: "\u7ec6\u5316\u53bb\u5b57\u906e\u7f69", durationMs: performance.now() - t0 };
    } catch (error) {
      throw new PipelineStageError(
        "mask_refine",
        "\u906e\u7f69\u7ec6\u5316",
        toErrorDetail(error),
        buildArtifacts(),
        error instanceof MaskRefinementImageError ? "image" : "runtime",
        error,
      );
    }

    parallelEraseStatus = "inpaint";
    reportParallel();
    try {
      const t0 = performance.now();
      if (!refinedMaskCanvas) {
        throw new Error("\u53bb\u5b57\u524d\u7f3a\u5c11 refined mask\uff0c\u5df2\u7981\u7528\u6587\u672c\u6846\u906e\u7f69\u56de\u9000");
      }
      const inpaintResult = await runInpaint(
        originalCanvas,
        refinedMaskCanvas,
        platform,
        modelRuntime,
        preparedInpaintSource,
      );
      preparedInpaintSource = undefined;
      throwIfCancelled(signal);
      if (editableLayers && regionOwnership) {
        try {
          editableLayers.erase = buildEraseLayerCanvases(inpaintResult.canvas, refinedMaskCanvas, regionOwnership, platform);
        } catch (error) {
          console.warn('[shinobu:layers] 去字图层生成失败', error);
          editableLayers = undefined;
        }
        regionOwnership = undefined;
      }
      const inpaintDurationMs = performance.now() - t0;
      inpaintTiming = { stage: "inpaint", label: "\u53bb\u5b57", durationMs: inpaintDurationMs };
      const inpaintRuntime = getRuntimeStage("inpaint");
      if (inpaintResult.actualProvider !== inpaintRuntime?.provider) {
        const providerLabel = inpaintResult.actualProvider === "webnn"
          ? `${inpaintResult.actualProvider}/${inpaintResult.actualWebnnDeviceType ?? "default"}`
          : inpaintResult.actualProvider;
        setRuntimeStage({
          model: "inpaint",
          enabled: true,
          provider: inpaintResult.actualProvider,
          webnnDeviceType: inpaintResult.actualWebnnDeviceType,
          detail: `inpaint \u63a8\u7406\u5df2\u56de\u9000\u5230 (${providerLabel})`
        });
      }
      logPipelineStage(options.observer, config, "pipeline.inpaint", "去字推理完成", {
        provider: inpaintResult.actualProvider,
        webnnDeviceType: inpaintResult.actualWebnnDeviceType,
        durationMs: inpaintDurationMs,
      });
      parallelEraseStatus = "done";
      reportParallel();
      return inpaintResult.canvas;
    } catch (error) {
      logPipelineStage(options.observer, config, "pipeline.inpaint", "去字推理失败", undefined, error);
      throw new PipelineStageError("inpaint", "\u53bb\u5b57", toErrorDetail(error), buildArtifacts(), "runtime", error);
    }
  })();

  try {
    const [translatedRegions, inpaintedCanvas] = await Promise.all([translateTask, eraseTask]);
    throwIfCancelled(signal);
    latestRegions = translatedRegions;
    {
      // 这一条决定用户「看到多少对白被翻译」：拿到译文的区域才会排版，
      // 没译文的区域会把原图像素贴回去（看起来就是「没动过」）。
      // 以前只有 console.warn，日志导出里看不到，只能靠猜。
      const withText = translatedRegions.filter((region) => region.sourceText.trim() !== '').length;
      const failed = translatedRegions.filter((region) => region.translationFailed === true).length;
      logPipelineStage(options.observer, config, "pipeline.stage", "翻译结果汇总", {
        regionCount: translatedRegions.length,
        withTextCount: withText,
        translatedCount: withText - failed,
        failedCount: failed,
        failedRegionIds: translatedRegions
          .filter((region) => region.translationFailed === true)
          .slice(0, 20)
          .map((region) => region.id.slice(0, 8)),
        translator: config.translator,
        sourceLang: config.sourceLang,
        targetLang: config.targetLang,
      });
    }
    if (config.processMode === 'translate') {
      // 去字与翻译是并行的，去字阶段不可能知道哪些框最终没拿到译文。
      // 这些框的原文已经被擦掉，这里把原始像素贴回去：没翻译就该看起来「没动过」，
      // 而不是留一个被抹白的空洞。
      const restoredIds = restoreUntranslatedRegions(inpaintedCanvas, originalCanvas, latestRegions);
      if (restoredIds.size > 0) {
        logPipelineStage(options.observer, config, "pipeline.typeset", "未翻译区域回填原文", {
          restoredCount: restoredIds.size,
          ids: [...restoredIds].map((id) => id.slice(0, 8)),
        });
      }
    }
    if (config.typesetDebug) {
      // 排版调试开启时记录每个区域的原文与译文：气泡漏翻、重复排版都靠这份数据定位。
      logPipelineStage(options.observer, config, "pipeline.typeset", "调试：区域文本", {
        regionCount: translatedRegions.length,
        regions: translatedRegions.map((region) => ({
          id: region.id.slice(0, 8),
          box: [Math.round(region.box.x), Math.round(region.box.y), Math.round(region.box.width), Math.round(region.box.height)],
          lines: region.originalLineCount ?? 1,
          source: region.sourceText.slice(0, 120),
          translated: region.translatedText.slice(0, 120),
          failed: region.translationFailed === true,
        })),
      });
    }
    cleanedCanvas = inpaintedCanvas;
    resultCanvas = cleanedCanvas;
    flushParallelTimings();
    const parallelLabel = shouldSkipTranslate ? "去字" : "并行处理(翻译 + 去字)";
    stageTimings.push({
      stage: "parallel",
      label: parallelLabel,
      durationMs: performance.now() - parallelT0
    });
  } catch (error) {
    await Promise.allSettled([translateTask, eraseTask]);
    flushParallelTimings();
    if (error instanceof PipelineStageError || hasPipelineFailure(error)) {
      throw error;
    }
    throw new PipelineStageError("parallel", "并行处理", toErrorDetail(error), buildArtifacts(), "runtime", error);
  }

  if (config.processMode === 'erase') {
    if (config.eraseDebug && debugLayers) {
      resultCanvas = buildEraseDebugCanvas(originalCanvas, debugLayers, platform, cleanedCanvas);
    } else {
      resultCanvas = cleanedCanvas;
    }
  } else {
    throwIfCancelled(signal);
    const typesetLabel = config.processMode === 'original' ? "排版原文" : "排版和嵌字";
    report(onProgress, "typeset", typesetLabel);
    try {
      const t0 = performance.now();
      // 翻译失败的区域既没擦除也不能重排，否则原文会被原生字覆盖出重影。
      const typesetRegions = latestRegions.filter((region) => !region.translationFailed);
      const typesetResult = await drawTypeset(cleanedCanvas, typesetRegions, config.targetLang, {
        debugMode: config.typesetDebug,
        renderText: true,
        collectDebugLog: false,
        onTextLayer: editableLayers ? (layer) => editableLayers?.text.push(layer) : undefined,
      }, platform);
      throwIfCancelled(signal);
      resultCanvas = typesetResult.canvas;
      if (config.eraseDebug && eraseDebugCanvas) {
        resultCanvas = eraseDebugCanvas;
      }
      if (config.collectDebugLog) {
        const debugOriginalTypeset = await drawTypeset(originalCanvas, typesetRegions, config.targetLang, {
          debugMode: true,
          renderText: false,
          collectDebugLog: true,
        }, platform);
        throwIfCancelled(signal);
        debugOriginalCanvas = debugOriginalTypeset.canvas;
        typesetDebugLog = debugOriginalTypeset.debugLog;
      } else {
        debugOriginalCanvas = null;
        typesetDebugLog = null;
      }
      const durationMs = performance.now() - t0;
      stageTimings.push({ stage: "typeset", label: typesetLabel, durationMs });
      logPipelineStage(options.observer, config, "pipeline.typeset", "排版完成", {
        mode: config.processMode,
        regionCount: latestRegions.length,
        durationMs,
        debugRegionCount: typesetDebugLog?.regions.length,
      });
    } catch (error) {
      logPipelineStage(options.observer, config, "pipeline.typeset", "排版失败", undefined, error);
      throw new PipelineStageError("typeset", "排版", toErrorDetail(error), buildArtifacts(), "image", error);
    }
  }

  throwIfCancelled(signal);
  report(onProgress, "done", "完成");
  return buildArtifacts();
}
