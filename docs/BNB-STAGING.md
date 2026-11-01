# BNB配置後の確認

## 新規受付開始

本人がsetNewPositionsEnabled(true)を実行後、ブロック `0x7cf65b9` で受付true、決済設定の差分0件を確認。Polygonも受付trueを確認済み。公開設定ready=trueの更新候補を準備し、UI18項目とPreview保存制限2ハンドラの検証が成功。以下の停止状態の記録はこの操作前の経緯。

## Creator登録完了

本人の登録操作後、ブロック `0x7ce7a56` でToken ID1の登録済み状態を照合。CreatorはMint発行先の `0xfB9831EF4B1F2C1d23A38B91e436D84FCa1B629A` と一致。初回販売未完了は旧市場2世代とも一致。不一致0件。新規受付は停止中。結果は `artifacts/origin-verification-bnb.json`。これによりPolygon38枚とBNB1枚のCreator移行確認が完了した。本番切替は未実施。

## Creator1枚の登録準備

Token ID1のMint取引 `0xf7f336fd95dd5b5f55cc1a7254599c64f923e4e6399313647134597179047d3a` の成功receipt、NFT契約からのMintイベント、送信者、ブロックhashを照合。発行先と送信者は旧Creatorと同じ `0xfB9831EF4B1F2C1d23A38B91e436D84FCa1B629A`。新市場へのregisterNFTOriginはeth_callで成功。実登録はまだ送信していない。

`migration/bnb-origins.json` とローカル画面にBNBの1件を追加。チェーン変更時は前チェーンの台帳を破棄して読み直す。UIテスト15項目成功。取引の署名は本人が行う。

## PICH設定の同期完了

本人による最低価格・最低入札増加額の変更承認後、ブロック `0x7ce7457` で再読した。有効状態true、floor10000 PICH、minimum1000000 PICH、bid increment100000 PICHがすべて旧市場と一致。追加の同期取引は不要。新規受付は停止中。以下の配置直後の差分は経緯であり、変更を再送しない。

新市場 `0xB85ceC4f53Fe09ec14F31bd8e6674231cB0f5C6D` をchain56で読取り照合済み。実行コードは準備済みv2.24.0に一致、feeWallet・fee500・royalty1000・全旧市場参照先も一致。新規受付はfalse。

PICH設定の初期floorは10000 PICHで一致。minimumは1000000 PICH（最小単位1000000000000000）、bid incrementは100000 PICH（最小単位100000000000000）への同期が必要。2件ともfeeWalletをfromとするeth_callが成功した。未送信。トークンdecimalsは9。

deployment-config.jsに照合済み新アドレスとruntimeCodeHashを登録し、ready=falseを維持した。コード照合結果はartifacts/verified-bnb.json、トークン比較と未署名変更票はartifacts/staged-token-bnb.json。本番公開、Creator1枚の移行、受付開始はまだ実施していない。
