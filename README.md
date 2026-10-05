# 楽譜ビューア

ソロギターアレンジの出力（MusicXML。ギターの TAB つき）を、iPad の Safari で見て聴くための静的な Web アプリです。
楽譜はブラウザの中で読むだけで、外へは送りません。

**いまは「音の確認」の段階です。** 試験用の楽譜（`samples/aura_lea_jazz.musicxml`）を1本読み、再生ボタン1つで鳴らします。

## 使い方（音の確認）

1. GitHub Pages の URL を iPad の Safari で開く
2. 「準備ができました」と出たら「再生」を押す（もう一度押すと止まる）
3. 音が出ないときは、消音と音量を確かめてから、ページの中の「別の鳴らし方で試すページ」（URL の末尾が `?out=sp`）も試す

## 手元で動かす

```sh
npm install
npm test          # Node のテスト
npm run serve     # http://localhost:8080/ で開く
```

## 中身

- `index.html`・`src/` … アプリ
- `src/prepare.js` … alphaTab に渡す前に MusicXML を整える層（いまは「2段目の TAB の段に重ねて書かれた音を外す」だけ）
- `vendor/alphatab/` … alphaTab 1.8.4（MPL-2.0）。フォント Bravura（SIL OFL）と音源 sonivox（Apache-2.0）も同梱。入れ直すときは `scripts/vendor-alphatab.sh`
- `samples/` … 動作テスト用の楽譜（著作権の切れた曲）
- `test/` … Node のテスト
- `.github/workflows/pages.yml` … main に push するたびにテストして Pages に出す

## 分かっている不具合

- （音の確認の後に書き足します）
