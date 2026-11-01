# Marketplace2.24.0のデプロイ・切替

本書は配置・切替の手順です。2026-11-01時点でPolygonとBNBは配置・決済設定同期・Creator移行が完了し、両市場の新規受付は停止中です。本番切替は未実施です。現在の状態は [Polygon配置後の確認](POLYGON-STAGING.md) と [BNB配置後の確認](BNB-STAGING.md) を参照してください。

## 先に確認すること

- ローカルテスト、Creator確認台帳、旧世代の出品・資金・承認の整理を完了する。
- 現行v2.23.1とその前の市場を棚卸しする。Creatorが現在Ownerと同じという理由では登録しない。
- 旧市場に登録済みでも、新市場のoriginは運営が確認して明示登録する。旧Creatorを盲目的に自動取込みしない。
- 旧取引で後から販売が成立する場合も、初回販売済み状態が戻らないことを確認する。新契約はconstructorで指定した最大8市場を参照する。
- 新規取引の停止と既存取引の精算・取消し・返金を区別する。旧token無効化では既存取引は止まらない。

## ビルド・未署名実行票

```text
npm run build:contracts
node scripts/inventory.cjs --chain polygon --tokens 0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29
node scripts/inventory.cjs --chain bnb --tokens 0x36aaA2ef28afB12B3aDB6CE556A9dB6FC3a66F2D
node scripts/prepare-deployment.cjs --chain polygon --token 0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29
node scripts/prepare-deployment.cjs --chain bnb --token 0x36aaA2ef28afB12B3aDB6CE556A9dB6FC3a66F2D
```

inventoryは初期調査です。全履歴イベントからの全入札者・全登録トークンの列挙は行わないため、返金候補が0件でも全残務ゼロとは判断しません。`UNREVIEWED` のCreator情報をそのまま移行台帳として使わないでください。

prepareは現在のdecimalsとfloorを読み、`artifacts/deployment-<chain>.json` にconstructor引数と未署名の作成データを出力します。署名者や秘密鍵を要求せず、取引を送信しません。

Remixを使う場合、`contracts/JNCMarketplace_v2.24.0_VerifiedOrigin_ClaimSettlement.sol` を、Solidity0.8.24・optimizer200・Shanghaiでビルドし、生成された実行票の7つの引数を順に設定します。最後の配列には一代前以外の確認済み旧市場を指定します。別チェーンのアドレスを混ぜません。

初期管理先は実行票のfeeWalletです。新契約は `newPositionsEnabled=false` で作成されます。NFTコントラクトは再作成しません。

## デプロイ後の検証と準備

```text
node scripts/verify-deployment.cjs --chain polygon --address NEW_POLYGON_ADDRESS
node scripts/verify-deployment.cjs --chain bnb --address NEW_BNB_ADDRESS
```

実際の新アドレスに置換して実行します。実行コード、コンパイラ設定との対応、immutableの旧参照先、管理先、料率、全旧市場リストを検証し、`artifacts/verified-<chain>.json` を生成します。ソースもブロックエクスプローラで検証します。

1. `deployment-config.js` に検証済みの新アドレスと `runtimeCodeHash` を入れる。`ready=false` を維持する。
2. 保守画面の「新市場」を使い、必要なトークンを登録し、minimumとbid incrementを同期する。constructorの初期トークンはfloorがminimum・incrementにも初期設定されるため、そのまま再開しない。
3. 検証済みCreatorを運営ウォレットで登録する。画面はJNC NFTのMint取引の発行先を確認し、販売済みの手動指定では旧市場の販売取引も確認する。対応しない旧イベント形式は別途レビューした移行経路で扱う。
4. Creator・販売状態・設定を読み取り直し、テスト資産で少額動作を確認する。
5. 旧市場の取引を整理し、売主による旧承認の取消しなど、後から旧側で取引が成立しない条件を確認する。

2026年10月31日に読んだ初期値は以下です。実行直前に再取得します。

| チェーン・トークン | decimals | floor | minimum | bid increment |
|---|---|---|---|---|
| Polygon / JPYC | 18 | 1 JPYC | 100 JPYC | 1 JPYC |
| BNB / PICH | 9 | 10,000 PICH | 1,000,000 PICH | 100,000 PICH |

数字は通常のトークン表示単位です。PICHを18decimalsとして設定しないでください。

## 公開

- チェーンごとに、オンチェーンの新規受付状態と必要な移行値を確認した上で `ready=true` へ変更する。本体と管理画面が同じ設定ファイルを読む。
- `ready` は画面の切替で、オンチェーンの権限ではない。新契約の `setNewPositionsEnabled(true)` も別途必要。受付が停止中でも既存の清算・返金・受取りは可能。
- main更新がVercel本番の自動配備を起動するか、先に確認する。プレビューのAPI書込み先を本番KVから分離する。
- コミット一式を配備し、両画面、配置設定、vendor、保守画面を欠けなく公開する。旧市場の手続き画面を保持する。
- 利用者は旧出品の取消し、新市場への承認、再出品を行う。NFTをMarketplaceアドレスへ直接送付しない。

本体は日本語／英語の新メッセージに対応し、既存の韓国語・ロシア語UIは維持します。追加メッセージはそれらの言語では英語へfallbackします。新しい保守画面は日本語です。

## 仕様上の限界

- 運営によるCreator確認登録が必要。管理者を信頼しない完全自動の著作者証明ではない。
- 旧契約のロック資産や直接誤送付資産を、新契約で強制回収できない。
- 新契約でも非safeの直接送付までは拒否できず、一般回収権限は設けていない。
- トークンそのものの凍結を解除することはできない。別受取先を指定できても送金成功を保証するものではない。
- 管理は二段階移管・既存取引の料率保持で改善したが、Timelockや新しいマルチシグ自体は今回配置していない。
- 正常な取引を一律に止める全体pauseではなく、新規positionの受付停止。既存取引の権利と資金解放を維持する。

ソース・画面の巻戻しで、確定済みの取引やコントラクト作成を取り消すことはできません。公開後に異常があれば新規受付を抑え、引出し・精算導線を残して対応します。
