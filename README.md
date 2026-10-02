# Bob 智谱 GLM 插件：文字识别 + 语音合成

> **致谢原作者**：本仓库的识别（OCR）插件基于 [@MinatoHikari](https://github.com/MinatoHikari) 的 [bob-llmtranslation-ocr](https://github.com/MinatoHikari/bob-llmtranslation-ocr) 修改而来。插件的整体框架、多接口支持、思考开关、结果清洗等核心功能都出自原作者之手，本仓库完整保留了原作者的提交历史与 MIT 版权声明。感谢原作者的工作！需要**翻译插件**请直接使用原仓库。

适用于 [Bob](https://bobtranslate.com/)（macOS 翻译 / OCR 软件）的两个插件，用你自己的智谱 API Key：

| 目录 | 插件 | 类型 | 说明 |
|---|---|---|---|
| `ocr/` | 智谱 GLM 识别 | 文本识别 | 截图文字识别，默认专用 OCR 模型 `glm-ocr`；也支持 GLM 视觉模型、Z.ai、DeepSeek、OpenCode、任意 OpenAI 兼容接口 |
| `tts/` | 智谱 GLM 语音 | 语音合成 | 用 `glm-tts` 朗读文本，中文与中英混读，7 种系统音色 + 复刻音色 |

Bob 规定一个插件只能属于一种类型，所以识别和语音是两个独立的 `.bobplugin`，分别安装。

## 安装

需要 Bob 1.8.0 及以上。

**一键安装**（在「终端」里粘贴运行，会下载最新版、校验 sha256，然后弹出 Bob 的安装确认框）：

```bash
# 识别插件
curl -fsSL https://raw.githubusercontent.com/www011215/bob-plugin-glm/main/install.sh | bash
# 语音插件 / 两个都装：末尾加参数 tts / all
curl -fsSL https://raw.githubusercontent.com/www011215/bob-plugin-glm/main/install.sh | bash -s -- all
```

**手动安装**：从 [Releases](../../releases) 下载 `glm-ocr-x.y.z.bobplugin` 和 / 或 `glm-tts-x.y.z.bobplugin`，双击安装到 Bob。

**设置**：

1. API Key 在 [open.bigmodel.cn](https://open.bigmodel.cn) 控制台创建（识别插件也可以用 [z.ai](https://z.ai) 的 Key）
2. 识别：Bob → 偏好设置 → 服务 → 文本识别 → `+` → 「智谱 GLM 识别」→ 填 API Key，接口和模型保持默认即可
3. 语音：Bob → 偏好设置 → 服务 → 语音合成 → `+` → 「智谱 GLM 语音」→ 填 API Key，选音色，点「验证」

## 识别插件（ocr/）

### 相对原版的改动

- **新增 `glm-ocr` 支持**：智谱专用 OCR 模型（0.9B，OmniDocBench v1.5 94.62 分），走官方文档解析接口 `layout_parsing`；返回的 Markdown 会自动转成纯文本（去掉标题、加粗标记，表格转为制表符分隔）
- 默认接口改为「智谱中国站 · 按量付费」，智谱 / Z.ai 按量付费的默认模型改为 `glm-ocr`
- 智谱官方接口（open.bigmodel.cn / api.z.ai）上的 GLM 视觉模型按官方文档改发**纯 base64**（不带 `data:` 前缀）；其他接口仍是 OpenAI 兼容的 data URL
- 视觉对话模型请求加 `temperature: 0.1`（GLM 视觉模型默认 0.8，对 OCR 偏高）
- 报错信息附带实际请求的模型名与地址；用了不能识图的纯文本模型（智谱返回 `取值范围 ['text']`）时直接提示换视觉模型
- 使用独立的 identifier `com.www011215.bob.glm-ocr`，带 appcast，Bob 里能收到更新提示

### 模型怎么选

| 模型 | 说明 | 智谱中国站价格（元 / 百万 tokens，输入 / 输出） |
|---|---|---|
| `glm-ocr`（默认） | 专用 OCR 模型，又快又准，最便宜 | 0.2 / 0.2 |
| `glm-5.3-flash` | 最新的原生多模态模型（2026-08） | 0.8 / 2.8 |
| `glm-4.6v-flash` | 免费的视觉模型 | 免费 |

- ⚠️ `glm-5.3`、`glm-5.2` 等**不带 flash 的旗舰模型是纯文本模型，不能识图**
- 价格以[官方定价](https://docs.bigmodel.cn/cn/guide/start/pricing)为准（上表为 2026-10 数据）
- `glm-ocr` 请配合「按量付费」接口使用；Coding Plan 接口默认用套餐内的视觉模型 `glm-5.3-flash`
- ⚠️ 智谱 / Z.ai 的 Coding Plan 条款规定套餐只能在官方支持的编程工具里使用，Bob 不在名单内，在这里用套餐 Key 有被限制权益的风险，建议用按量付费的 Key

### 接口对照表

| 设置项「接口」 | 实际地址 | 适用 Key |
|---|---|---|
| 智谱中国站 · 按量付费（默认） | `https://open.bigmodel.cn/api/paas/v4`（`glm-ocr` 走 `/layout_parsing`，其余走 `/chat/completions`） | [open.bigmodel.cn](https://open.bigmodel.cn) 的 API Key |
| 智谱中国站 · Coding Plan | `https://open.bigmodel.cn/api/coding/paas/v4/chat/completions` | GLM Coding Plan（中国版）订阅页生成的 Key |
| Z.ai 国际站 · 按量付费 | `https://api.z.ai/api/paas/v4`（同上） | [z.ai](https://z.ai) 开放平台 API Key |
| Z.ai 国际站 · Coding Plan | `https://api.z.ai/api/coding/paas/v4/chat/completions` | GLM Coding Plan（国际版）订阅页生成的 Key |
| OpenCode Zen · 按量付费 | `https://opencode.ai/zen/v1/chat/completions` | [opencode.ai](https://opencode.ai) Zen 的 API Key |
| OpenCode Go · 订阅 | `https://opencode.ai/zen/go/v1/chat/completions` | OpenCode Go 订阅 API Key，与 Zen 同一控制台生成 |
| DeepSeek 官方 | `https://api.deepseek.com/chat/completions` | [platform.deepseek.com](https://platform.deepseek.com) 的 API Key |
| 自定义 (OpenAI 兼容) | 填在「自定义接口地址」，如 `http://127.0.0.1:8080/v1` | 本地模型 / 第三方中转，Key 可留空 |

自定义接口地址会自动补全 `/chat/completions`；如果填的已是完整路径则原样使用。本地部署的模型（包括本地 `glm-ocr`）一律走 OpenAI 兼容的 `chat/completions`。

> **OpenCode 网关说明**（原作者）：Zen / Go 是聚合网关，仅走 OpenAI `chat/completions` 路径的模型（GLM、DeepSeek、Kimi、MiniMax 等）可用于本插件；GPT 系（`/responses`）、Claude 系（`/messages`）、Gemini 系（专用路径）不支持。

### 识别说明

- 视觉对话模型使用默认识别提示词：以 GLM 视觉模型的训练格式 `Free OCR.` 开头，显式**禁止翻译、禁止添加标题标签**；返回前还会自动剥离模型自行附加的 `OCR Result` / `Translation` 小节
- 「深度思考」选项仅对 GLM 对话模型生效：关闭（默认，更快）/ 开启（更准）/ 不发送参数；`glm-ocr` 不使用提示词和思考参数
- Bob 支持同一插件添加多个实例（例如一个 `glm-ocr`、一个 `glm-5.3-flash`）对比效果
- 连接本地模型：接口选「自定义」，地址填 `http://127.0.0.1:8080/v1`（例如 `vllm serve deepseek-ai/DeepSeek-OCR` 或 llama.cpp 的 `llama-server`），API Key 留空，模型填服务端对应的模型名

## 语音插件（tts/）

- 模型 `glm-tts`，接口 `https://open.bigmodel.cn/api/paas/v4/audio/speech`，输出 WAV。Z.ai 国际站目前没有 TTS 接口，只能用智谱中国站的 Key
- 价格约 2 元 / 万字符（以[官方定价](https://docs.bigmodel.cn/cn/guide/start/pricing)为准）
- 音色：彤彤（默认）、小陈、锤锤、jam、kazi、douji、luodo；用 GLM-TTS-Clone 复刻的音色把 ID 填进「自定义音色 ID」即可
- 语速 0.5–2×、音量可调
- 单次请求上限 1024 字：更长的文本按句切分、逐段合成，再拼成一段音频播放；单次朗读最多 3000 字（按字计费，防止误触长文）
- GLM-TTS 以中文为主，读英文一般：「朗读语言」默认「仅中文」，英文会交给 Bob 语音合成列表里排在后面的服务（比如 Google）。想让它也读英文，改成「中英混读」
- 设置页「验证」会合成「你好」两个字检查 Key（约 0.0004 元）
- 智谱默认会给合成的音频加 AI 水印；账号在智谱控制台开通了水印管理的话，可以在「AI 水印」里选择关闭

## 隐私

插件只向你所选的接口发送截图 / 文本和 API Key，不做任何统计或上报。除此之外唯一的网络访问是 Bob 定期读取本仓库的 `appcast.json`（识别插件）和 `tts/appcast.json`（语音插件）检查插件更新。

## 开发与发版

```
ocr/                           识别插件源码（info.json + main.js + icon.png）
appcast.json                   识别插件的更新源（放在根目录，Bob 插件列表只读这里）
tts/                           语音插件源码与它的更新源 tts/appcast.json
install.sh                     一键安装脚本
test.mjs                       冒烟测试：node test.mjs
build.py                       可复现打包 + 维护 appcast.json
.github/workflows/build.yml    CI：测试 + 打包；推 ocr-v* / tts-v* 标签时校验 sha256 并发布 Release
```

两个插件各自发版（以识别插件为例，语音插件把 `ocr` 换成 `tts`）：

1. 修改 `ocr/info.json` 的 `version`
2. `node test.mjs`
3. `python3 build.py ocr --appcast "这一版的更新说明"`（打包并把版本、sha256、下载地址写进 `appcast.json`；语音插件写进 `tts/appcast.json`）
4. 提交后打标签推送：`git tag ocr-vX.Y.Z && git push origin main ocr-vX.Y.Z`，CI 会校验 sha256 并自动发布 Release。不要用 `git push --tags`：GitHub 在一次推送超过 3 个标签时不会触发任何工作流

插件运行契约（原作者整理）：`main.js` 为普通脚本，Bob 用 JavaScriptCore 以 CommonJS 方式加载，入口函数需挂到 `exports`；识别插件实现 `supportLanguages()` + `ocr(query, completion)`，`query.image` 为 `$data`，用 `.toBase64()` 取 base64；语音插件实现 `supportLanguages()` + `tts(query, completion)`，返回 `{ type: 'base64', value }` 音频；请求用 `$http.request`，配置用 `$option.<identifier>` 读取。

## 许可

[MIT](LICENSE)。识别插件原作 © 2026 [MinatoHikari](https://github.com/MinatoHikari)，修改部分与语音插件 © 2026 [www011215](https://github.com/www011215)。
