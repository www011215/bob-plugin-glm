// 智谱 GLM 文字识别（OCR）插件（Bob 版）
// 基于 MinatoHikari/bob-llmtranslation-ocr 的识别插件修改（MIT）：
//   https://github.com/MinatoHikari/bob-llmtranslation-ocr
// Bob 插件为普通脚本，需定义 supportLanguages() 与 ocr(query, completion)
// 配置通过 $option 读取：endpoint / customEndpoint / apiKey / model / thinking / ocrPrompt
//
// 注意：DeepSeek 要求图片只出现在 user 消息中

var ENDPOINTS = {
    deepseek: 'https://api.deepseek.com',
    zai: 'https://api.z.ai/api/paas/v4',
    zai_coding: 'https://api.z.ai/api/coding/paas/v4',
    bigmodel: 'https://open.bigmodel.cn/api/paas/v4',
    bigmodel_coding: 'https://open.bigmodel.cn/api/coding/paas/v4',
    zen: 'https://opencode.ai/zen/v1',
    go: 'https://opencode.ai/zen/go/v1'
};

var DEFAULT_ENDPOINT = 'bigmodel';

// 各端点默认模型：智谱 / Z.ai 按量付费默认专用 OCR 模型 glm-ocr（走 layout_parsing 接口）；
// Coding Plan 套餐内的视觉模型是 glm-5.3-flash；
// Zen 没有 deepseek-v4.1-flash，用 glm-5.3-flash；Go 用 stable 的 deepseek-v4.1-flash（二者均支持图片输入）
var DEFAULT_MODELS = {
    deepseek: 'deepseek-flash',
    zai: 'glm-ocr',
    zai_coding: 'glm-5.3-flash',
    bigmodel: 'glm-ocr',
    bigmodel_coding: 'glm-5.3-flash',
    zen: 'glm-5.3-flash',
    go: 'deepseek-v4.1-flash'
};

// Bob 语言代码 -> 语言名（提示词用；识别本身按图自动识别语言）
var LANGUAGE_NAMES = {
    'zh-Hans': 'Simplified Chinese',
    'zh-Hant': 'Traditional Chinese',
    'yue': 'Cantonese',
    'wyw': 'Classical Chinese',
    'en': 'English',
    'ja': 'Japanese',
    'ko': 'Korean',
    'fr': 'French',
    'de': 'German',
    'es': 'Spanish',
    'it': 'Italian',
    'ru': 'Russian',
    'pt-pt': 'Portuguese',
    'pt-br': 'Brazilian Portuguese',
    'tr': 'Turkish',
    'vi': 'Vietnamese',
    'id': 'Indonesian',
    'th': 'Thai',
    'ms': 'Malay',
    'ar': 'Arabic',
    'hi': 'Hindi',
    'fa': 'Persian',
    'sv': 'Swedish',
    'pl': 'Polish',
    'nl': 'Dutch',
    'uk': 'Ukrainian',
    'he': 'Hebrew',
    'km': 'Khmer',
    'nb': 'Norwegian Bokmål',
    'nn': 'Norwegian Nynorsk',
    'mn': 'Mongolian'
};

// 提示词显式禁止翻译与附加标签；Free OCR. 为 GLM 视觉模型的训练格式
var DEFAULT_OCR_PROMPT =
    'Free OCR. Recognize ALL text in the image and output it verbatim in the original language, keeping the original line breaks. ' +
    'Do NOT translate. Do NOT add any headings, labels (such as OCR Result or Translation), markdown formatting or explanations. ' +
    'Output only the recognized text.';

var TEXT_ONLY_HINT = '提示：该模型不支持图片输入，请换视觉模型（如 glm-ocr / glm-5.3-flash / glm-4.6v-flash）';

// 清洗模型自行附加的内容：剥离 OCR Result/识别结果 标签前缀；
// 模型先输出过这类标签、随后又出现 Translation/翻译 小节时，丢弃该行及之后全部内容（模型自作主张的翻译）。
// 没有标签时不截断，以免截图正文里本来就有的 "Translation:" 行被误删
function sanitizeOcrText(text) {
    var lines = String(text).split('\n');
    var out = [];
    var sawLabel = false;
    for (var i = 0; i < lines.length; i++) {
        var trimmed = lines[i].replace(/\s+$/, '');
        if (sawLabel && /^(\*{1,2}|_{1,2})?\s*(translation|译文|翻译)\s*(\*{1,2}|_{1,2})?\s*[:：]\s*(\*{1,2}|_{1,2})?\s*/i.test(trimmed)) {
            break;
        }
        var label = trimmed.match(/^(\*{1,2}|_{1,2})?\s*(ocr\s*result|ocr结果|识别结果)\s*(\*{1,2}|_{1,2})?\s*[:：]\s*(\*{1,2}|_{1,2})?\s*/i);
        if (label) {
            sawLabel = true;
            var rest = trimmed.slice(label[0].length).trim();
            if (rest) out.push(rest);
            continue;
        }
        out.push(lines[i]);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

var NAMED_ENTITIES = {
    nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'", amp: '&',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…',
    middot: '·', times: '×', divide: '÷', deg: '°', plusmn: '±', le: '≤', ge: '≥', ne: '≠',
    micro: 'µ', copy: '©', reg: '®', trade: '™'
};

// 单次扫描解码 HTML 实体（常见命名实体 + 十进制 / 十六进制数字实体），&amp;lt; 只解一层
function decodeHtmlEntities(s) {
    return s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g, function (m, dec, hex, name) {
        if (name) return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m;
        var cp = dec ? parseInt(dec, 10) : parseInt(hex, 16);
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    });
}

// 只删这些已知的 HTML 标签，避免把正文里的 "P < 0.05 … n > 30"、"vector<int>" 当成标签吞掉
var HTML_TAG = /<\/?(?:table|thead|tbody|tfoot|caption|colgroup|col|tr|td|th|div|p|span|img|br|hr|b|i|u|s|em|strong|sub|sup|ul|ol|li|a|center|font|figure|figcaption|h[1-6])(?:\s[^<>]*)?\/?>/gi;

// glm-ocr 返回 Markdown（md_results）：转成适合 Bob 展示 / 复制的纯文本
// 去掉图片引用、标题与加粗标记、代码块围栏；HTML / Markdown 表格转为制表符分隔的行
function markdownToPlainText(md) {
    var s = String(md).replace(/\r\n?/g, '\n');
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/t[dh]>\s*/gi, '\t').replace(/\t?<\/tr>\s*/gi, '\n');
    s = s.replace(/<\/(?:p|div|li|h[1-6]|ul|ol|table|figure|figcaption|caption)>/gi, '\n');
    s = s.replace(HTML_TAG, '');
    s = decodeHtmlEntities(s);
    var out = [];
    var inFence = false;
    var lines = s.split('\n');
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        // 代码块：去掉 ``` 围栏，块内原样保留（不当作 Markdown 处理）
        if (/^\s*(```|~~~)/.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) {
            out.push(line.replace(/\s+$/, ''));
            continue;
        }
        if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) continue;
        if (/^\s*\|.*\|\s*$/.test(line)) {
            line = line.trim().replace(/^\||\|$/g, '').split('|').map(function (c) {
                return c.trim();
            }).join('\t');
        }
        // 加粗只在词边界处去标记，x**2、f(**kwargs) 这类正文保持原样
        line = line.replace(/^\s{0,3}#{1,6}\s+/, '')
            .replace(/(^|[^\w*])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*(?![\w*])/g, '$1$2')
            .replace(/ +$/, '');
        out.push(line);
    }
    // 不用 trim()：表格首行的前导制表符（左上角空单元格）要保留
    return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '');
}

function supportLanguages() {
    var codes = [];
    for (var code in LANGUAGE_NAMES) codes.push(code);
    return codes;
}

function isCustomEndpoint() {
    return ($option.customEndpoint || '').trim().length > 0 || $option.endpoint === 'custom';
}

function resolveEndpoint() {
    return $option.endpoint || DEFAULT_ENDPOINT;
}

function resolveBaseUrl() {
    var custom = ($option.customEndpoint || '').trim();
    if (custom) return custom;
    if (resolveEndpoint() === 'custom') {
        throw errorObj('param', '已选择「自定义」接口：请填写「自定义接口地址」（如 http://127.0.0.1:8080/v1）');
    }
    var preset = ENDPOINTS[resolveEndpoint()];
    if (preset) return preset;
    throw errorObj('param', '接口地址配置无效（' + resolveEndpoint() + '）：请重新选择接口');
}

// 智谱官方接口（open.bigmodel.cn / api.z.ai）
function isZhipuHost(url) {
    return /^https:\/\/(open\.bigmodel\.cn|api\.z\.ai)\//i.test(String(url));
}

function buildChatUrl(baseUrl) {
    var base = String(baseUrl).trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(base)) return base;
    return base + '/chat/completions';
}

// glm-ocr 在智谱官方接口上走文档解析接口 layout_parsing，不是 chat/completions
function buildLayoutParsingUrl(baseUrl) {
    var base = String(baseUrl).trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    if (/\/layout_parsing$/.test(base)) return base;
    return base + '/layout_parsing';
}

function resolveModel() {
    var model = ($option.model || '').trim();
    if (model) return model;
    if (isCustomEndpoint()) throw errorObj('param', '使用自定义接口时请填写模型名称（如 DeepSeek-OCR 填 deepseek-ai/DeepSeek-OCR-GGUF）');
    return DEFAULT_MODELS[resolveEndpoint()] || 'glm-ocr';
}

function errorObj(type, message) {
    return { type: type, message: message };
}

async function ocr(query, completion) {
    function done(obj) {
        if (query && query.onCompletion) query.onCompletion(obj);
        else if (completion) completion(obj);
    }

    try {
        if (!query || !query.image) throw errorObj('param', '未收到图片数据');

        var apiKey = ($option.apiKey || '').trim();
        var custom = isCustomEndpoint();
        if (!apiKey && !custom) {
            throw errorObj('secretKey', 'API Key 未配置：请在插件设置中填写 API Key');
        }
        var headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

        var model = resolveModel();
        var baseUrl = resolveBaseUrl();
        var zhipu = isZhipuHost(baseUrl);
        var base64 = query.image.toBase64();
        // Bob 截图是 PNG；万一传来 JPEG（base64 以 /9j/ 开头），mime 跟着改
        var mime = /^\/9j\//.test(base64) ? 'image/jpeg' : 'image/png';
        var dataUrl = 'data:' + mime + ';base64,' + base64;

        var layoutParsing = zhipu && /^glm-ocr/i.test(model);
        var url;
        var body;
        if (layoutParsing) {
            // 专用 OCR 模型：file 传 data URI（官方 glmocr SDK 的做法），返回 Markdown
            url = buildLayoutParsingUrl(baseUrl);
            body = { model: model, file: dataUrl };
        } else {
            var customPrompt = ($option.ocrPrompt || '').trim();
            var prompt = customPrompt || DEFAULT_OCR_PROMPT;

            // 智谱官方接口文档示例为纯 base64（不带 data: 前缀）；其他接口保持 OpenAI 兼容的 data URL
            var imageUrl = (zhipu && /^glm/i.test(model)) ? base64 : dataUrl;

            url = buildChatUrl(baseUrl);
            body = {
                model: model,
                stream: false,
                temperature: 0.1,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'image_url', image_url: { url: imageUrl } },
                            { type: 'text', text: prompt }
                        ]
                    }
                ]
            };

            // GLM 系列支持 thinking 开关；默认关闭以加快识别，auto 则不发送该参数
            var thinking = ($option.thinking || 'disabled').trim();
            if (/^glm/i.test(model) && thinking !== 'auto') {
                body.thinking = { type: thinking === 'enabled' ? 'enabled' : 'disabled' };
            }
        }

        var resp = await $http.request({
            method: 'POST',
            url: url,
            header: headers,
            body: body
        });

        var where = '模型 ' + model + ' · ' + url;
        var statusCode = resp && resp.response && resp.response.statusCode;
        if (resp && resp.error) {
            throw errorObj('network', 'Http Request Error: ' + (resp.error.message || JSON.stringify(resp.error)).slice(0, 300) + '\n' + where);
        }
        if (statusCode !== 200) {
            var raw = String(JSON.stringify(resp && resp.data)).slice(0, 400);
            var hint = /取值范围\s*\['text'\]/.test(raw) ? '\n' + TEXT_ONLY_HINT : '';
            throw errorObj('network', 'Http Request Error\nHttp Status: ' + (statusCode || '未知') + '\n' + raw + hint + '\n' + where);
        }

        var data = resp.data;
        var text;
        if (layoutParsing) {
            var md = data && data.md_results;
            if (Array.isArray(md)) md = md.join('\n\n');
            text = md ? markdownToPlainText(md) : '';
            if (!text) {
                throw errorObj('api', '接口未返回识别内容：' + String(JSON.stringify(data)).slice(0, 400) + '\n' + where);
            }
        } else {
            var choice = data && data.choices && data.choices[0];
            var message = choice && choice.message;
            var content = '';
            if (message && typeof message.content === 'string') {
                content = message.content;
            } else if (message && Array.isArray(message.content)) {
                content = message.content.map(function (p) {
                    return p && typeof p.text === 'string' ? p.text : '';
                }).join('');
            }
            content = (content || '').trim();
            // content 为空时不回退到 reasoning_content：那是模型的思考过程，不是识别结果
            if (!content) {
                throw errorObj('api', '接口未返回内容：' + String(JSON.stringify(data)).slice(0, 400) + '\n' + where);
            }
            // 模型偶尔用一对引号把整段结果包起来；只在首尾成对且中间没有其它引号时去掉，截图里本来的引号保持原样
            if (/^"[^"]*"$/.test(content)) content = content.slice(1, -1).trim();
            text = sanitizeOcrText(content);
        }

        var texts = text.split('\n').map(function (line) {
            return { text: line };
        });
        done({
            result: {
                from: query.detectFrom,
                texts: texts
            }
        });
    } catch (e) {
        var err = (e && e.type && e.message) ? e : errorObj('unknown', String(e && e.message ? e.message : e));
        done({ error: err });
    }
}

// Bob 以 CommonJS 方式加载插件，入口函数必须挂到 exports 上才能被识别
if (typeof exports !== 'undefined' && exports) {
    var __entry = typeof translate === 'function' ? 'translate' : (typeof ocr === 'function' ? 'ocr' : null);
    if (__entry === 'translate') exports.translate = translate;
    if (__entry === 'ocr') exports.ocr = ocr;
    exports.supportLanguages = supportLanguages;
}
