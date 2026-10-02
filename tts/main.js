// 智谱 GLM-TTS 语音合成插件（Bob 版）
// 接口：POST https://open.bigmodel.cn/api/paas/v4/audio/speech（Z.ai 国际站目前没有 TTS）
// 单次请求文本上限 1024 字符：更长的文本按句切分、逐段合成，再拼成一个 WAV 交给 Bob 播放
// 配置通过 $option 读取：apiKey / voice / customVoice / speed / volume / languages

var API_URL = 'https://open.bigmodel.cn/api/paas/v4/audio/speech';
var MODEL = 'glm-tts';
var MAX_INPUT_CHARS = 1024;
var REQUEST_TIMEOUT = 60;

// 优先在句末断开，其次在逗号 / 空格处，都没有才硬切
var STRONG_BREAKS = ['\n', '。', '！', '？', '!', '?', '；', ';', '…', '. '];
var WEAK_BREAKS = ['，', ',', '、', '：', ':', ' '];

function supportLanguages() {
    // GLM-TTS 以中文为主，支持中英混读；可在设置里改为只读中文，英文交给其他语音服务
    if ($option.languages === 'zh') return ['zh-Hans', 'zh-Hant'];
    return ['zh-Hans', 'zh-Hant', 'en'];
}

function pluginTimeoutInterval() {
    return 120;
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
        var cut = lastBreak(win, STRONG_BREAKS);
        if (cut < max / 2) cut = lastBreak(win, WEAK_BREAKS);
        cut = cut < max / 2 ? max : cut + 1;
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

function ascii(d, offset, n) {
    var s = '';
    for (var i = 0; i < n; i++) s += String.fromCharCode(d.readUInt8(offset + i));
    return s;
}

function readU32(d, offset) {
    return (d.readUInt8(offset) | (d.readUInt8(offset + 1) << 8) |
        (d.readUInt8(offset + 2) << 16) | (d.readUInt8(offset + 3) << 24)) >>> 0;
}

function writeU32(d, offset, value) {
    for (var i = 0; i < 4; i++) d.writeUInt8((value >>> (8 * i)) & 0xff, offset + i);
}

function isWav(d) {
    return d && d.length >= 12 && ascii(d, 0, 4) === 'RIFF' && ascii(d, 8, 4) === 'WAVE';
}

// 定位 data 段：返回负载起点、长度字段位置与负载长度
function parseWav(d) {
    var offset = 12;
    while (offset + 8 <= d.length) {
        var id = ascii(d, offset, 4);
        var size = readU32(d, offset + 4);
        if (id === 'data') {
            var available = d.length - (offset + 8);
            var dataSize = (size === 0 || size === 0xffffffff || size > available) ? available : size;
            return { dataOffset: offset + 8, dataSizeOffset: offset + 4, dataSize: dataSize };
        }
        offset += 8 + size + (size & 1);
    }
    throw errorObj('api', '返回的 WAV 音频中找不到 data 段');
}

// 多段 WAV（同一接口同一参数，格式一致）拼成一个：沿用第一段的文件头，拼接各段 PCM 负载并修正长度字段
function concatWav(parts) {
    var first = parseWav(parts[0]);
    var out = parts[0].subData(0, first.dataOffset + first.dataSize);
    var total = first.dataSize;
    for (var i = 1; i < parts.length; i++) {
        var p = parseWav(parts[i]);
        out.appendData(parts[i].subData(p.dataOffset, p.dataOffset + p.dataSize));
        total += p.dataSize;
    }
    writeU32(out, first.dataSizeOffset, total);
    writeU32(out, 4, out.length - 8);
    return out;
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
    return String(typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 400);
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
        body: {
            model: MODEL,
            input: text,
            voice: resolveVoice(),
            response_format: 'wav',
            speed: resolveNumber($option.speed, 1.0, 0.5, 2),
            volume: resolveNumber($option.volume, 1.0, 0.1, 10)
        },
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
            if (!isWav(resp.rawData)) {
                done(errorObj('api', '接口未返回 WAV 音频：' + describeBody(resp)));
                return;
            }
            done(null, resp.rawData);
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
                var audio = parts.length === 1 ? parts[0] : concatWav(parts);
                finish({
                    result: {
                        type: 'base64',
                        value: audio.toBase64(),
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
