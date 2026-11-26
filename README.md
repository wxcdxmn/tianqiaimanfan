<h1 align="center">天恰漫翻 Tianqiaimanfan</h1>

<p align="center">
  一款在浏览器里直接翻译漫画的扩展 —— 选图、出译文，全程本地完成。
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/License-GPL--3.0-blue?style=flat-square"></a>
  <a href="#"><img alt="100% 本地推理" src="https://img.shields.io/badge/推理-100%25%20浏览器本地-6366f1?style=flat-square"></a>
  <a href="#"><img alt="语言" src="https://img.shields.io/badge/日语%20·%20中文%20·%20英语%20·%20韩语-自动识别-10b981?style=flat-square"></a>
</p>

把漫画页面交给它，剩下的不用管：找气泡、认文字、擦掉原文、排上中文译文，一气呵成。检测、识别、去字、排版全部在浏览器端用本地模型跑完，翻译结果经过的只有你选定的翻译服务，没有任何中间服务器。

## 它能做什么

- **三种翻译方式**：整页一键翻译、悬停即译（`Alt+W`）、框选截图翻译（`Alt+Q`）
- **四种语言自动识别**：日文 / 简繁中文 / 英文 / 韩文。整页语言门控会采样图片区域自动切换对应的识别模型，韩漫不用手动设置
- **两条翻译通道，互为兜底**：
  - 免费通道：Google → Bing → MyMemory 自动降级，请求合并抗限流
  - LLM 通道：DeepSeek / GLM / Kimi / Gemini / OpenAI / 豆包 / 通义 / MiniMax / 任意 OpenAI 兼容端点，整页合并带上下文翻译，人名和语气前后一致
  - 免费通道被限流时，已配置 LLM 的用户会被自动补翻，不会留下一堆没翻的气泡
- **悬浮控制台（HUD）**：检测到可翻译图片时右上角出现可拖动的科技风控制台，一键翻译本页、截图选区翻译、原文/译文整页切换、简洁按钮模式，状态灯实时显示进度
- **排版讲道理**：横竖排自适应、12px 最小可读字号下限、气泡装不下时允许溢出到空白区域、水印区域识别保护
- **处理模式**：翻译、仅去字、保留原文重排，按需选择

## 安装

从 [Releases](../../releases) 下载最新压缩包并解压，然后：

1. 打开 `chrome://extensions/`（Edge 为 `edge://extensions/`）
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择解压出来的目录
4. 首次使用会自动下载识别模型（约 60MB，含韩文模型），之后走缓存

> Firefox 版本在计划中，当前发布包面向 Chromium 内核浏览器（Chrome / Edge 109+）。

## 使用

**整页翻译**：扩展图标打开弹窗，或点 HUD 悬浮窗里的「翻译本页图片」。

**翻译单张图**：鼠标悬停在图片上按 `Alt+W`，或直接右键图片选择翻译。

**框选翻译**：按 `Alt+Q` 框选页面任意区域，适合不支持直接识别的站点或阅读器。

快捷键可以在浏览器的扩展快捷键管理页自定义。

## 配置翻译通道

打开扩展弹窗：

- 默认使用免费通道，开箱即用，无需任何配置
- 想要更好的对白质量：在「LLM 提供商」选择一家（或选「自定义」填任意 OpenAI 兼容端点），填入对应的 API Key 即可

API Key 只保存在你浏览器的扩展存储里，不经过任何第三方中转。

## 工作原理

```text
图片获取 → 文本检测 → 气泡分割 → OCR 识别 → 文本翻译 → 蒙版细化 → 去字修复 → 自动排版 → 译图展示
```

视觉链路（检测 / 分割 / 识别 / 去字 / 排版）全部在浏览器端由 ONNX 模型完成，运行时按环境优先 WebGPU，回退 WASM。只有识别出的纯文本会发给翻译服务。

## 本地模型

| 模型 | 用途 |
| --- | --- |
| `detector` | 文本区域检测 |
| `bubble` | 气泡实例分割 |
| `paddleocr_v6_medium_rec` | 日中英 OCR 识别 |
| `paddleocr_v5_korean_rec` | 韩文 OCR 识别（整页语言门控自动启用） |
| `inpaint` | AOT 去字修复 |

## 从源码构建

需要 Node.js 18+ 和 npm。

```bash
npm install
npm run dev:extension     # 开发模式（Chromium）
npm run build:extension   # 构建扩展
npm run check             # 完整质量门控
```

## 项目结构

```text
apps/
  extension/        浏览器扩展（Chromium / Firefox）
  web/              网页版
  model-gateway/    模型资源网关
packages/
  image-pipeline/   检测、OCR、去字与排版流水线
  text-translation/ 翻译供应商接入
  model-runtime/    模型加载与 ONNX Worker
  translator-core/  任务核心
  ...
public/
  models/           模型清单与词典
  icons/            图标资源
```

## 隐私

- 项目不内置任何 API Key
- 检测、识别、去字、排版在本地模型中完成，图片本身不上传
- 仅识别出的文字会发给你选择的翻译服务
- 使用第三方翻译或 LLM 服务时，请自行了解其隐私政策与条款

## 致谢

- [manga-image-translator](https://github.com/zyddnys/manga-image-translator) —— 漫画翻译流水线的思路来源
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) —— OCR 模型
- [onnxruntime-web](https://onnxruntime.ai/) —— 浏览器端推理运行时

第三方模型与依赖的许可证说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可证

本项目基于 [GPL-3.0](LICENSE) 开源。

## 免责声明

本项目仅供个人学习与研究，用于合法授权内容的辅助翻译。使用者应自行确认对输入图片、翻译结果及后续传播拥有合法权利，并遵守所在地法律法规与平台规则。翻译结果由模型或第三方服务生成，可能存在错误，发布或二次使用前请自行校对。
