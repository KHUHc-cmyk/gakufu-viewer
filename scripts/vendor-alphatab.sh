#!/bin/sh
# alphaTab 1.8.4 を npm から取り、vendor/alphatab/ に入れ直す（ふだんは使わない。版を上げるときだけ）。
# 縮めた版（.min.mjs）を、中で読み合う名前（.mjs）に付け替えて置く。
set -eu
VER=1.8.4
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
npm pack "@coderline/alphatab@$VER" --silent --pack-destination "$TMP" >/dev/null
tar xzf "$TMP"/coderline-alphatab-$VER.tgz -C "$TMP"
D="$TMP/package/dist"
OUT=vendor/alphatab
rm -rf "$OUT"
mkdir -p "$OUT/font" "$OUT/soundfont"
cp "$D/alphaTab.min.mjs" "$OUT/alphaTab.mjs"
cp "$D/alphaTab.core.min.mjs" "$OUT/alphaTab.core.mjs"
cp "$D/alphaTab.worker.min.mjs" "$OUT/alphaTab.worker.mjs"
cp "$D/alphaTab.worklet.min.mjs" "$OUT/alphaTab.worklet.mjs"
cp "$D/font/Bravura.woff2" "$D/font/Bravura.woff" "$D/font/Bravura-OFL.txt" "$OUT/font/"
cp "$D/soundfont/sonivox.sf2" "$D/soundfont/LICENSE" "$D/soundfont/README.md" "$OUT/soundfont/"
cp "$TMP/package/LICENSE" "$OUT/LICENSE"
rm -rf "$TMP"
echo "vendor/alphatab を alphaTab $VER で入れ直しました"
