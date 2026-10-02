// 智谱 GLM 翻译插件（Bob 版）
// 三种模式：翻译（译成目标语言）/ 英英释义（简明英文改写 + 难词注释）/ 自定义 Prompt
// 查单个英文单词或短语时，用 Bob 原生词典卡片展示音标、词性、释义、例句、词根词缀
// 句子走流式输出（$http.streamRequest，Bob 1.8.0+）；释义用 Markdown 排版（Bob 1.21.0+ 渲染）
// 配置通过 $option 读取：mode / endpoint / customEndpoint / apiKey / model / thinking / wordCard / style / systemPrompt / userPrompt

var ENDPOINTS = {
    bigmodel: 'https://open.bigmodel.cn/api/paas/v4',
    bigmodel_coding: 'https://open.bigmodel.cn/api/coding/paas/v4',
    zai: 'https://api.z.ai/api/paas/v4',
    zai_coding: 'https://api.z.ai/api/coding/paas/v4'
};

var DEFAULT_ENDPOINT = 'bigmodel';

// 按量付费默认免费的 glm-4.7-flash；Coding Plan 套餐内是 glm-5.3-flash
var DEFAULT_MODELS = {
    bigmodel: 'glm-4.7-flash',
    zai: 'glm-4.7-flash',
    bigmodel_coding: 'glm-5.3-flash',
    zai_coding: 'glm-5.3-flash'
};

// Bob 语言代码 -> 提示词里用的语言名
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
    'mn': 'Mongolian'
};

var TRANSLATE_SYSTEM =
    'You are a professional translator. Translate the user\'s text from {source} into {target}. ' +
    'Output ONLY the translation: keep the original paragraph breaks, numbers, units and formatting, ' +
    'and do not add notes, explanations or quotation marks.';

var ACADEMIC_HINT =
    ' The text is likely academic or medical. Translate technical terms with the standard terminology of that field, ' +
    'keep widely used abbreviations (e.g. DNA, MRI, PD-1, HbA1c) as they are, and use a formal written register.';

var EXPLAIN_SYSTEM =
    'You are an English-to-English explainer for English learners. Never use any language other than English. ' +
    'Rewrite the user\'s text in simple, clear English (around CEFR B1 level) while keeping the meaning accurate, ' +
    'then explain the difficult words or phrases in simple English. ' +
    'If the text is not in English, first convert it into English, then do the same.';

var EXPLAIN_USER =
    'Text:\n<<<\n{text}\n>>>\n\n' +
    'Respond in exactly this Markdown format and nothing else:\n' +
    '**Simple English**\n<the rewritten text>\n\n' +
    '**Hard words**\n- **word or phrase**: short explanation in simple English\n\n' +
    'List at most 8 hard words, in the order they appear. If there are no hard words, leave out the "Hard words" section.';

// 英英释义 + 翻译：一次请求，英英在上、译文在下
var EXPLAIN_TRANS_SYSTEM =
    'You help English learners. First rewrite the user\'s text in simple, clear English (around CEFR B1 level) while keeping ' +
    'the meaning accurate, and explain the difficult words or phrases in simple English; use only English in these two parts, ' +
    'and if the text is not in English, convert it into English for them. Then translate the original text into {target}.';

var EXPLAIN_TRANS_USER =
    'Text:\n<<<\n{text}\n>>>\n\n' +
    'Respond in exactly this Markdown format and nothing else:\n' +
    '**Simple English**\n<the rewritten text>\n\n' +
    '**Hard words**\n- **word or phrase**: short explanation in simple English\n\n' +
    '**{heading}**\n<a faithful translation of the original text into {target}>\n\n' +
    'List at most 8 hard words, in the order they appear. If there are no hard words, leave out the "Hard words" section. ' +
    'If the original text is already in {target}, leave out the "{heading}" section.';

var DICT_PROMPT =
    'Act as a learner\'s dictionary for the English word or phrase below. Return ONLY one JSON object, no Markdown fences, in this shape:\n' +
    '{"word": "", "phonetics": {"us": "", "uk": ""}, "parts": [{"part": "", "means": [""]}], {extraShape}"examples": [""], ' +
    '"roots": "", "forms": [{"name": "", "words": [""]}], "synonyms": [""]}\n' +
    'Rules: phonetics are IPA; "part" is a short part-of-speech label such as n. v. adj. adv. prep. phr.; ' +
    'write every meaning in {meaning}, short and clear, at most 3 parts with at most 3 meanings each; {extraRule}' +
    '"examples" are 1-2 short natural English sentences; ' +
    '"roots" briefly explains the word roots and affixes in {meaning} (empty string if not meaningful); ' +
    '"forms" lists inflections or derived words with English names such as plural, past tense, noun, adverb; ' +
    '"synonyms" has at most 4 English words; use empty strings or arrays when unknown.\n\n' +
    'Word: {text}';

var DICT_TRANS_SHAPE = '"translation": [{"part": "", "means": [""]}], ';
var DICT_TRANS_RULE = '"translation" gives the same parts of speech with short meanings in {target} (at most 3 each); ';

// 只认 1-3 个英文单词（可带连字符 / 撇号）作为「查词」
var WORD_RE = /^[A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*){0,2}$/;

function supportLanguages() {
    var codes = ['auto'];
    for (var code in LANGUAGE_NAMES) codes.push(code);
    return codes;
}

function pluginTimeoutInterval() {
    return 120;
}

function errorObj(type, message) {
    return { type: type, message: message };
}

function langName(code) {
    return LANGUAGE_NAMES[code] || code || 'the detected language';
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

function buildChatUrl(baseUrl) {
    var base = String(baseUrl).trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(base)) return base;
    return base + '/chat/completions';
}

function resolveModel() {
    var model = ($option.model || '').trim();
    if (model) return model;
    if (isCustomEndpoint()) throw errorObj('param', '使用自定义接口时请填写模型名称');
    return DEFAULT_MODELS[resolveEndpoint()] || 'glm-4.7-flash';
}

var MODES = { translate: true, explain: true, explain_trans: true, custom: true };

function resolveMode() {
    var mode = $option.mode || 'translate';
    return MODES[mode] ? mode : 'translate';
}

// 「英英释义 + 翻译」里译文部分的标题
function transHeading(code) {
    if (code === 'zh-Hans') return '中文翻译';
    if (code === 'zh-Hant' || code === 'yue') return '中文翻譯';
    return 'Translation (' + langName(code) + ')';
}

function transDictLabel(code) {
    if (code === 'zh-Hans') return '中文释义';
    if (code === 'zh-Hant' || code === 'yue') return '中文釋義';
    return 'Translation';
}

// 占位符：内置提示词用 {name}；自定义 Prompt 用 $text / $query.text / $sourceLang / $targetLang（也认 {text} 等）
function fill(template, vars) {
    return String(template).replace(/\$query\.text|\$text|\$sourceLang|\$targetLang|\{(\w+)\}/g, function (m, name) {
        if (m === '$query.text' || m === '$text') return vars.text;
        if (m === '$sourceLang') return vars.source;
        if (m === '$targetLang') return vars.target;
        return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m;
    });
}

function buildRequest(model, messages, stream, temperature) {
    var body = { model: model, stream: stream, temperature: temperature, messages: messages };
    // GLM 4.5 及以上默认开启深度思考，翻译用不着：默认关闭以加快响应
    var thinking = ($option.thinking || 'disabled').trim();
    if (/^glm/i.test(model) && thinking !== 'auto') {
        body.thinking = { type: thinking === 'enabled' ? 'enabled' : 'disabled' };
    }
    return body;
}

function buildHeaders() {
    var headers = { 'Content-Type': 'application/json' };
    var apiKey = ($option.apiKey || '').trim();
    if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
    return headers;
}

function checkKey() {
    if (!($option.apiKey || '').trim() && !isCustomEndpoint()) {
        throw errorObj('secretKey', 'API Key 未配置：请在插件设置中填写智谱 API Key');
    }
}

function extractApiError(data) {
    if (!data || typeof data !== 'object') return '';
    var err = data.error;
    if (err && typeof err === 'object') return (err.code ? '[' + err.code + '] ' : '') + (err.message || JSON.stringify(err));
    if (typeof err === 'string') return err;
    if (data.msg || data.message) return String(data.msg || data.message);
    return '';
}

function httpError(statusCode, detail, where) {
    var type = statusCode === 401 || statusCode === 403 ? 'secretKey' : 'network';
    return errorObj(type, 'Http Request Error\nHttp Status: ' + (statusCode || '未知') + '\n' + (detail || '（响应无内容）').slice(0, 400) + '\n' + where);
}

// ---------- 查词：Bob 原生词典卡片 ----------

function parseJsonLoose(text) {
    var s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    var start = s.indexOf('{');
    var end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(s.slice(start, end + 1));
    } catch (e) {
        return null;
    }
}

function cleanIpa(value) {
    return String(value || '').trim().replace(/^[\/\[]+|[\/\]]+$/g, '').trim();
}

function asList(value) {
    if (!value) return [];
    if (!Array.isArray(value)) value = [value];
    return value.map(function (v) { return String(v || '').trim(); }).filter(Boolean);
}

function buildDict(word, d, opts) {
    var dict = { word: String(d.word || word).trim() || word, phonetics: [], parts: [], exchanges: [], additions: [] };
    var labels = opts.zhLabels ? { examples: '例句', roots: '词根词缀', synonyms: '近义词' } : { examples: 'Examples', roots: 'Roots', synonyms: 'Synonyms' };
    var ph = d.phonetics || {};
    if (cleanIpa(ph.us)) dict.phonetics.push({ type: 'us', value: cleanIpa(ph.us) });
    if (cleanIpa(ph.uk)) dict.phonetics.push({ type: 'uk', value: cleanIpa(ph.uk) });
    (Array.isArray(d.parts) ? d.parts : []).forEach(function (p) {
        var means = asList(p && p.means);
        if (means.length) dict.parts.push({ part: String((p && p.part) || '').trim(), means: means });
    });
    (Array.isArray(d.forms) ? d.forms : []).forEach(function (f) {
        var words = asList(f && f.words);
        if (words.length) dict.exchanges.push({ name: String((f && f.name) || '').trim() || 'form', words: words });
    });
    // 「英英释义 + 翻译」：英文释义在上（parts），译文释义作为第一条附加信息紧跟在下面
    if (opts.transLabel) {
        var trans = (Array.isArray(d.translation) ? d.translation : []).map(function (p) {
            var means = asList(p && p.means);
            var part = String((p && p.part) || '').trim();
            return means.length ? (part ? part + ' ' : '') + means.join('；') : '';
        }).filter(Boolean);
        if (trans.length) dict.additions.push({ name: opts.transLabel, value: trans.join('\n') });
    }
    var examples = asList(d.examples);
    var synonyms = asList(d.synonyms);
    var roots = String(d.roots || '').trim();
    if (examples.length) dict.additions.push({ name: labels.examples, value: examples.join('\n') });
    if (roots) dict.additions.push({ name: labels.roots, value: roots });
    if (synonyms.length) dict.additions.push({ name: labels.synonyms, value: synonyms.join(', ') });
    return dict;
}

async function lookupWord(query, ctx) {
    var bilingual = ctx.mode === 'explain_trans';
    var vars = {
        text: ctx.text,
        meaning: ctx.mode === 'translate' ? langName(ctx.to) : 'simple English',
        extraShape: bilingual ? DICT_TRANS_SHAPE : '',
        extraRule: bilingual ? fill(DICT_TRANS_RULE, { target: langName(ctx.transLang) }) : ''
    };
    var prompt = fill(DICT_PROMPT, vars);
    var body = buildRequest(ctx.model, [{ role: 'user', content: prompt }], false, 0.2);
    var resp = await $http.request({
        method: 'POST',
        url: ctx.url,
        header: buildHeaders(),
        body: body,
        cancelSignal: query.cancelSignal
    });
    var statusCode = resp && resp.response && resp.response.statusCode;
    if (resp && resp.error && !statusCode) {
        throw errorObj('network', 'Http Request Error: ' + (resp.error.message || JSON.stringify(resp.error)).slice(0, 300) + '\n' + ctx.where);
    }
    if (statusCode !== 200) throw httpError(statusCode, extractApiError(resp && resp.data) || JSON.stringify(resp && resp.data), ctx.where);
    var message = resp.data && resp.data.choices && resp.data.choices[0] && resp.data.choices[0].message;
    var content = message && typeof message.content === 'string' ? message.content : '';
    var parsed = parseJsonLoose(content);
    if (!parsed) return null; // 解析不了就退回普通翻译
    var dict = buildDict(ctx.text, parsed, {
        zhLabels: bilingual || (ctx.mode === 'translate' && /^(zh|yue|wyw)/.test(ctx.to || '')),
        transLabel: bilingual ? transDictLabel(ctx.transLang) : ''
    });
    if (!dict.parts.length) return null;
    var summary = dict.parts.map(function (p) { return (p.part ? p.part + ' ' : '') + p.means.join('; '); }).join('\n');
    return { from: ctx.from, to: ctx.to, toParagraphs: [summary], toDict: dict };
}

// ---------- 句子：流式输出 ----------

function buildMessages(ctx) {
    var vars = { text: ctx.text, source: langName(ctx.from), target: langName(ctx.to) };
    if (ctx.mode === 'explain') {
        return [
            { role: 'system', content: EXPLAIN_SYSTEM },
            { role: 'user', content: fill(EXPLAIN_USER, vars) }
        ];
    }
    if (ctx.mode === 'explain_trans') {
        var tv = { text: ctx.text, target: langName(ctx.transLang), heading: transHeading(ctx.transLang) };
        return [
            { role: 'system', content: fill(EXPLAIN_TRANS_SYSTEM, tv) },
            { role: 'user', content: fill(EXPLAIN_TRANS_USER, tv) }
        ];
    }
    if (ctx.mode === 'custom') {
        var system = ($option.systemPrompt || '').trim();
        var user = ($option.userPrompt || '').trim() || '$text';
        // 用户指令里没写占位符时，把原文接在指令后面，免得模型拿不到要处理的文本
        if (!/\$query\.text|\$text|\{text\}/.test(user)) user += '\n\n$text';
        var messages = [];
        if (system) messages.push({ role: 'system', content: fill(system, vars) });
        messages.push({ role: 'user', content: fill(user, vars) });
        return messages;
    }
    var instruction = fill(TRANSLATE_SYSTEM, vars) + ($option.style === 'academic' ? ACADEMIC_HINT : '');
    return [
        { role: 'system', content: instruction },
        { role: 'user', content: ctx.text }
    ];
}

function makeResult(ctx, text) {
    return {
        from: ctx.from,
        to: ctx.to,
        toParagraphs: [text],
        content: { format: ctx.format, text: text }
    };
}

// 按行切分 SSE：stream.text 的分块边界不保证落在行尾，未完成的行留到下一块
function createSseReader(onEvent) {
    var buffer = '';
    function handleLine(line) {
        if (line.indexOf('data:') !== 0) return;
        var payload = line.slice(5).trim();
        if (payload && payload !== '[DONE]') onEvent(payload);
    }
    return {
        feed: function (text) {
            buffer += text;
            var lines = buffer.split(/\r?\n/);
            buffer = lines.pop();
            for (var i = 0; i < lines.length; i++) handleLine(lines[i]);
        },
        flush: function () {
            if (buffer) handleLine(buffer);
            buffer = '';
        }
    };
}

function streamTranslate(query, ctx, done) {
    var text = '';
    var raw = '';
    var apiError = '';
    var finished = false;

    function finish(obj) {
        if (finished) return;
        finished = true;
        done(obj);
    }

    var reader = createSseReader(function (payload) {
        var data;
        try {
            data = JSON.parse(payload);
        } catch (e) {
            return;
        }
        var err = extractApiError(data);
        if (err && !(data.choices && data.choices.length)) {
            apiError = err;
            return;
        }
        var delta = data.choices && data.choices[0] && data.choices[0].delta;
        if (delta && typeof delta.content === 'string' && delta.content) {
            text += delta.content;
            if (query.onStream) query.onStream({ result: makeResult(ctx, text) });
        }
    });

    $http.streamRequest({
        method: 'POST',
        url: ctx.url,
        header: buildHeaders(),
        body: buildRequest(ctx.model, buildMessages(ctx), true, 0.3),
        cancelSignal: query.cancelSignal,
        streamHandler: function (stream) {
            if (finished || !stream || !stream.text) return;
            // 出错时响应体是普通 JSON 而不是 SSE，留一份原文给报错用
            if (raw.length < 4000) raw += stream.text;
            reader.feed(stream.text);
        },
        handler: function (resp) {
            reader.flush();
            var statusCode = resp && resp.response && resp.response.statusCode;
            if (resp && resp.error && !statusCode) {
                finish({ error: errorObj('network', 'Http Request Error: ' + (resp.error.message || JSON.stringify(resp.error)).slice(0, 300) + '\n' + ctx.where) });
                return;
            }
            if (statusCode && statusCode !== 200) {
                var detail = apiError || extractApiError(parseJsonLoose(raw)) || raw;
                finish({ error: httpError(statusCode, detail, ctx.where) });
                return;
            }
            if (apiError) {
                finish({ error: errorObj('api', apiError + '\n' + ctx.where) });
                return;
            }
            var output = text.trim();
            if (!output) {
                finish({ error: errorObj('api', '接口未返回译文\n' + ctx.where) });
                return;
            }
            finish({ result: makeResult(ctx, output) });
        }
    });
}

async function translate(query, completion) {
    function done(obj) {
        if (query && query.onCompletion) query.onCompletion(obj);
        else if (completion) completion(obj);
    }

    try {
        checkKey();
        var text = String((query && query.text) || '').trim();
        if (!text) throw errorObj('param', '待翻译文本为空');
        var mode = resolveMode();
        var model = resolveModel();
        var url = buildChatUrl(resolveBaseUrl());
        var explainLike = mode === 'explain' || mode === 'explain_trans';
        var ctx = {
            mode: mode,
            model: model,
            url: url,
            text: text,
            from: query.detectFrom,
            // 英英释义以英文为主；「英英释义 + 翻译」的译文语言取目标语言，目标是英文时退回简体中文
            to: explainLike ? 'en' : query.detectTo,
            transLang: query.detectTo && query.detectTo !== 'en' ? query.detectTo : 'zh-Hans',
            format: mode === 'translate' ? 'plain' : 'markdown',
            where: '模型 ' + model + ' · ' + url
        };

        if (mode !== 'custom' && $option.wordCard !== 'off' && WORD_RE.test(text) &&
            (explainLike || query.detectFrom === 'en')) {
            var dictResult = await lookupWord(query, ctx);
            if (dictResult) {
                done({ result: dictResult });
                return;
            }
        }

        streamTranslate(query, ctx, done);
    } catch (e) {
        done({ error: (e && e.type && e.message) ? e : errorObj('unknown', String(e && e.message ? e.message : e)) });
    }
}

// 设置页「验证」：发一条极短的请求确认 Key、接口和模型可用
function pluginValidate(completion) {
    try {
        checkKey();
        var model = resolveModel();
        var url = buildChatUrl(resolveBaseUrl());
        var body = buildRequest(model, [{ role: 'user', content: 'Reply with OK.' }], false, 0.1);
        body.max_tokens = 8;
        $http.request({
            method: 'POST',
            url: url,
            header: buildHeaders(),
            body: body,
            handler: function (resp) {
                var statusCode = resp && resp.response && resp.response.statusCode;
                if (statusCode === 200) {
                    completion({ result: true });
                    return;
                }
                var err = resp && resp.error && !statusCode
                    ? errorObj('network', 'Http Request Error: ' + (resp.error.message || JSON.stringify(resp.error)).slice(0, 300))
                    : httpError(statusCode, extractApiError(resp && resp.data) || JSON.stringify(resp && resp.data), '模型 ' + model + ' · ' + url);
                completion({ result: false, error: err });
            }
        });
    } catch (e) {
        completion({ result: false, error: (e && e.type && e.message) ? e : errorObj('unknown', String(e && e.message ? e.message : e)) });
    }
}

// Bob 以 CommonJS 方式加载插件，入口函数必须挂到 exports 上才能被识别
if (typeof exports !== 'undefined' && exports) {
    exports.supportLanguages = supportLanguages;
    exports.translate = translate;
    exports.pluginTimeoutInterval = pluginTimeoutInterval;
    exports.pluginValidate = pluginValidate;
}
