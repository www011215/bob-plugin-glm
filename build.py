#!/usr/bin/env python3
"""打包脚本：把 ocr/、tts/ 打成可安装的 .bobplugin，并维护各自的 appcast.json（Bob 插件更新源）

.bobplugin 本质是一个 zip，info.json / main.js / icon.png 必须位于压缩包根目录。
固定文件顺序、时间戳与权限且不压缩（文件很小），保证本地与 CI 打出的包逐字节一致，
appcast.json 里的 sha256 才能和 Release 附件对上。

两个插件各自发版，标签分别为 ocr-vX.Y.Z / tts-vX.Y.Z。

用法：
  python3 build.py                          打包全部插件，产物在 dist/
  python3 build.py ocr --appcast "说明"     打包 ocr 并把当前版本写进 ocr/appcast.json（发版前运行）
  python3 build.py --check                  CI 打标签时运行：按标签打包对应插件到 dist/release/ 并校验 appcast
"""
import hashlib
import json
import os
import sys
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = 'www011215/bob-plugin-glm'
PLUGINS = {'ocr': 'glm-ocr', 'tts': 'glm-tts'}  # 目录 → 产物名前缀
FILES = ['info.json', 'main.js', 'icon.png']


def load_info(plugin):
    with open(os.path.join(HERE, plugin, 'info.json'), encoding='utf-8') as f:
        return json.load(f)


def build(plugin, out_dir):
    info = load_info(plugin)
    os.makedirs(out_dir, exist_ok=True)
    name = '%s-%s.bobplugin' % (PLUGINS[plugin], info['version'])
    out = os.path.join(out_dir, name)
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_STORED) as z:
        for fn in FILES:
            zi = zipfile.ZipInfo(fn, date_time=(1980, 1, 1, 0, 0, 0))  # 压缩包内路径必须是根目录
            zi.create_system = 3
            zi.external_attr = 0o100644 << 16
            with open(os.path.join(HERE, plugin, fn), 'rb') as f:
                z.writestr(zi, f.read())
    with open(out, 'rb') as f:
        sha256 = hashlib.sha256(f.read()).hexdigest()
    print('打包完成: %s\n  sha256: %s' % (os.path.relpath(out, HERE), sha256))
    return info, name, sha256


def appcast_path(plugin):
    return os.path.join(HERE, plugin, 'appcast.json')


def load_appcast(plugin, info):
    path = appcast_path(plugin)
    if not os.path.exists(path):
        return {'identifier': info['identifier'], 'versions': []}
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def write_appcast(plugin, info, name, sha256, desc):
    cast = load_appcast(plugin, info)
    cast['identifier'] = info['identifier']
    tag = '%s-v%s' % (plugin, info['version'])
    entry = {
        'version': info['version'],
        'desc': desc,
        'sha256': sha256,
        'url': 'https://github.com/%s/releases/download/%s/%s' % (REPO, tag, name),
        'minBobVersion': info.get('minBobVersion', '0.5.0'),
        'timestamp': int(time.time() * 1000),
    }
    # 新版本放最前面（Bob 要求倒序）；同版本重复运行则覆盖
    cast['versions'] = [entry] + [v for v in cast.get('versions', []) if v.get('version') != info['version']]
    with open(appcast_path(plugin), 'w', encoding='utf-8') as f:
        json.dump(cast, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print('已写入 %s/appcast.json: v%s（发版标签 %s）' % (plugin, info['version'], tag))


def check():
    tag = os.environ.get('GITHUB_REF_NAME', '')
    plugin, _, version = tag.partition('-v')
    if plugin not in PLUGINS or not version:
        sys.exit('标签 %r 不是 ocr-vX.Y.Z / tts-vX.Y.Z 格式' % tag)
    info, name, sha256 = build(plugin, os.path.join(HERE, 'dist', 'release'))
    if version != info['version']:
        sys.exit('标签 %s 与 %s/info.json 的 version %s 不一致' % (tag, plugin, info['version']))
    cast = load_appcast(plugin, info)
    if cast.get('identifier') != info['identifier']:
        sys.exit('%s/appcast.json 的 identifier 与 info.json 不一致' % plugin)
    versions = cast.get('versions', [])
    if not versions or versions[0].get('version') != info['version']:
        sys.exit('%s/appcast.json 最新版本不是 %s：发版前先运行 python3 build.py %s --appcast "更新说明"' % (plugin, info['version'], plugin))
    if versions[0].get('sha256') != sha256:
        sys.exit('%s/appcast.json 的 sha256 与产物不一致：%s != %s' % (plugin, versions[0].get('sha256'), sha256))
    print('appcast 校验通过: %s' % tag)


def main():
    args = sys.argv[1:]
    if args[:1] == ['--check']:
        check()
        return
    targets = [a for a in args[:1] if a in PLUGINS] or list(PLUGINS)
    rest = args[1:] if args[:1] and args[0] in PLUGINS else args
    if rest[:1] == ['--appcast']:
        if len(targets) != 1 or len(rest) < 2 or not rest[1].strip():
            sys.exit('用法: python3 build.py <ocr|tts> --appcast "更新说明"')
    for plugin in targets:
        info, name, sha256 = build(plugin, os.path.join(HERE, 'dist'))
        if rest[:1] == ['--appcast']:
            write_appcast(plugin, info, name, sha256, rest[1].strip())


if __name__ == '__main__':
    main()
