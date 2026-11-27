import type { TextRegion } from "../../types";
import type { PlatformProvider, PipelineImage } from "../../runtime/platform";
import { detectByOnnx, type DetectOutput } from "./onnxDetect";
import { detectByHeuristic } from './heuristicOnly';
import { detectWithPaddleDetRecall, isPaddleDetRecallEnabled, mergeRecallRegions } from './paddleDetRecall';
import { toErrorMessage } from '../../errorMessage';
import type { ModelRuntime } from '@shinobu/model-runtime';

export type { DetectOutput };

export type DetectOptions = {
  /** PP-OCRv6 通用检测器召回兜底，默认开启；显式 false 关闭。 */
  paddleDetRecall?: boolean;
};

/**
 * 主检测器（漫画专用）对气泡台词很准，但会漏掉贴在网点/画面纹理上的小字。
 * 这里用 PaddleOCR 的通用 DB 检测器补一轮，只把主检测没覆盖到的框加进来。
 */
async function appendPaddleDetRecall(
  base: TextRegion[],
  image: PipelineImage,
  platform: PlatformProvider,
  modelRuntime: ModelRuntime,
  options: DetectOptions,
): Promise<TextRegion[]> {
  if (!isPaddleDetRecallEnabled(options.paddleDetRecall)) {
    return base;
  }
  try {
    const recall = await detectWithPaddleDetRecall(image, platform, modelRuntime);
    const merged = mergeRecallRegions(base, recall.regions, {
      width: image.naturalWidth,
      height: image.naturalHeight,
    });
    const added = merged.length - base.length;
    if (added > 0) {
      console.log(
        `[detector] PaddleOCR 召回补框 ${added} 个（候选 ${recall.rawBoxCount}，`
        + `低分剔除 ${recall.rejectedByScore}，耗时 ${Math.round(recall.durationMs)}ms，`
        + `去网点补检 ${recall.dehalftonePassApplied ? `已启用 中灰占比 ${(recall.midtoneShare * 100).toFixed(0)}%` : '未触发'}）`,
      );
    }
    return merged;
  } catch (error) {
    console.warn(`[detector] PaddleOCR 召回不可用，忽略该增强: ${toErrorMessage(error)}`);
    return base;
  }
}

export type DetectionFallbackStrategy =
  | { kind: 'heuristic-only' }
  | {
      kind: 'tesseract-then-heuristic';
      detectWithTesseract(
        image: PipelineImage,
        platform: PlatformProvider,
      ): Promise<TextRegion[]>;
    };

export async function detectTextRegionsWithMask(
  image: PipelineImage,
  platform: PlatformProvider,
  modelRuntime: ModelRuntime,
  fallbackStrategy: DetectionFallbackStrategy,
  onSubmitted?: () => void,
  options: DetectOptions = {},
): Promise<DetectOutput> {
  const fallbackReasons: string[] = [];
  try {
    const onnxResult = await detectByOnnx(image, platform, modelRuntime, onSubmitted);
    const regions = await appendPaddleDetRecall(
      onnxResult.regions,
      image,
      platform,
      modelRuntime,
      options,
    );
    return { ...onnxResult, regions, engine: "onnx" };
  } catch (error) {
    const reason = toErrorMessage(error);
    fallbackReasons.push(`onnx: ${reason}`);
    console.warn(`[detect] onnx detector unavailable, fallback to tesseract/heuristic: ${reason}`);
  }

  if (fallbackStrategy.kind === 'tesseract-then-heuristic') {
    try {
      const tessRegions = await fallbackStrategy.detectWithTesseract(image, platform);
      if (tessRegions.length > 0) {
        return {
          regions: tessRegions,
          rawMaskCanvas: null,
          engine: "tesseract",
          fallbackReason: fallbackReasons.join(" | ")
        };
      }
    } catch (error) {
      const reason = toErrorMessage(error);
      fallbackReasons.push(`tesseract: ${reason}`);
      console.warn(`[detect] tesseract fallback unavailable, switch to heuristic: ${reason}`);
    }
  }

  const heuristicRegions = await detectByHeuristic(image, platform);
  return {
    regions: heuristicRegions,
    rawMaskCanvas: null,
    engine: "heuristic",
    fallbackReason: fallbackReasons.join(" | ")
  };
}

export async function detectTextRegions(
  image: PipelineImage,
  platform: PlatformProvider,
  modelRuntime: ModelRuntime,
  fallbackStrategy: DetectionFallbackStrategy,
): Promise<TextRegion[]> {
  const result = await detectTextRegionsWithMask(
    image,
    platform,
    modelRuntime,
    fallbackStrategy,
  );
  return result.regions;
}
