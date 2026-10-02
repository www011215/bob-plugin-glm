#!/bin/bash
# 一键安装智谱 GLM 的 Bob 插件：从 appcast 读取最新版本，下载并校验 sha256 后交给 Bob 安装
# 用法：curl -fsSL https://raw.githubusercontent.com/www011215/bob-plugin-glm/main/install.sh | bash -s -- [ocr|tts|translate|all]
set -euo pipefail

RAW="https://raw.githubusercontent.com/www011215/bob-plugin-glm/main"
TARGET="${1:-ocr}"

case "$TARGET" in
    ocr) PLUGINS="ocr" ;;
    tts) PLUGINS="tts" ;;
    translate) PLUGINS="translate" ;;
    all) PLUGINS="ocr translate tts" ;;
    *) echo "用法: install.sh [ocr|tts|translate|all]（默认 ocr）" >&2; exit 1 ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for plugin in $PLUGINS; do
    if [ "$plugin" = "ocr" ]; then cast_url="$RAW/appcast.json"; else cast_url="$RAW/$plugin/appcast.json"; fi
    curl -fsSL "$cast_url" -o "$TMP/$plugin.json"
    url="$(plutil -extract versions.0.url raw -o - "$TMP/$plugin.json")"
    sha="$(plutil -extract versions.0.sha256 raw -o - "$TMP/$plugin.json")"
    version="$(plutil -extract versions.0.version raw -o - "$TMP/$plugin.json")"
    # 下载到持久位置：Bob 安装确认框弹出时文件必须还在
    dest="$HOME/Downloads/$(basename "$url")"
    echo "下载 $plugin v$version → $dest"
    curl -fsSL "$url" -o "$dest"
    actual="$(shasum -a 256 "$dest" | awk '{print $1}')"
    if [ "$actual" != "$sha" ]; then
        echo "sha256 校验失败：$actual != $sha" >&2
        exit 1
    fi
    if [ "${DRY_RUN:-0}" = "1" ]; then
        echo "sha256 校验通过（DRY_RUN，不打开安装）"
    else
        open "$dest"
        echo "已打开 Bob 安装确认框，请在 Bob 里点「安装」"
    fi
done
