export type LlmProvider =
  | 'alibaba'
  | 'deepseek'
  | 'doubao'
  | 'gemini'
  | 'glm'
  | 'kimi'
  | 'minimax'
  | 'mimo'
  | 'openai'
  | 'custom';

export type LlmAuthMode = 'api_key' | 'openai_oauth' | 'gemini_app';
export type LlmThinkingLevel = 'off' | 'on' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type TranslationReferenceContext = {
  source: 'x_tweet';
  currentTweetText: string;
  quotedTweetText?: string;
};

export type LlmChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type LlmChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | LlmChatContentPart[];
};

export type LlmChatCompletionRequestBody = {
  model: string;
  messages: LlmChatMessage[];
  response_format?: { type: 'json_object' | 'text' };
  enable_thinking?: boolean;
  reasoning_effort?: Exclude<LlmThinkingLevel, 'on' | 'off'> | 'none';
  reasoning_split?: boolean;
  thinking?: { type: 'disabled' | 'enabled' | 'adaptive' };
};

export type LlmChatCompletionsProxyConfig = {
  provider: LlmProvider;
  authMode: LlmAuthMode;
  baseUrl: string;
  useCustomModel?: boolean;
  thinkingLevel?: LlmThinkingLevel;
};

export type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

export type ChatCompletionTransportRequest = {
  body: LlmChatCompletionRequestBody;
  providerBody?: LlmChatCompletionRequestBody;
  proxyConfig: LlmChatCompletionsProxyConfig;
  diagnosticRunId?: string;
  signal?: AbortSignal;
};

export type PlainTranslationProvider = 'google' | 'bing' | 'mymemory' | 'deeplx';

/** 免费网页接口：每个引擎独立工作，选中哪个就只走哪个，不自动换引擎。 */
export type PlainTranslatorKind = 'google_web' | 'bing_web' | 'mymemory_web' | 'deeplx_web';

export type TextTranslatorKind = PlainTranslatorKind | 'llm';

export const TEXT_TRANSLATOR_KINDS: readonly TextTranslatorKind[] = [
  'google_web',
  'bing_web',
  'mymemory_web',
  'deeplx_web',
  'llm',
];

export function isTextTranslatorKind(value: unknown): value is TextTranslatorKind {
  return typeof value === 'string'
    && (TEXT_TRANSLATOR_KINDS as readonly string[]).includes(value);
}

export type PlainTranslationTransportRequest = {
  text: string;
  from: string;
  to: string;
  provider?: PlainTranslationProvider;
  signal?: AbortSignal;
};

export type PlainTranslationBatchRequest = {
  texts: readonly string[];
  from: string;
  to: string;
  provider?: PlainTranslationProvider;
  signal?: AbortSignal;
};

export interface TextTranslationTransport {
  requestChatCompletion(request: ChatCompletionTransportRequest): Promise<ChatCompletionResponse>;
  translatePlain(request: PlainTranslationTransportRequest): Promise<string>;
  /**
   * 合并翻译：一次请求翻多条，显著降低免费接口的 429 概率。
   * 返回顺序必须与入参一致，长度必须相同。
   */
  translatePlainBatch?(request: PlainTranslationBatchRequest): Promise<string[]>;
}

export type TextTranslationConfig = {
  sourceLang: string;
  targetLang: string;
  translator: TextTranslatorKind;
  llmProvider: LlmProvider;
  llmAuthMode: LlmAuthMode;
  llmBaseUrl: string;
  llmModel: string;
  llmUseCustomModel?: boolean;
  llmThinkingLevel?: LlmThinkingLevel;
  translationContext?: TranslationReferenceContext;
  diagnosticRunId?: string;
};

export type TextTranslationRegion = {
  id: string;
  sourceText: string;
  direction?: 'h' | 'v';
  originalLineCount?: number;
  translatedText: string;
  translatedColumns?: string[];
  /** 该区域翻译失败时置位：下游据此保留原文，不再擦除该处文字。 */
  translationFailed?: boolean;
};

export type TranslationDebugInfo = {
  llmBatchRawResponse?: string;
  llmBatchParseError?: string;
  llmBatchError?: string;
  llmBatchFailed?: boolean;
  llmBatchRequestedRegionCount?: number;
  llmBatchHitRegionCount?: number;
  llmFallbackUsed?: boolean;
  llmFallbackRegionCount?: number;
  llmFallbackRequestCount?: number;
  tweetContextLengthFallback?: boolean;
};

export type TextTranslationRequest<T extends TextTranslationRegion> = {
  regions: readonly T[];
  config: Readonly<TextTranslationConfig>;
  signal?: AbortSignal;
};

export type TextTranslationResult<T extends TextTranslationRegion> = {
  regions: T[];
  translationDebug: TranslationDebugInfo | null;
};

export interface TextTranslator {
  translateRegions<T extends TextTranslationRegion>(
    request: TextTranslationRequest<T>,
  ): Promise<TextTranslationResult<T>>;
}
