# Journey NFT Center

Marketplace 2.24.0 / 公開画面2.8.0 / Admin Center1.2.0の更新候補です。
**PolygonとBNBの新契約は配置・コード照合・決済設定の同期が完了し、Creator移行もPolygon38枚・BNB1枚の全39枚を照合済みです。両市場の新規受付は停止中、公開設定はready=falseです。旧出品の取消し・再出品、mainへの反映、本番切替はまだ行っていません。** 詳細は [Polygon配置後の確認](docs/POLYGON-STAGING.md) と [BNB配置後の確認](docs/BNB-STAGING.md) を参照してください。

## 更新内容

- OwnerによるCreator自己認定を禁止し、運営による履歴確認登録へ変更。
- 分配は初回95/5、再販85/10/5。取引作成時の料率・手数料受取先を保持。
- 売上・ロイヤリティ・手数料は個別の引出し残高に記録。
- Auction終了・取消しでNFT受取権を確定し、本人が受取先を指定して受け取る。
- OfferがあってもAuction開始可能。返金権を維持。
- 検証済みoriginを保持し、固定された複数旧市場の初回販売済み状態を参照。
- 予定外のsafeTransferによるNFT受取りを拒否。非safeの直接送付まで防げるものではありません。
- Fee Wallet変更は提案・受諾の二段階。
- 本体とAdmin Centerが同じ `deployment-config.js` を使用。
- `marketplace-tools.html` で受取り・Creator確認登録・旧市場の取消し／返金・移行時の管理操作。

既存NFTの再MintやIPFSデータの入替えは行いません。新規MintのCreator確認登録も必要です。運営キーなしで自動登録するサービスは追加していません。

## 検証

Node.js22環境で以下を実行します。

```text
npm ci --ignore-scripts --no-audit --no-fund
npm run build:contracts
npm test
```

Solidity0.8.24、optimizer有効・runs200、Shanghai。ブラウザテストはインストール済みEdgeをheadlessで使用します。別の環境では `JNC_BROWSER` にChromium系ブラウザの実行ファイルを指定してください。結果は `test-results/`、コンパイル成果物は `artifacts/` に出力します。GanacheのµWS警告はJavaScript実装へのfallbackで、テスト結果とは区別します。

## 公開前に必要な作業

[デプロイと切替](docs/DEPLOYMENT.md) を参照してください。
`deployment-config.js` の新アドレス・実行コードhashは未入力、両チェーンの `ready` はfalseです。既存の旧アドレスを新欄へ入れて再開することはできません。

本体のURLは `/`、管理画面の既存URLは `/jnc_admin_center_v0.2.html` を維持します。旧ファイル名でも内容はAdmin Center1.2.0です。
`/vendor/ethers.umd.min.js` はethers6.15.0のMITライセンス配布物です。同ディレクトリにライセンスを同梱しています。

旧版ソースはGit履歴に残します。公開用contractsフォルダには更新候補だけを置き、旧v2.22.0を現行のように並べません。
