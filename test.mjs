// Bob 插件冒烟测试：mock $option / $http / $data，验证请求构造与结果解析
// 运行：node test.mjs（或 bun test.mjs）
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failures = 0;

function check(name, cond, extra) {
    if (cond) {
        passed++;
        console.log('  ✓ ' + name);
    } else {
        failures++;
        console.error('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : ''));
    }
}

const read = (p) => readFileSync(path.join(here, p), 'utf8');

// 按 Bob 的 CommonJS 方式加载：注入 exports 对象，入口函数必须挂到 exports 上才能被识别
function load(script, $option, $http) {
    const exportsObj = {};
    new Function('$option, $http, exports', script)($option, $http, exportsObj);
    return exportsObj;
}

// ======================================================================
// 识别插件 ocr/
// ======================================================================
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DATA_URL = 'data:image/png;base64,' + PNG_B64;
const OCR_SCRIPT = read('ocr/main.js');
const OCR_INFO = JSON.parse(read('ocr/info.json'));

function makeHttp(data, capture, statusCode = 200) {
    return {
        request: async (options) => {
            if (capture) capture.push(options);
            if (typeof data === 'function') return data(options);
            return { response: { statusCode }, data };
        }
    };
}

async function runOcr($option, data, statusCode) {
    const captured = [];
    const o = load(OCR_SCRIPT, $option, makeHttp(data, captured, statusCode));
    check('ocr 入口函数已挂载到 exports', typeof o.ocr === 'function' && typeof o.supportLanguages === 'function', Object.keys(o));
    const out = await new Promise((resolve) => {
        o.ocr({ image: { toBase64: () => PNG_B64 }, detectFrom: 'zh-Hans', onCompletion: resolve }, null);
    });
    return { req: captured[0], out, lines: out.result ? out.result.texts.map((t) => t.text) : null };
}

const CHAT_OK = { choices: [{ message: { content: '第一行\n第二行' } }] };

console.log('== ocr：配置一致性 ==');
{
    const consts = new Function('$option, $http, exports', OCR_SCRIPT + '\nreturn { ENDPOINTS, DEFAULT_ENDPOINT, DEFAULT_MODELS };')({}, {}, {});
    const endpointOpt = OCR_INFO.options.find((o) => o.identifier === 'endpoint');
    check('identifier 为独立 ID', OCR_INFO.identifier === 'com.www011215.bob.glm-ocr', OCR_INFO.identifier);
    check('summary / author 注明原作者', OCR_INFO.summary.includes('MinatoHikari') && OCR_INFO.author.includes('MinatoHikari'));
    check('菜单默认值 = 第一项 = 代码默认接口', endpointOpt.defaultValue === endpointOpt.menuValues[0].value && endpointOpt.defaultValue === consts.DEFAULT_ENDPOINT, endpointOpt.defaultValue);
    check('菜单接口都有预设地址', endpointOpt.menuValues.every((m) => m.value === 'custom' || consts.ENDPOINTS[m.value]));
    check('每个预设接口都有默认模型', Object.keys(consts.ENDPOINTS).every((k) => consts.DEFAULT_MODELS[k]));
}

console.log('== ocr：glm-ocr（layout_parsing） ==');
{
    // 场景：全部留空 → 智谱中国站 + glm-ocr
    const md = '# 标题\n\n**加粗**正文第一行\n\n![](page_1.jpg)\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    const { req, out, lines } = await runOcr({ apiKey: 'sk-bm' }, { md_results: md });
    check('默认走 layout_parsing', req.url === 'https://open.bigmodel.cn/api/paas/v4/layout_parsing', req.url);
    check('body 只有 model + file(data URI)', req.body.model === 'glm-ocr' && req.body.file === DATA_URL && Object.keys(req.body).length === 2, req.body);
    check('Bearer 认证头', req.header.Authorization === 'Bearer sk-bm');
    check('Markdown 转纯文本（标题/加粗/图片/表格）', JSON.stringify(lines) === JSON.stringify(['标题', '', '加粗正文第一行', '', 'a\tb', '1\t2']), lines);
    check('result.from 为 detectFrom', out.result.from === 'zh-Hans', out.result);
}
{
    const html = '<table><tr><th>名称</th><th>数量</th></tr><tr><td>A&amp;B</td><td>3</td></tr></table>';
    const { lines } = await runOcr({ endpoint: 'bigmodel', apiKey: 'k' }, { md_results: html });
    check('HTML 表格转制表符分隔', JSON.stringify(lines) === JSON.stringify(['名称\t数量', 'A&B\t3']), lines);
}
{
    const { req } = await runOcr({ endpoint: 'zai', apiKey: 'k' }, { md_results: 'x' });
    check('Z.ai 按量付费默认 glm-ocr', req.url === 'https://api.z.ai/api/paas/v4/layout_parsing' && req.body.model === 'glm-ocr', req.url);
}
{
    // 场景：自定义接口填了完整 chat 地址，glm-ocr 仍换算到 layout_parsing
    const { req } = await runOcr({ customEndpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', apiKey: 'k', model: 'glm-ocr' }, { md_results: 'x' });
    check('完整 chat 地址换算为 layout_parsing', req.url === 'https://open.bigmodel.cn/api/paas/v4/layout_parsing', req.url);
}
{
    // 场景：本地部署的 glm-ocr（vLLM 等）只有 OpenAI 兼容接口 → 走 chat/completions + data URL
    const { req } = await runOcr({ endpoint: 'custom', customEndpoint: 'http://127.0.0.1:8080/v1', model: 'glm-ocr' }, CHAT_OK);
    check('本地 glm-ocr 走 chat/completions', req.url === 'http://127.0.0.1:8080/v1/chat/completions', req.url);
    check('本地接口图片为 data URL', req.body.messages[0].content[0].image_url.url === DATA_URL);
}
{
    const { out } = await runOcr({ apiKey: 'k' }, { md_results: '' });
    check('md_results 为空报 api 错误并带模型名', out.error && out.error.type === 'api' && out.error.message.includes('glm-ocr'), out.error);
}
{
    const { out } = await runOcr({ apiKey: 'k', ocrPrompt: '只输出数字' }, { md_results: '42' });
    check('glm-ocr 忽略自定义提示词', out.result && out.result.texts[0].text === '42', out);
}

console.log('== ocr：Markdown → 纯文本回归（QA 发现的问题） ==');
{
    const md2text = new Function('$option, $http, exports', OCR_SCRIPT + '\nreturn markdownToPlainText;')({}, {}, {});
    const same = (input) => md2text(input) === input;
    check('正文里的 < > 不被当成标签吞掉', same('The mean was higher (P < 0.01).') && same('Another finding with n > 30 samples.') && same('std::vector<int> v; #include <stdio.h>'), md2text('P < 0.05 and n > 30'));
    check('表格单元格里的 < 0.001 保留', md2text('<table><tr><td>A</td><td>< 0.001</td></tr></table>') === 'A\t< 0.001', md2text('<table><tr><td>A</td><td>< 0.001</td></tr></table>'));
    check('x**2、**kwargs、__init__、>65 保持原样', same('x**2 + y**2') && same('def f(**kwargs, **opts)') && same('file __init__.py') && same('>65 years old'));
    check('词边界处的加粗照常去掉', md2text('中文**加粗**中文 and **bold** text') === '中文加粗中文 and bold text', md2text('中文**加粗**中文 and **bold** text'));
    check('代码块去围栏、块内 # 注释保留', md2text('```python\n# compute sum\nx = a**2\n```') === '# compute sum\nx = a**2', md2text('```python\n# compute sum\nx = a**2\n```'));
    check('HTML 实体（数字 / 命名）解码', md2text('It&#x27;s &rsquo; &hellip; &#8217; &amp;lt;') === 'It\'s ’ … ’ &lt;', md2text('It&#x27;s &rsquo; &hellip; &#8217; &amp;lt;'));
    check('相邻块级元素分行', md2text('<div>Line A</div><div>Line B</div>') === 'Line A\nLine B', md2text('<div>Line A</div><div>Line B</div>'));
    check('左上角空单元格保留（表头不错列）', md2text('<table><tr><th></th><th>A</th><th>B</th></tr><tr><td>r1</td><td>1</td><td>2</td></tr></table>') === '\tA\tB\nr1\t1\t2');
}

console.log('== ocr：视觉对话模型（chat/completions） ==');
{
    // 场景：截图正文本来就有 Translation: 行（没有模型附加的标签）→ 不截断
    const { lines } = await runOcr({ endpoint: 'deepseek', apiKey: 'k' }, { choices: [{ message: { content: 'Translation: bonjour = hello\nmerci = thanks' } }] });
    check('正文里的 Translation: 行不被截断', JSON.stringify(lines) === JSON.stringify(['Translation: bonjour = hello', 'merci = thanks']), lines);
}
{
    const { lines } = await runOcr({ endpoint: 'deepseek', apiKey: 'k' }, { choices: [{ message: { content: '"Hello," he said.' } }] });
    check('截图里本来的引号保持原样', JSON.stringify(lines) === JSON.stringify(['"Hello," he said.']), lines);
    const wrapped = await runOcr({ endpoint: 'deepseek', apiKey: 'k' }, { choices: [{ message: { content: '"整段被包起来"' } }] });
    check('整段被一对引号包起来时去掉', wrapped.lines[0] === '整段被包起来', wrapped.lines);
}
{
    const { out } = await runOcr({ endpoint: 'bigmodel', apiKey: 'k', model: 'glm-4.6v', thinking: 'enabled' }, { choices: [{ message: { content: '', reasoning_content: 'Let me think...' } }] });
    check('content 为空时不把思考过程当结果', out.error && out.error.type === 'api', out);
}
{
    const { out } = await runOcr({ endpoint: 'custom', apiKey: 'k', model: 'm' }, CHAT_OK);
    check('选了自定义却没填地址时提示去填地址', out.error && out.error.message.includes('自定义接口地址'), out.error);
}
{
    const captured = [];
    const o = load(OCR_SCRIPT, { endpoint: 'deepseek', apiKey: 'k' }, makeHttp(CHAT_OK, captured));
    await new Promise((resolve) => o.ocr({ image: { toBase64: () => '/9j/4AAQSkZJRg==' }, detectFrom: 'en', onCompletion: resolve }, null));
    check('JPEG 图片用 image/jpeg', captured[0].body.messages[0].content[0].image_url.url.startsWith('data:image/jpeg;base64,'), captured[0].body.messages[0].content[0].image_url.url.slice(0, 30));
}
{
    const { req, lines } = await runOcr({ endpoint: 'bigmodel', apiKey: 'k', model: 'glm-5.3-flash' }, CHAT_OK);
    const content = req.body.messages[0].content;
    check('智谱中国站 chat URL', req.url === 'https://open.bigmodel.cn/api/paas/v4/chat/completions', req.url);
    check('消息角色为 user（DeepSeek 要求）', req.body.messages[0].role === 'user');
    check('智谱官方接口发纯 base64', content[0].image_url.url === PNG_B64, content[0].image_url.url.slice(0, 30));
    check('默认提示词禁止翻译并含 Free OCR.', content[1].text.includes('Free OCR.') && content[1].text.includes('Do NOT translate'), content[1].text);
    check('temperature 0.1', req.body.temperature === 0.1, req.body.temperature);
    check('GLM 默认关闭 thinking', req.body.thinking && req.body.thinking.type === 'disabled', req.body.thinking);
    check('识别结果按行拆分为 texts', JSON.stringify(lines) === JSON.stringify(['第一行', '第二行']), lines);
}
{
    const { req } = await runOcr({ endpoint: 'bigmodel_coding', apiKey: 'k' }, CHAT_OK);
    check('智谱中国站 Coding Plan URL', req.url === 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', req.url);
    check('Coding Plan 默认 glm-5.3-flash + 纯 base64', req.body.model === 'glm-5.3-flash' && req.body.messages[0].content[0].image_url.url === PNG_B64, req.body.model);
}
{
    const { req } = await runOcr({ endpoint: 'zai_coding', apiKey: 'k' }, CHAT_OK);
    check('Z.ai Coding Plan URL', req.url === 'https://api.z.ai/api/coding/paas/v4/chat/completions', req.url);
}
{
    const { req } = await runOcr({ endpoint: 'deepseek', apiKey: 'sk-ds' }, CHAT_OK);
    check('DeepSeek URL + 默认视觉模型 deepseek-flash', req.url === 'https://api.deepseek.com/chat/completions' && req.body.model === 'deepseek-flash', req.url);
    check('DeepSeek 图片为 data URL', req.body.messages[0].content[0].image_url.url === DATA_URL);
    check('DeepSeek 不发送 thinking', !('thinking' in req.body));
}
{
    const { req } = await runOcr({ endpoint: 'zen', apiKey: 'sk-oc' }, CHAT_OK);
    check('OpenCode Zen URL + 默认 glm-5.3-flash', req.url === 'https://opencode.ai/zen/v1/chat/completions' && req.body.model === 'glm-5.3-flash', req.url);
    check('非智谱接口上的 GLM 仍发 data URL', req.body.messages[0].content[0].image_url.url === DATA_URL);
    check('Zen GLM 默认关闭 thinking', req.body.thinking && req.body.thinking.type === 'disabled', req.body.thinking);
}
{
    const { req } = await runOcr({ endpoint: 'go', apiKey: 'sk-go' }, CHAT_OK);
    check('OpenCode Go URL + 默认 deepseek-v4.1-flash', req.url === 'https://opencode.ai/zen/go/v1/chat/completions' && req.body.model === 'deepseek-v4.1-flash', req.url);
    check('Go DeepSeek 视觉模型不发送 thinking', !('thinking' in req.body));
}
{
    const { req } = await runOcr({ endpoint: 'bigmodel', apiKey: 'k', model: 'glm-4.6v-flash', thinking: 'enabled' }, CHAT_OK);
    check('thinking 开启生效', req.body.thinking.type === 'enabled', req.body.thinking);
}
{
    const { req } = await runOcr({ endpoint: 'bigmodel', apiKey: 'k', model: 'glm-4.6v-flash', thinking: 'auto' }, CHAT_OK);
    check('thinking=auto 不发送参数', !('thinking' in req.body));
}
{
    const { req } = await runOcr({ endpoint: 'bigmodel', apiKey: 'k', model: 'glm-5.3-flash', ocrPrompt: '只输出数字' }, CHAT_OK);
    check('自定义提示词生效', req.body.messages[0].content[1].text === '只输出数字', req.body.messages[0].content[1].text);
}
{
    // 场景：模型自作主张附加 OCR Result/Translation 标签 → 清洗
    const { lines } = await runOcr({ endpoint: 'deepseek', apiKey: 'sk-ds' }, { choices: [{ message: { content: `**OCR Result:** 夜深啦,别忘了照顾好自己哦\n**Translation:** "It's late at night, don't forget to take good care of yourself~` } }] });
    check('清洗掉模型附加的标签与翻译', JSON.stringify(lines) === JSON.stringify(['夜深啦,别忘了照顾好自己哦']), lines);
}

console.log('== ocr：错误处理 ==');
{
    const { out } = await runOcr({ endpoint: 'custom', customEndpoint: 'http://127.0.0.1:8080/v1' }, CHAT_OK);
    check('自定义接口必须填模型名', out.error && out.error.type === 'param' && out.error.message.includes('模型名称'), out.error);
}
{
    const { out } = await runOcr({ endpoint: 'bigmodel' }, CHAT_OK);
    check('缺 API Key 报 secretKey', out.error && out.error.type === 'secretKey', out.error);
}
{
    const { out } = await runOcr({ endpoint: 'bigmodel', apiKey: 'k' }, { error: { message: 'invalid key' } }, 401);
    check('HTTP 401 报 network 并带地址', out.error && out.error.type === 'network' && out.error.message.includes('401') && out.error.message.includes('layout_parsing'), out.error);
}
{
    const body = { error: { message: "messages.content.type 参数非法，取值范围 ['text']", code: '1210' } };
    const { out } = await runOcr({ endpoint: 'bigmodel', apiKey: 'k', model: 'glm-5.3' }, body, 400);
    check('纯文本模型给出换视觉模型提示', out.error && out.error.message.includes('不支持图片输入') && out.error.message.includes('模型 glm-5.3'), out.error);
}

// ======================================================================
// 语音合成插件 tts/
// ======================================================================
const TTS_SCRIPT = read('tts/main.js');
const TTS_INFO = JSON.parse(read('tts/info.json'));

// 模拟 Bob 的 $data：subData 不含 end，appendData / writeUInt8 原地修改
function fakeData(bytes) {
    return {
        buf: Buffer.from(bytes),
        get length() { return this.buf.length; },
        readUInt8(i) { return i >= 0 && i < this.buf.length ? this.buf[i] : 0; },
        writeUInt8(v, i) { this.buf[i] = v; },
        subData(s, e) { return fakeData(this.buf.subarray(s, e)); },
        appendData(d) { this.buf = Buffer.concat([this.buf, d.buf]); },
        toBase64() { return this.buf.toString('base64'); },
        toUTF8() { return this.buf.toString('utf8'); }
    };
}

// 构造 24kHz/16bit/单声道 WAV；withList=true 时在 data 前插一个 LIST 段，验证按段扫描
function makeWav(pcm, withList) {
    const fmt = Buffer.alloc(24);
    fmt.write('fmt ', 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10);
    fmt.writeUInt32LE(24000, 12); fmt.writeUInt32LE(48000, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22);
    const list = withList ? Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO')]) : Buffer.alloc(0);
    const dataHead = Buffer.alloc(8);
    dataHead.write('data', 0); dataHead.writeUInt32LE(pcm.length, 4);
    const body = Buffer.concat([Buffer.from('WAVE'), fmt, list, dataHead, pcm]);
    const riff = Buffer.alloc(8);
    riff.write('RIFF', 0); riff.writeUInt32LE(body.length, 4);
    return Buffer.concat([riff, body]);
}

function ttsHttp(responder, captured) {
    return {
        request: (options) => {
            captured.push(options);
            const resp = responder(options, captured.length);
            setTimeout(() => options.handler(resp), 0);
        }
    };
}

const wavResp = (buf) => ({ response: { statusCode: 200 }, rawData: fakeData(buf), data: null });

async function runTts($option, text, responder) {
    const captured = [];
    const t = load(TTS_SCRIPT, $option, ttsHttp(responder, captured));
    const out = await new Promise((resolve) => t.tts({ text, lang: 'zh-Hans' }, resolve));
    return { captured, out, t };
}

console.log('== tts：配置 ==');
{
    const t = load(TTS_SCRIPT, {}, {});
    check('tts 入口函数已挂载到 exports', ['tts', 'supportLanguages', 'pluginTimeoutInterval', 'pluginValidate'].every((k) => typeof t[k] === 'function'), Object.keys(t));
    check('identifier / category', TTS_INFO.identifier === 'com.www011215.bob.glm-tts' && TTS_INFO.category === 'tts', TTS_INFO.identifier);
    const voices = TTS_INFO.options.find((o) => o.identifier === 'voice').menuValues.map((m) => m.value);
    check('音色菜单 = 官方 7 个系统音色', JSON.stringify(voices.slice().sort()) === JSON.stringify(['chuichui', 'douji', 'jam', 'kazi', 'luodo', 'tongtong', 'xiaochen']), voices);
    check('默认只读中文（英文交给其他语音服务）', JSON.stringify(t.supportLanguages()) === JSON.stringify(['zh-Hans', 'zh-Hant']), t.supportLanguages());
    const zhEn = load(TTS_SCRIPT, { languages: 'zh_en' }, {});
    check('选「中英混读」时声明 en', zhEn.supportLanguages().includes('en'), zhEn.supportLanguages());
    const langOpt = TTS_INFO.options.find((o) => o.identifier === 'languages');
    check('朗读语言菜单默认值 = 第一项 = zh', langOpt.defaultValue === 'zh' && langOpt.menuValues[0].value === 'zh', langOpt.defaultValue);
}

console.log('== tts：合成 ==');
{
    const wav = makeWav(Buffer.from([1, 2, 3, 4]), false);
    const { captured, out } = await runTts({ apiKey: 'sk-tts' }, '你好，世界', () => wavResp(wav));
    const req = captured[0];
    check('请求 audio/speech', req.url === 'https://open.bigmodel.cn/api/paas/v4/audio/speech' && req.method === 'POST', req.url);
    check('Bearer 认证头', req.header.Authorization === 'Bearer sk-tts');
    check('默认参数 glm-tts / tongtong / wav / 1.0 / 1.0', JSON.stringify(req.body) === JSON.stringify({ model: 'glm-tts', input: '你好，世界', voice: 'tongtong', response_format: 'wav', speed: 1, volume: 1 }), req.body);
    check('返回 base64 WAV', out.result && out.result.type === 'base64' && out.result.value === wav.toString('base64'), out);
    check('raw 记录段数', out.result.raw.chunks === 1, out.result.raw);
}
{
    const wav = makeWav(Buffer.from([1, 2]), false);
    const { captured } = await runTts({ apiKey: 'k', voice: 'xiaochen', customVoice: ' my-clone ', speed: '1.25', volume: '3.0' }, 'x', () => wavResp(wav));
    const b = captured[0].body;
    check('自定义音色优先 + 语速 / 音量生效', b.voice === 'my-clone' && b.speed === 1.25 && b.volume === 3, b);
}
{
    const { captured } = await runTts({ apiKey: 'k', speed: '9', volume: '0' }, 'x', () => wavResp(makeWav(Buffer.from([0, 0]), false)));
    check('语速 / 音量越界被夹到合法范围', captured[0].body.speed === 2 && captured[0].body.volume === 0.1, captured[0].body);
}
{
    // 场景：1500 字长文 → 按句切成两段，拼成一个 WAV
    const sentence = '这是一个用于测试分段朗读的句子，长度大约三十个字符左右。';
    const text = sentence.repeat(Math.ceil(1500 / sentence.length));
    const pcm1 = Buffer.from([10, 11, 12, 13]);
    const pcm2 = Buffer.from([20, 21]);
    const { captured, out } = await runTts({ apiKey: 'k' }, text, (o, n) => wavResp(makeWav(n === 1 ? pcm1 : pcm2, true)));
    check('长文切成多段请求', captured.length === 2, captured.length);
    check('每段不超过 1024 字', captured.every((r) => r.body.input.length <= 1024), captured.map((r) => r.body.input.length));
    check('切分点落在句末', captured[0].body.input.endsWith('。'), captured[0].body.input.slice(-5));
    check('切分不丢字', captured.map((r) => r.body.input).join('') === text);
    const merged = Buffer.from(out.result.value, 'base64');
    const expected = makeWav(Buffer.concat([pcm1, pcm2]), true);
    check('多段 WAV 拼接（含 LIST 段）且长度字段正确', merged.equals(expected), merged.toString('hex'));
    check('raw 记录段数', out.result.raw.chunks === 2, out.result.raw);
}
{
    // 场景：没有标点的超长文本 → 硬切，且不切开 emoji 代理对
    const text = 'a'.repeat(1023) + '😀' + 'b'.repeat(10);
    const { captured } = await runTts({ apiKey: 'k' }, text, () => wavResp(makeWav(Buffer.from([0, 0]), false)));
    check('硬切不拆代理对', captured[0].body.input === 'a'.repeat(1023) && captured[1].body.input.startsWith('😀'), captured.map((r) => r.body.input.length));
}

{
    // 场景：接口返回流式头（RIFF / data 长度字段为 0）的单段 WAV → 修正长度字段
    const good = makeWav(Buffer.from([1, 2, 3, 4]), false);
    const streamed = Buffer.from(good);
    streamed.writeUInt32LE(0, 4);
    streamed.writeUInt32LE(0, 40);
    const { out } = await runTts({ apiKey: 'k' }, '你好', () => wavResp(streamed));
    check('单段流式头被修正为合法 WAV', Buffer.from(out.result.value, 'base64').equals(good), Buffer.from(out.result.value, 'base64').subarray(0, 44).toString('hex'));
}
{
    const { captured } = await runTts({ apiKey: 'k', watermark: 'off' }, 'x', () => wavResp(makeWav(Buffer.from([0, 0]), false)));
    check('关闭水印时发送 watermark_enabled=false', captured[0].body.watermark_enabled === false, captured[0].body);
    const def = await runTts({ apiKey: 'k' }, 'x', () => wavResp(makeWav(Buffer.from([0, 0]), false)));
    check('默认不发送 watermark_enabled', !('watermark_enabled' in def.captured[0].body), def.captured[0].body);
}
{
    // 场景：窗口后半段没有任何断点、前半段有句号 → 在句号处切，而不是在 1024 处硬切
    const text = '前半句。' + '字'.repeat(1100);
    const { captured } = await runTts({ apiKey: 'k' }, text, () => wavResp(makeWav(Buffer.from([0, 0]), false)));
    check('后半段无断点时退回到最近的句号', captured[0].body.input === '前半句。', captured[0].body.input.slice(0, 10));
}

{
    // 场景：Bob 的 $data 只有 toBase64 可靠（readUInt8 / length 不按文档工作），data 被置成 {} → 仍能正常朗读
    const wav = makeWav(Buffer.from([7, 8, 9, 10]), false);
    const quirky = { toBase64: () => wav.toString('base64'), readUInt8: () => undefined };
    const { out } = await runTts({ apiKey: 'k' }, '你好', () => ({ response: { statusCode: 200, headers: { 'Content-Type': 'audio/wav' } }, data: {}, rawData: quirky }));
    check('只靠 toBase64 也能取到 WAV', out.result && out.result.value === wav.toString('base64'), out);
    const wrapped = { toBase64: () => wav.toString('base64').replace(/(.{8})/g, '$1\n') };
    const { out: out2 } = await runTts({ apiKey: 'k' }, '你好', () => ({ response: { statusCode: 200 }, data: {}, rawData: wrapped }));
    check('base64 带换行也能解析', out2.result && out2.result.value === wav.toString('base64'), out2);
}

console.log('== tts：错误处理 ==');
{
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
    const { out } = await runTts({ apiKey: 'k' }, '你好', () => ({ response: { statusCode: 200, headers: { 'content-type': 'audio/pcm' } }, data: {}, rawData: fakeData(pcm) }));
    check('返回非 WAV 二进制时报出类型 / 长度 / 开头字节', out.error && out.error.type === 'api' && out.error.message.includes('audio/pcm') && out.error.message.includes('8 字节') && out.error.message.includes('01 00 02 00'), out.error);
    const { out: o2 } = await runTts({ apiKey: 'k' }, '你好', () => ({ response: { statusCode: 200 }, data: {}, rawData: fakeData(Buffer.from('{}')) }));
    check('返回 {} 时报出原文', o2.error && o2.error.message.includes('2 字节') && o2.error.message.includes('{}'), o2.error);
    const { out: o3 } = await runTts({ apiKey: 'k' }, '你好', () => ({ response: { statusCode: 200 }, data: {} }));
    check('没有 rawData 时报「没有返回音频数据」', o3.error && o3.error.message.includes('没有返回音频数据'), o3.error);
}
{
    const { captured, out } = await runTts({ apiKey: 'k' }, '字'.repeat(3001), () => wavResp(makeWav(Buffer.from([0, 0]), false)));
    check('超过 3000 字直接提示、不发请求', out.error && out.error.type === 'param' && out.error.message.includes('3000') && captured.length === 0, out.error);
}
{
    for (const $option of [undefined, null]) {
        const t = load(TTS_SCRIPT, $option, {});
        let langs = null;
        try { langs = t.supportLanguages(); } catch (e) { langs = String(e); }
        check('$option 为 ' + $option + ' 时 supportLanguages 不抛错', Array.isArray(langs) && langs.length === 2, langs);
    }
}
{
    const { out } = await runTts({ apiKey: 'k' }, '你好', () => ({ response: { statusCode: 502 } }));
    check('空响应体提示「响应无内容」而不是 undefined', out.error && out.error.message.includes('响应无内容') && !out.error.message.includes('undefined'), out.error);
}
{
    const { out } = await runTts({}, '你好', () => wavResp(makeWav(Buffer.from([0, 0]), false)));
    check('缺 API Key 报 secretKey', out.error && out.error.type === 'secretKey', out.error);
}
{
    const { out } = await runTts({ apiKey: 'k' }, '   ', () => wavResp(makeWav(Buffer.from([0, 0]), false)));
    check('空文本报 param', out.error && out.error.type === 'param', out.error);
}
{
    const { out } = await runTts({ apiKey: 'k' }, '你好', () => ({ response: { statusCode: 401 }, data: { error: { message: 'invalid key' } } }));
    check('HTTP 401 报 secretKey', out.error && out.error.type === 'secretKey' && out.error.message.includes('invalid key'), out.error);
}
{
    const body = '{"error":{"code":"1214","message":"input 超长"}}';
    const { out } = await runTts({ apiKey: 'k' }, '你好', () => ({ response: { statusCode: 400 }, data: null, rawData: fakeData(Buffer.from(body)) }));
    check('HTTP 400 报 network 并带服务端信息', out.error && out.error.type === 'network' && out.error.message.includes('400') && out.error.message.includes('1214'), out.error);
}
{
    const { out } = await runTts({ apiKey: 'k' }, '你好', () => ({ response: { statusCode: 200 }, data: { msg: 'oops' }, rawData: fakeData(Buffer.from('{"msg":"oops"}')) }));
    check('200 但不是 WAV 报 api', out.error && out.error.type === 'api' && out.error.message.includes('oops'), out.error);
}
{
    const sentence = '第二段失败的测试句子。';
    const text = sentence.repeat(Math.ceil(1500 / sentence.length));
    const { out } = await runTts({ apiKey: 'k' }, text, (o, n) => (n === 1 ? wavResp(makeWav(Buffer.from([0, 0]), false)) : { response: { statusCode: 500 }, data: { error: 'busy' } }));
    check('分段失败时注明第几段', out.error && out.error.message.includes('第 2 / 2 段'), out.error);
}
{
    const captured = [];
    const t = load(TTS_SCRIPT, { apiKey: 'k' }, ttsHttp(() => wavResp(makeWav(Buffer.from([0, 0]), false)), captured));
    const ok = await new Promise((resolve) => t.pluginValidate(resolve));
    check('pluginValidate 成功', ok.result === true && captured[0].body.input === '你好', ok);
    const t2 = load(TTS_SCRIPT, { apiKey: 'bad' }, ttsHttp(() => ({ response: { statusCode: 401 }, data: { error: 'no' } }), []));
    const bad = await new Promise((resolve) => t2.pluginValidate(resolve));
    check('pluginValidate 失败带错误', bad.result === false && bad.error && bad.error.type === 'secretKey', bad);
}

// ======================================================================
// 翻译插件 translate/
// ======================================================================
const TR_SCRIPT = read('translate/main.js');
const TR_INFO = JSON.parse(read('translate/info.json'));

const sse = (deltas) => deltas.map((d) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: d } }] }) + '\n\n').join('') + 'data: [DONE]\n\n';

// streamRequest 模拟：整段响应按 7 个字符切块喂给 streamHandler，故意切在行中间
function trHttp({ stream = '', status = 200, json, capture }) {
    return {
        request: (o) => {
            capture.push(o);
            const resp = { response: { statusCode: status }, data: json };
            if (o.handler) {
                setTimeout(() => o.handler(resp), 0);
                return undefined;
            }
            return Promise.resolve(resp);
        },
        streamRequest: (o) => {
            capture.push(o);
            setTimeout(() => {
                for (let i = 0; i < stream.length; i += 7) o.streamHandler({ text: stream.slice(i, i + 7) });
                o.handler({ response: { statusCode: status } });
            }, 0);
        }
    };
}

async function runTr($option, query, httpOpts) {
    const capture = [];
    const t = load(TR_SCRIPT, $option, trHttp({ ...httpOpts, capture }));
    const streamed = [];
    const out = await new Promise((resolve) => t.translate({ ...query, onStream: (r) => streamed.push(r), onCompletion: resolve }, null));
    return { out, streamed, capture };
}

const EN_ZH = { text: 'Hello, world. This is a test.', detectFrom: 'en', detectTo: 'zh-Hans', cancelSignal: 'SIG' };
const DICT_JSON = '```json\n' + JSON.stringify({
    word: 'ubiquitous', phonetics: { us: '/juːˈbɪkwɪtəs/', uk: '/juːˈbɪkwɪtəs/' },
    parts: [{ part: 'adj.', means: ['无处不在的', '普遍存在的'] }],
    examples: ['Smartphones are ubiquitous.'], roots: 'ubique（拉丁语：到处）+ -ous', forms: [{ name: 'noun', words: ['ubiquity'] }], synonyms: ['omnipresent']
}) + '\n```';

console.log('== translate：配置 ==');
{
    const t = load(TR_SCRIPT, {}, {});
    const consts = new Function('$option, $http, exports', TR_SCRIPT + '\nreturn { ENDPOINTS, DEFAULT_ENDPOINT, DEFAULT_MODELS };')({}, {}, {});
    const opt = (id) => TR_INFO.options.find((o) => o.identifier === id);
    check('translate 入口函数已挂载', ['translate', 'supportLanguages', 'pluginValidate', 'pluginTimeoutInterval'].every((k) => typeof t[k] === 'function'));
    check('identifier / category', TR_INFO.identifier === 'com.www011215.bob.glm-translate' && TR_INFO.category === 'translate');
    check('接口菜单默认值 = 第一项 = 代码默认', opt('endpoint').defaultValue === opt('endpoint').menuValues[0].value && opt('endpoint').defaultValue === consts.DEFAULT_ENDPOINT);
    check('每个预设接口都有默认模型', Object.keys(consts.ENDPOINTS).every((k) => consts.DEFAULT_MODELS[k]));
    check('模式默认「翻译」且为第一项', opt('mode').defaultValue === 'translate' && opt('mode').menuValues[0].value === 'translate');
    const langs = t.supportLanguages();
    check('supportLanguages 含 auto / zh-Hans / en', langs.includes('auto') && langs.includes('zh-Hans') && langs.includes('en'), langs.slice(0, 5));
}

console.log('== translate：流式翻译 ==');
{
    const { out, streamed, capture } = await runTr({ apiKey: 'k' }, EN_ZH, { stream: sse(['你好', '，世界。', '这是测试。']) });
    const req = capture[0];
    check('走 streamRequest + 智谱中国站', req.url === 'https://open.bigmodel.cn/api/paas/v4/chat/completions' && capture.length === 1, req.url);
    check('默认免费 glm-4.7-flash、关思考、流式', req.body.model === 'glm-4.7-flash' && req.body.stream === true && req.body.thinking.type === 'disabled', req.body);
    check('提示词含源语言与目标语言', req.body.messages[0].content.includes('from English into Simplified Chinese') && req.body.messages[1].content === EN_ZH.text, req.body.messages[0].content);
    check('cancelSignal 透传', req.cancelSignal === 'SIG');
    check('流式回调累计译文', streamed.length === 3 && streamed[2].result.toParagraphs[0] === '你好，世界。这是测试。', streamed.map((s) => s.result.toParagraphs[0]));
    check('最终结果 plain 格式', out.result.content.format === 'plain' && out.result.content.text === '你好，世界。这是测试。' && out.result.to === 'zh-Hans', out.result);
}
{
    const { capture } = await runTr({ apiKey: 'k', style: 'academic' }, EN_ZH, { stream: sse(['x']) });
    check('学术 / 医学风格追加术语要求', capture[0].body.messages[0].content.includes('standard terminology'), capture[0].body.messages[0].content);
}
{
    const { out, capture } = await runTr({ apiKey: 'k', mode: 'explain' }, EN_ZH, { stream: sse(['**Simple English**\n', 'Hi.']) });
    check('英英释义：英文系统提示 + 原文放进 <<< >>>', capture[0].body.messages[0].content.includes('English-to-English') && capture[0].body.messages[1].content.includes('<<<\n' + EN_ZH.text + '\n>>>'));
    check('英英释义：输出 markdown、目标语言为 en', out.result.content.format === 'markdown' && out.result.to === 'en', out.result);
}
{
    const { capture } = await runTr({ apiKey: 'k', mode: 'custom', systemPrompt: 'Translate into $targetLang.', userPrompt: 'Rewrite: $query.text' }, EN_ZH, { stream: sse(['x']) });
    check('自定义 Prompt 占位符替换', capture[0].body.messages[0].content === 'Translate into Simplified Chinese.' && capture[0].body.messages[1].content === 'Rewrite: ' + EN_ZH.text, capture[0].body.messages);
    const noPh = await runTr({ apiKey: 'k', mode: 'custom', userPrompt: 'Rewrite this in simple English.' }, EN_ZH, { stream: sse(['x']) });
    check('用户指令没写占位符时自动接上原文', noPh.capture[0].body.messages[0].content === 'Rewrite this in simple English.\n\n' + EN_ZH.text, noPh.capture[0].body.messages);
}

console.log('== translate：单词词典卡片 ==');
{
    const { out, capture } = await runTr({ apiKey: 'k' }, { text: 'ubiquitous', detectFrom: 'en', detectTo: 'zh-Hans' }, { json: { choices: [{ message: { content: DICT_JSON } }] } });
    const d = out.result && out.result.toDict;
    check('英文单词走词典卡片（非流式）', capture.length === 1 && !capture[0].body.stream && capture[0].body.messages[0].content.includes('Simplified Chinese'), capture.map((c) => c.body.stream));
    check('音标去掉斜杠、分 us / uk', d && d.phonetics.length === 2 && d.phonetics[0].type === 'us' && d.phonetics[0].value === 'juːˈbɪkwɪtəs', d && d.phonetics);
    check('词性释义 / 词形 / 附加信息（中文标签）', d && d.parts[0].part === 'adj.' && d.parts[0].means.length === 2 && d.exchanges[0].words[0] === 'ubiquity' && d.additions.map((a) => a.name).join() === '例句,词根词缀,近义词', d);
    check('toParagraphs 给出释义摘要', out.result.toParagraphs[0] === 'adj. 无处不在的; 普遍存在的', out.result.toParagraphs);
}
{
    const { out, capture } = await runTr({ apiKey: 'k', mode: 'explain' }, { text: 'ubiquitous', detectFrom: 'en', detectTo: 'zh-Hans' }, { json: { choices: [{ message: { content: DICT_JSON } }] } });
    check('英英释义查词：简明英文 + 英文标签', capture[0].body.messages[0].content.includes('simple English') && out.result.toDict.additions[0].name === 'Examples' && out.result.to === 'en', out.result.toDict.additions);
}
{
    const { out, capture } = await runTr({ apiKey: 'k' }, { text: 'ubiquitous', detectFrom: 'en', detectTo: 'zh-Hans' }, { json: { choices: [{ message: { content: 'not json' } }] }, stream: sse(['无处不在的']) });
    check('词典 JSON 解析失败时退回普通翻译', capture.length === 2 && capture[1].body.stream === true && out.result.toParagraphs[0] === '无处不在的', out.result);
}
{
    const off = await runTr({ apiKey: 'k', wordCard: 'off' }, { text: 'ubiquitous', detectFrom: 'en', detectTo: 'zh-Hans' }, { stream: sse(['无处不在的']) });
    check('关闭词典卡片时直接翻译', off.capture.length === 1 && off.capture[0].body.stream === true);
    const zh = await runTr({ apiKey: 'k' }, { text: '苹果', detectFrom: 'zh-Hans', detectTo: 'en' }, { stream: sse(['apple']) });
    check('非英文单词不走词典卡片', zh.capture.length === 1 && zh.capture[0].body.stream === true);
}

console.log('== translate：英英释义 + 中文翻译 ==');
{
    const { out, capture } = await runTr({ apiKey: 'k', mode: 'explain_trans' }, EN_ZH, { stream: sse(['**Simple English**\nHi.\n\n', '**中文翻译**\n你好。']) });
    const [sys, user] = capture[0].body.messages;
    check('整合版：系统提示要求英英 + 译成简体中文', sys.content.includes('simple, clear English') && sys.content.includes('into Simplified Chinese'), sys.content);
    check('整合版：输出格式里英英在上、「中文翻译」在下', user.content.indexOf('**Simple English**') < user.content.indexOf('**中文翻译**') && user.content.includes('<<<\n' + EN_ZH.text + '\n>>>'), user.content);
    check('整合版：Markdown、流式', out.result.content.format === 'markdown' && capture[0].body.stream === true && out.result.content.text.endsWith('你好。'), out.result);
    const hant = await runTr({ apiKey: 'k', mode: 'explain_trans' }, { ...EN_ZH, detectTo: 'zh-Hant' }, { stream: sse(['x']) });
    check('目标繁体时标题为「中文翻譯」', hant.capture[0].body.messages[1].content.includes('**中文翻譯**') && hant.capture[0].body.messages[0].content.includes('Traditional Chinese'));
    const toEn = await runTr({ apiKey: 'k', mode: 'explain_trans' }, { ...EN_ZH, detectTo: 'en' }, { stream: sse(['x']) });
    check('目标是英文时译文退回简体中文', toEn.capture[0].body.messages[1].content.includes('**中文翻译**'));
}
{
    const BI_JSON = JSON.stringify({
        word: 'ubiquitous', phonetics: { us: 'juːˈbɪkwɪtəs' }, parts: [{ part: 'adj.', means: ['found almost everywhere'] }],
        translation: [{ part: 'adj.', means: ['无处不在的', '普遍存在的'] }], examples: ['Phones are ubiquitous.'], roots: 'ubique + -ous', forms: [], synonyms: []
    });
    const { out, capture } = await runTr({ apiKey: 'k', mode: 'explain_trans' }, { text: 'ubiquitous', detectFrom: 'en', detectTo: 'zh-Hans' }, { json: { choices: [{ message: { content: BI_JSON } }] } });
    const prompt = capture[0].body.messages[0].content;
    const d = out.result.toDict;
    check('整合版查词：要求英文释义 + translation 字段（简体中文）', prompt.includes('in simple English') && prompt.includes('"translation"') && prompt.includes('in Simplified Chinese'), prompt);
    check('整合版查词：英文释义在 parts、中文释义紧跟其后', d.parts[0].means[0] === 'found almost everywhere' && d.additions[0].name === '中文释义' && d.additions[0].value === 'adj. 无处不在的；普遍存在的', d.additions);
    check('整合版查词：其余附加信息用中文标签', d.additions.map((a) => a.name).join() === '中文释义,例句,词根词缀', d.additions.map((a) => a.name));
    const plain = await runTr({ apiKey: 'k', mode: 'explain' }, { text: 'ubiquitous', detectFrom: 'en', detectTo: 'zh-Hans' }, { json: { choices: [{ message: { content: BI_JSON } }] } });
    const p2 = plain.capture[0].body.messages[0].content;
    check('纯英英查词不要 translation、占位符都已替换', !p2.includes('"translation"') && !/\{(extraShape|extraRule|meaning|text|target)\}/.test(p2) && !plain.out.result.toDict.additions.some((a) => a.name === '中文释义'), p2);
}

console.log('== translate：错误处理 ==');
{
    const { out } = await runTr({ apiKey: 'bad' }, EN_ZH, { status: 401, stream: '{"error":{"code":"1001","message":"Header中未收到Authorization参数"}}' });
    check('401 报 secretKey 并带服务端信息', out.error && out.error.type === 'secretKey' && out.error.message.includes('[1001]'), out.error);
}
{
    const { out } = await runTr({ apiKey: 'k' }, EN_ZH, { stream: 'data: {"error":{"message":"rate limit"}}\n\n' });
    check('流中途返回错误事件', out.error && out.error.type === 'api' && out.error.message.includes('rate limit'), out.error);
}
{
    const { out } = await runTr({ apiKey: 'k' }, EN_ZH, { stream: 'data: [DONE]\n\n' });
    check('没有译文时报错', out.error && out.error.message.includes('未返回译文'), out.error);
}
{
    const { out } = await runTr({}, EN_ZH, { stream: sse(['x']) });
    check('缺 API Key 报 secretKey', out.error && out.error.type === 'secretKey', out.error);
    const c = await runTr({ endpoint: 'custom', apiKey: 'k', model: 'm' }, EN_ZH, { stream: sse(['x']) });
    check('选了自定义却没填地址', c.out.error && c.out.error.message.includes('自定义接口地址'), c.out.error);
}
{
    const capture = [];
    const t = load(TR_SCRIPT, { apiKey: 'k' }, trHttp({ capture, json: { choices: [] } }));
    const ok = await new Promise((resolve) => t.pluginValidate(resolve));
    check('pluginValidate 成功', ok.result === true && capture[0].body.max_tokens === 8 && capture[0].body.stream === false, ok);
    const t2 = load(TR_SCRIPT, { apiKey: 'bad' }, trHttp({ capture: [], status: 401, json: { error: { code: '1000', message: '身份验证失败' } } }));
    const bad = await new Promise((resolve) => t2.pluginValidate(resolve));
    check('pluginValidate 失败带错误', bad.result === false && bad.error.type === 'secretKey' && bad.error.message.includes('身份验证失败'), bad);
}

console.log('\n结果: ' + passed + ' 通过, ' + failures + ' 失败');
process.exit(failures > 0 ? 1 : 0);
