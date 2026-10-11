#!/bin/sh
# pdf.js（pdfjs-dist）6.3.289 を npm から取り、vendor/pdfjs/ に入れ直す（ふだんは使わない。版を上げるときだけ）。
# 古めの Safari でも動く版（legacy）の、縮めた版（.min.mjs）を .mjs の名前で置く。
# files.json は、オフライン用に保存するファイルの一覧（sw.js が読む）。
set -eu
VER=6.3.289
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
npm pack "pdfjs-dist@$VER" --silent --pack-destination "$TMP" >/dev/null
tar xzf "$TMP"/pdfjs-dist-$VER.tgz -C "$TMP"
D="$TMP/package"
OUT=vendor/pdfjs
rm -rf "$OUT"
mkdir -p "$OUT/wasm"
cp "$D/legacy/build/pdf.min.mjs" "$OUT/pdf.mjs"
cp "$D/legacy/build/pdf.worker.min.mjs" "$OUT/pdf.worker.mjs"
cp -r "$D/cmaps" "$D/standard_fonts" "$D/iccs" "$OUT/"
# quickjs-eval（PDF の中のスクリプト用）は使わないので入れない
for f in "$D"/wasm/*; do
  case "$(basename "$f")" in quickjs-eval*) ;; *) cp "$f" "$OUT/wasm/" ;; esac
done
cp "$D/LICENSE" "$OUT/LICENSE"
rm -rf "$TMP"
node scripts/list-pdfjs.js
echo "vendor/pdfjs を pdf.js $VER で入れ直しました"
