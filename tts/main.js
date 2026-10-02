// 智谱 GLM-TTS 语音合成插件（Bob 版）
// 接口：POST https://open.bigmodel.cn/api/paas/v4/audio/speech（Z.ai 国际站目前没有 TTS）
// 单次请求文本上限 1024 字符：更长的文本按句切分、逐段合成，再拼成一个 WAV 交给 Bob 播放
// 配置通过 $option 读取：apiKey / voice / customVoice / speed / volume / watermark / languages

var API_URL = 'https://open.bigmodel.cn/api/paas/v4/audio/speech';
var MODEL = 'glm-tts';
var MAX_INPUT_CHARS = 1024;
// 按字计费且逐段串行合成：总长设上限，避免误触长文既费钱又等到 Bob 超时
var MAX_TOTAL_CHARS = 3000;
var REQUEST_TIMEOUT = 120;

// 优先在句末断开，其次在逗号 / 空格处，都没有才硬切
var STRONG_BREAKS = ['\n', '。', '！', '？', '!', '?', '；', ';', '…', '. '];
var WEAK_BREAKS = ['，', ',', '、', '：', ':', ' '];

function supportLanguages() {
    // GLM-TTS 以中文为主、读英文一般：默认只声明中文，英文交给其他语音服务；设置里可改为中英混读。
    // Bob 调用这里时 $option 未必已注入，不能直接读
    var option = (typeof $option !== 'undefined' && $option) || {};
    if (option.languages === 'zh_en') return ['zh-Hans', 'zh-Hant', 'en'];
    return ['zh-Hans', 'zh-Hant'];
}

function pluginTimeoutInterval() {
    return 300;
}

function errorObj(type, message) {
    return { type: type, message: message };
}

function resolveVoice() {
    var custom = ($option.customVoice || '').trim();
    return custom || $option.voice || 'tongtong';
}

function resolveNumber(value, fallback, min, max) {
    var n = parseFloat(value);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function lastBreak(window, marks) {
    var best = -1;
    for (var i = 0; i < marks.length; i++) {
        var at = window.lastIndexOf(marks[i]);
        if (at > best) best = at;
    }
    return best;
}

function splitText(text, max) {
    var chunks = [];
    var rest = String(text);
    while (rest.length > max) {
        var win = rest.slice(0, max);
        var strong = lastBreak(win, STRONG_BREAKS);
        var weak = lastBreak(win, WEAK_BREAKS);
        var cut = strong >= max / 2 ? strong : (weak >= max / 2 ? weak : Math.max(strong, weak));
        cut = cut > 0 ? cut + 1 : max;
        // 别把代理对（emoji 等）从中间切开
        var code = rest.charCodeAt(cut - 1);
        if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
        var piece = rest.slice(0, cut).trim();
        if (piece) chunks.push(piece);
        rest = rest.slice(cut);
    }
    rest = rest.trim();
    if (rest) chunks.push(rest);
    return chunks;
}

// 音频一律经 $data.toBase64() 取出、在 JS 里解析：不依赖 readUInt8 / length / subData 等方法，
// 这些在不同 Bob 版本里的表现与文档不一致
var B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var B64_INDEX = (function () {
    var table = [];
    for (var i = 0; i < 128; i++) table.push(-1);
    for (var j = 0; j < 64; j++) table[B64_CHARS.charCodeAt(j)] = j;
    table[45] = 62; // '-'（URL-safe 变体）
    table[95] = 63; // '_'
    return table;
})();

function base64ByteLength(b64) {
    var len = b64.length;
    var pad = b64.charAt(len - 1) === '=' ? (b64.charAt(len - 2) === '=' ? 2 : 1) : 0;
    return Math.floor(len * 3 / 4) - pad;
}

// 解码 base64；给了 maxBytes 时只解开头那么多字节
function base64ToBytes(b64, maxBytes) {
    var total = base64ByteLength(b64);
    var n = maxBytes === undefined ? total : Math.min(total, maxBytes);
    var out = new Uint8Array(Math.max(n, 0));
    var o = 0;
    var buf = 0;
    var bits = 0;
    for (var i = 0; i < b64.length && o < n; i++) {
        var c = b64.charCodeAt(i);
        var v = c < 128 ? B64_INDEX[c] : -1;
        if (v < 0) continue;
        buf = ((buf << 6) | v) & 0xffff;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (buf >> bits) & 255;
        }
    }
    return o === out.length ? out : out.subarray(0, o);
}

function bytesToBase64(bytes) {
    var parts = [];
    var s = '';
    var len = bytes.length;
    for (var i = 0; i < len; i += 3) {
        var n = (bytes[i] << 16) | ((i + 1 < len ? bytes[i + 1] : 0) << 8) | (i + 2 < len ? bytes[i + 2] : 0);
        s += B64_CHARS.charAt((n >> 18) & 63) + B64_CHARS.charAt((n >> 12) & 63) +
            (i + 1 < len ? B64_CHARS.charAt((n >> 6) & 63) : '=') +
            (i + 2 < len ? B64_CHARS.charAt(n & 63) : '=');
        if (s.length >= 16384) {
            parts.push(s);
            s = '';
        }
    }
    parts.push(s);
    return parts.join('');
}

function ascii(b, offset, n) {
    var s = '';
    for (var i = 0; i < n; i++) s += String.fromCharCode(b[offset + i]);
    return s;
}

function readU32(b, offset) {
    return (b[offset] | (b[offset + 1] << 8) | (b[offset + 2] << 16) | (b[offset + 3] << 24)) >>> 0;
}

function writeU32(b, offset, value) {
    for (var i = 0; i < 4; i++) b[offset + i] = (value >>> (8 * i)) & 0xff;
}

function isWav(b) {
    return b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE';
}

// 在 b（可以只是开头一段）里定位 data 段；total 为整段音频的真实字节数
function parseWav(b, total) {
    var offset = 12;
    while (offset + 8 <= b.length) {
        var id = ascii(b, offset, 4);
        var size = readU32(b, offset + 4);
        if (id === 'data') {
            var available = total - (offset + 8);
            var dataSize = (size === 0 || size === 0xffffffff || size > available) ? available : size;
            return { dataOffset: offset + 8, dataSize: dataSize, declared: size };
        }
        offset += 8 + size + (size & 1);
    }
    throw errorObj('api', '返回的 WAV 音频中找不到 data 段');
}

// 各段 WAV（base64）合成一个：单段且长度字段正常时原样返回；
// 否则整段解码，沿用第一段的文件头、拼接各段 PCM 负载、修正长度字段并去掉 data 之后的尾段
function mergeWav(list) {
    if (list.length === 1) {
        var total = base64ByteLength(list[0]);
        var head = base64ToBytes(list[0], 65536);
        var info = parseWav(head, total);
        if (info.declared === info.dataSize && info.dataOffset + info.dataSize === total && readU32(head, 4) === total - 8) {
            return list[0];
        }
    }
    var parts = [];
    var payload = 0;
    for (var i = 0; i < list.length; i++) {
        var bytes = base64ToBytes(list[i]);
        var p = parseWav(bytes, bytes.length);
        parts.push({ bytes: bytes, info: p });
        payload += p.dataSize;
    }
    var headerLen = parts[0].info.dataOffset;
    var out = new Uint8Array(headerLen + payload);
    out.set(parts[0].bytes.subarray(0, headerLen), 0);
    var pos = headerLen;
    for (var j = 0; j < parts.length; j++) {
        var q = parts[j];
        out.set(q.bytes.subarray(q.info.dataOffset, q.info.dataOffset + q.info.dataSize), pos);
        pos += q.info.dataSize;
    }
    writeU32(out, headerLen - 4, payload);
    writeU32(out, 4, out.length - 8);
    return bytesToBase64(out);
}

function contentType(resp) {
    var r = resp && resp.response;
    var headers = r && r.headers;
    if (headers) {
        for (var k in headers) {
            if (String(k).toLowerCase() === 'content-type') return String(headers[k]);
        }
    }
    return String((r && (r.MIMEType || r.mimeType)) || '未知');
}

// 返回的不是 WAV 时，把类型、长度和开头字节都报出来，方便排查
function describeResponse(resp, b64) {
    var parts = ['类型 ' + contentType(resp)];
    var textual = true;
    if (b64) {
        var head = base64ToBytes(b64, 16);
        var hex = [];
        for (var i = 0; i < head.length; i++) hex.push((head[i] < 16 ? '0' : '') + head[i].toString(16));
        parts.push(base64ByteLength(b64) + ' 字节');
        parts.push('开头 ' + hex.join(' '));
        textual = head.length > 0 && (head[0] === 0x7b || head[0] === 0x5b || head[0] === 0x3c);
    }
    return parts.join('，') + (textual ? '\n' + describeBody(resp) : '');
}

function describeBody(resp) {
    var body = resp && resp.data;
    if (body === undefined || body === null || typeof body !== 'object') {
        try {
            body = resp && resp.rawData ? resp.rawData.toUTF8() : body;
        } catch (e) {
            // 二进制无法按 UTF-8 解码时忽略
        }
    }
    if (body === undefined || body === null || body === '') return '（响应无内容）';
    return String(typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 400);
}

function buildBody(text) {
    var body = {
        model: MODEL,
        input: text,
        voice: resolveVoice(),
        response_format: 'wav',
        speed: resolveNumber($option.speed, 1.0, 0.5, 2),
        volume: resolveNumber($option.volume, 1.0, 0.1, 10)
    };
    // 关闭 AI 水印需要账号在智谱控制台开通水印管理；默认不传，由服务端决定
    if ($option.watermark === 'off') body.watermark_enabled = false;
    return body;
}

function requestSpeech(text, done) {
    var apiKey = ($option.apiKey || '').trim();
    $http.request({
        method: 'POST',
        url: API_URL,
        header: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey
        },
        body: buildBody(text),
        timeout: REQUEST_TIMEOUT,
        handler: function (resp) {
            var statusCode = resp && resp.response && resp.response.statusCode;
            if (resp && resp.error && !statusCode) {
                done(errorObj('network', 'Http Request Error: ' + (resp.error.message || JSON.stringify(resp.error)).slice(0, 300)));
                return;
            }
            if (statusCode === 401) {
                done(errorObj('secretKey', 'API Key 无效或已过期（HTTP 401）\n' + describeBody(resp)));
                return;
            }
            if (statusCode !== 200) {
                done(errorObj('network', 'Http Request Error\nHttp Status: ' + (statusCode || '未知') + '\n' + describeBody(resp)));
                return;
            }
            var b64 = '';
            try {
                var raw = resp && resp.rawData;
                if (raw && typeof raw.toBase64 === 'function') b64 = String(raw.toBase64() || '').replace(/\s+/g, '');
            } catch (e) {
                // 取不到就当没有数据，下面统一报错
            }
            if (!b64) {
                done(errorObj('api', '接口没有返回音频数据（' + describeResponse(resp, '') + '）'));
                return;
            }
            if (!isWav(base64ToBytes(b64, 16))) {
                done(errorObj('api', '接口返回的不是 WAV 音频（' + describeResponse(resp, b64) + '）'));
                return;
            }
            done(null, b64);
        }
    });
}

function synthesize(text, completion) {
    var chunks = splitText(text, MAX_INPUT_CHARS);
    var parts = [];
    var finished = false;

    function finish(obj) {
        if (finished) return;
        finished = true;
        completion(obj);
    }

    function next(i) {
        if (i >= chunks.length) {
            try {
                // 单段也过一遍 mergeWav：长度字段异常（流式头）时顺带修正
                var audio = mergeWav(parts);
                finish({
                    result: {
                        type: 'base64',
                        value: audio,
                        raw: { model: MODEL, voice: resolveVoice(), format: 'wav', chunks: chunks.length }
                    }
                });
            } catch (e) {
                finish({ error: (e && e.type && e.message) ? e : errorObj('api', String(e && e.message ? e.message : e)) });
            }
            return;
        }
        requestSpeech(chunks[i], function (err, data) {
            if (err) {
                if (chunks.length > 1) err.message += '\n（第 ' + (i + 1) + ' / ' + chunks.length + ' 段）';
                finish({ error: err });
                return;
            }
            parts.push(data);
            next(i + 1);
        });
    }

    try {
        next(0);
    } catch (e) {
        finish({ error: errorObj('unknown', String(e && e.message ? e.message : e)) });
    }
}

function tts(query, completion) {
    if (!($option.apiKey || '').trim()) {
        completion({ error: errorObj('secretKey', 'API Key 未配置：请在插件设置中填写智谱 API Key') });
        return;
    }
    var text = String((query && query.text) || '').trim();
    if (!text) {
        completion({ error: errorObj('param', '待合成文本为空') });
        return;
    }
    if (text.length > MAX_TOTAL_CHARS) {
        completion({ error: errorObj('param', '文本太长（' + text.length + ' 字）：单次最多朗读 ' + MAX_TOTAL_CHARS + ' 字，请选中较短的段落') });
        return;
    }
    synthesize(text, completion);
}

// 设置页「验证」：合成两个字确认 Key 可用（约 0.0004 元）
function pluginValidate(completion) {
    if (!($option.apiKey || '').trim()) {
        completion({ result: false, error: errorObj('secretKey', 'API Key 未配置') });
        return;
    }
    synthesize('你好', function (out) {
        if (out.error) completion({ result: false, error: out.error });
        else completion({ result: true });
    });
}

// Bob 以 CommonJS 方式加载插件，入口函数必须挂到 exports 上才能被识别
if (typeof exports !== 'undefined' && exports) {
    exports.supportLanguages = supportLanguages;
    exports.tts = tts;
    exports.pluginTimeoutInterval = pluginTimeoutInterval;
    exports.pluginValidate = pluginValidate;
}
