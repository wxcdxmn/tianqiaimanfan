import type { OcrRunDebugInfo, TextRegion } from "../../types";
import type { PlatformProvider, PipelineImage } from "../../runtime/platform";
import type { RuntimeProvider, WebNnDeviceType } from '@shinobu/model-runtime';
import type { ModelRuntime } from '@shinobu/model-runtime';
import {
  registerOcrProvider,
  registerOcrProviderAlias,
  getOcrProvider,
  fillMissingOcrFields,
} from "./provider";
import type { OcrRecognizeResult } from "./provider";
import { paddleocrV6MediumProvider, paddleocrV5KoreanProvider } from "./paddleocrProvider";

registerOcrProvider(paddleocrV6MediumProvider);
registerOcrProvider(paddleocrV5KoreanProvider);
registerOcrProviderAlias("builtin", "paddleocr_v6_medium");
registerOcrProviderAlias("48px", "paddleocr_v6_medium");
registerOcrProviderAlias("paddleocr", "paddleocr_v6_medium");
registerOcrProviderAlias("paddleocr_v6_small", "paddleocr_v6_medium");
registerOcrProviderAlias("korean", "paddleocr_v5_korean");

export type OcrResult = {
  regions: TextRegion[];
  actualProvider: RuntimeProvider;
  actualWebnnDeviceType?: WebNnDeviceType;
  debug: OcrRunDebugInfo;
};

type RunOcrOptions = {
  compactActiveBatch?: boolean;
  /** 跳过语言门控，强制使用 providerName 指定的模型（换模型补识别时使用）。 */
  skipLanguageGate?: boolean;
};

export function mapResultsToRegions(
  results: OcrRecognizeResult[],
  detectedRegions: TextRegion[],
): TextRegion[] {
  const detectedById = new Map(detectedRegions.map((region) => [region.id, region]));
  return results.map((result, index) => {
    const detected = (
      (result.regionId ? detectedById.get(result.regionId) : undefined)
      ?? detectedRegions[index]
    );
    return {
      id: detected?.id ?? result.regionId ?? `ocr-${index}`,
      box: detected?.box ?? { x: 0, y: 0, width: 0, height: 0 },
      quad: result.quad,
      direction: result.direction,
      prob: result.confidence,
      fgColor: result.fgColor,
      bgColor: result.bgColor,
      sourceText: result.text,
      translatedText: "",
    };
  });
}

function createDefaultDebug(resultCount: number): OcrRunDebugInfo {
  return {
    mode: "ctc",
    candidateCount: resultCount,
    preparedCount: resultCount,
    preprocessTotalMs: 0,
    preprocessPerRegionMs: [],
    chunkBatchSize: 0,
    chunks: [],
    colorDecodeMode: "none",
    colorBatchSize: 0,
    colorSessionRunCount: 0,
    colorSessionRunTotalMs: 0,
    colorTotalMs: 0,
    colorFallbackRegions: [],
    fallbackTriggerCount: 0,
    totalSessionRunCount: 0,
    totalSessionRunMs: 0,
  };
}

function addExternalColorFillDebug(
  debugInfo: OcrRunDebugInfo,
  results: OcrRecognizeResult[],
  detectedRegions: TextRegion[],
  durationMs: number
): OcrRunDebugInfo {
  const missingColorResults = results.filter((result) => result.fgColor === undefined || result.bgColor === undefined);
  debugInfo.colorBatchSize = results.length;
  debugInfo.colorTotalMs += durationMs;
  if (debugInfo.paddle) {
    debugInfo.paddle.colorFillMs = (debugInfo.paddle.colorFillMs ?? 0) + durationMs;
  }
  if (missingColorResults.length > 0) {
    debugInfo.colorDecodeMode = "fallback";
    debugInfo.colorFallbackRegions = missingColorResults.map((result, index) => ({
      regionId: (
        result.regionId
        ?? detectedRegions[results.indexOf(result)]?.id
        ?? `ocr-${index}`
      ),
      durationMs: 0,
      accepted: true,
      error: "模型未返回颜色，使用图像采样补齐",
    }));
  } else if (results.length > 0 && debugInfo.colorDecodeMode === "none") {
    debugInfo.colorDecodeMode = "reuse";
  }
  return debugInfo;
}

function normalizeOcrProviderName(providerName?: string): string {
  if (
    !providerName ||
    providerName === "builtin" ||
    providerName === "48px" ||
    providerName === "paddleocr" ||
    providerName === "paddleocr_v6_small"
  ) {
    return "paddleocr_v6_medium";
  }
  if (providerName === "korean" || providerName === "paddleocr_v5_korean") {
    return "paddleocr_v5_korean";
  }
  return providerName;
}

/**
 * 源语言门控：默认识别模型（PP-OCRv6）的词典不含谚文，韩文页会整页读空。
 * 整页 OCR 时先用少量最大区域对默认模型与韩文模型各采样一次，
 * 韩文模型输出谚文占比高且置信度更高时整页改用韩文模型；其余语言维持原行为。
 */
const KOREAN_GATE_MIN_REGIONS = 4;
const KOREAN_GATE_SAMPLE_SIZE = 10;
const KOREAN_GATE_HANGUL_SHARE = 0.2;

type GateModel = "paddleocr_v6_medium" | "paddleocr_v5_korean";

/** 整页门控的最近决策；识别失败补翻等少区域调用沿用同一决策，避免每页重复采样。 */
let lastAutoOcrModel: GateModel | null = null;

export function resetOcrLanguageGate(): void {
  lastAutoOcrModel = null;
}

function meanConfidence(results: Array<{ confidence?: number }>): number {
  if (results.length === 0) return 0;
  const sum = results.reduce((total, result) => total + (result.confidence ?? 0), 0);
  return sum / results.length;
}

/**
 * 门控用的模型评分。
 *
 * 只比较平均置信度会系统性地偏向"读得少但读得准"的模型：provider 只返回识别
 * 通过的框，被读空的框不进入均值，于是覆盖率低的模型反而可能均值更高。
 * 这里用「覆盖率 × 置信度」，让"能读出多少行"成为主导因素。
 */
function gateScore(
  results: Array<{ confidence?: number }>,
  sampleCount: number,
): { coverage: number; confidence: number; score: number } {
  const coverage = sampleCount > 0 ? Math.min(1, results.length / sampleCount) : 0;
  const confidence = meanConfidence(results);
  return { coverage, confidence, score: coverage * confidence };
}

function hangulShareOf(texts: readonly string[]): number {
  let hangul = 0;
  let total = 0;
  for (const text of texts) {
    for (const char of text) {
      if (/\s/u.test(char)) continue;
      total += 1;
      const code = char.codePointAt(0) ?? 0;
      if ((code >= 0xac00 && code <= 0xd7a3) || (code >= 0x1100 && code <= 0x11ff)) {
        hangul += 1;
      }
    }
  }
  return total < 8 ? 0 : hangul / total;
}

async function resolveOcrModelByLanguage(
  image: PipelineImage,
  detectedRegions: TextRegion[],
  platform: PlatformProvider,
  modelRuntime: ModelRuntime,
): Promise<{ model: GateModel; gate?: NonNullable<OcrRunDebugInfo["languageGate"]> }> {
  const koreanProvider = getOcrProvider("paddleocr_v5_korean");
  const mediumProvider = getOcrProvider("paddleocr_v6_medium");
  if (!koreanProvider || !mediumProvider) {
    return { model: "paddleocr_v6_medium" };
  }
  const sample = [...detectedRegions]
    .sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)
    .slice(0, KOREAN_GATE_SAMPLE_SIZE);
  try {
    const mediumOutput = await mediumProvider.recognize(image, sample, platform, modelRuntime);
    const koreanOutput = await koreanProvider.recognize(image, sample, platform, modelRuntime);
    const medium = gateScore(mediumOutput.results, sample.length);
    const korean = gateScore(koreanOutput.results, sample.length);
    const hangulShare = hangulShareOf(koreanOutput.results.map((result) => result.text));
    // 韩文页：韩文模型读出谚文，并且"覆盖 × 置信度"更高。
    // 默认模型对谚文只会输出乱码或读空，因此按覆盖率加权后不会再被少量高置信样本误导。
    // 日文/中文页：韩文模型词典里没有假名/汉字，覆盖率与置信度都低，仍用默认模型。
    const chooseKorean = hangulShare >= KOREAN_GATE_HANGUL_SHARE && korean.score > medium.score;
    const model: GateModel = chooseKorean ? "paddleocr_v5_korean" : "paddleocr_v6_medium";
    return {
      model,
      gate: {
        sampleRegionCount: sample.length,
        hangulShare,
        mediumMeanConfidence: medium.confidence,
        koreanMeanConfidence: korean.confidence,
        mediumAcceptedCount: mediumOutput.results.length,
        koreanAcceptedCount: koreanOutput.results.length,
        chosen: model,
      },
    };
  } catch (error) {
    console.warn(
      "[ocr] 源语言采样失败，使用默认识别模型:",
      error instanceof Error ? error.message : error,
    );
    return { model: "paddleocr_v6_medium" };
  }
}

export async function runOcr(
  image: PipelineImage,
  detectedRegions: TextRegion[],
  providerName?: string,
  platform?: PlatformProvider,
  options?: RunOcrOptions,
  modelRuntime?: ModelRuntime,
): Promise<OcrResult> {
  if (!platform) {
    throw new Error("OCR 需要 PlatformProvider");
  }

  const providerNameResolved = normalizeOcrProviderName(providerName);

  if (!modelRuntime) {
    throw new Error('OCR 需要 ModelRuntime');
  }

  let effectiveProviderName = providerNameResolved;
  let languageGate: OcrRunDebugInfo["languageGate"];
  if (providerNameResolved === "paddleocr_v6_medium" && options?.skipLanguageGate !== true) {
    if (detectedRegions.length >= KOREAN_GATE_MIN_REGIONS) {
      // 整页调用：重新采样决策（每页语言可能不同）。
      const decision = await resolveOcrModelByLanguage(image, detectedRegions, platform, modelRuntime);
      lastAutoOcrModel = decision.model;
      effectiveProviderName = decision.model;
      languageGate = decision.gate;
      if (decision.gate && decision.model === "paddleocr_v5_korean") {
        console.info(
          `[ocr] 检测到韩文页面，整页改用韩文识别模型（谚文占比 ${(decision.gate.hangulShare * 100).toFixed(0)}%，`
          + `置信度 ${decision.gate.mediumMeanConfidence.toFixed(2)} → ${decision.gate.koreanMeanConfidence.toFixed(2)}）`,
        );
      }
    } else if (lastAutoOcrModel) {
      // 少区域调用（失败补翻等）：沿用本页整页决策。
      effectiveProviderName = lastAutoOcrModel;
    }
  }

  const provider = getOcrProvider(effectiveProviderName);
  if (!provider) throw new Error(`OCR 引擎未注册: ${effectiveProviderName}`);

  const output = await provider.recognize(
    image,
    detectedRegions,
    platform,
    modelRuntime,
  );
  const colorFillT0 = performance.now();
  const filled = fillMissingOcrFields(output.results, image, platform);
  const colorFillMs = performance.now() - colorFillT0;
  const debug = addExternalColorFillDebug(
    output.debug ?? createDefaultDebug(output.results.length),
    output.results,
    detectedRegions,
    colorFillMs
  );
  if (languageGate) {
    debug.languageGate = languageGate;
  }
  const regions = mapResultsToRegions(filled, detectedRegions);
  return {
    regions,
    actualProvider: output.provider,
    actualWebnnDeviceType: output.webnnDeviceType,
    debug,
  };
}
