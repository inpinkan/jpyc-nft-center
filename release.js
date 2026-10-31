(function (global) {
  'use strict';
  const chains = {
    polygon: { chainId:137, chainHex:'0x89', name:'Polygon', rpc:'https://polygon.drpc.org', explorer:'https://polygonscan.com', nft:'0xeFf5f71E382E8668Db8a0894ED12D6e4c741b370' },
    bnb: { chainId:56, chainHex:'0x38', name:'BNB Smart Chain', rpc:'https://bsc-dataseed.bnbchain.org', explorer:'https://bscscan.com', nft:'0x621AEECB9374E2A57F767564E1dc999478d440c7' }
  };
  const address = x => /^0x[0-9a-f]{40}$/i.test(x || '') && !/^0x0{40}$/i.test(x);
  const deployments = {};
  for (const [key, chain] of Object.entries(chains)) {
    const cfg = global.JNC_DEPLOYMENTS?.[key];
    if (!cfg || !address(cfg.feeWallet) || !Array.isArray(cfg.legacyMarketplaces) ||
        !cfg.legacyMarketplaces.length || cfg.legacyMarketplaces.some(x => !address(x))) throw Error('Invalid deployment configuration: ' + key);
    if (new Set(cfg.legacyMarketplaces.map(x => x.toLowerCase())).size !== cfg.legacyMarketplaces.length) throw Error('Duplicate legacy marketplace');
    if (cfg.newMarketplace && (!address(cfg.newMarketplace) || cfg.legacyMarketplaces.some(x => x.toLowerCase() === cfg.newMarketplace.toLowerCase()))) throw Error('Invalid new marketplace');
    if (cfg.newMarketplace && !/^0x[0-9a-f]{64}$/i.test(cfg.runtimeCodeHash || '')) throw Error('Verified runtime hash required');
    if (cfg.ready && !address(cfg.newMarketplace)) throw Error('Deployment is not ready');
    deployments[key] = Object.freeze({ ...chain, ...cfg, legacyMarketplaces:Object.freeze([...cfg.legacyMarketplaces]) });
  }
  function entry(key) {
    if (!deployments[key]) throw Error('Unsupported chain');
    return deployments[key];
  }
  function read(key) {
    const d = entry(key), hasNew = address(d.newMarketplace);
    return Object.freeze({ ...d, marketplace:hasNew ? d.newMarketplace : d.legacyMarketplaces[0],
      version:hasNew ? '2.24.0' : '2.23.1', previousMarketplace:hasNew ? d.legacyMarketplaces[0] : (d.legacyMarketplaces[1] || ''),
      live:d.ready === true && hasNew });
  }
  function requireLive(key) {
    const d = read(key);
    if (!d.live) throw Error(message('paused'));
    return d;
  }
  const text = {
    ja: {
      paused:'Marketplace更新準備中です。売買・新規Mintは再開前です。取消し・返金は「受取り・旧市場の手続き」を利用してください。',
      pending:'Marketplace更新準備中です。閲覧は利用できます。 ',
      proceeds:'売上・手数料・ロイヤリティは「受取り」から個別に引き出せます。',
      link:'受取り・Creator確認・旧市場の手続き',
      origin:'Creatorの履歴確認と運営による登録が必要です。上の手続き画面を利用してください。',
      cancelled:'オークションを取り消しました。NFTは「受取り」から受け取ってください。Auction ID: ',
      finalized:'オークションの権利を確定しました。落札者（入札なしの場合は出品者）は「受取り」からNFTを受け取ってください。売上も個別に引き出せます。Auction ID: ',
      cancelConfirm:'オークションを取り消しますか？取消し後、NFTの受取りを別の取引で実行します。',
      finalizeConfirm:'オークションの権利を確定しますか？NFTは権利者が別途受け取り、売上・手数料・ロイヤリティは個別に引き出します。'
    },
    en: {
      paused:'Marketplace upgrade in progress. Trading and new minting have not reopened. Use Claims & legacy transactions for cancellations and refunds.',
      pending:'Marketplace upgrade in progress. Browsing remains available. ',
      proceeds:'Sale proceeds, fees and royalties are credited separately. Withdraw them from Claims.',
      link:'Claims, creator verification & legacy transactions',
      origin:'Creator history must be verified and registered by the operator. Open the procedures page above.',
      cancelled:'Auction cancelled. Collect the NFT from Claims. Auction ID: ',
      finalized:'Auction rights finalized. The winner (or seller if no bids) can collect the NFT from Claims. Proceeds are withdrawn separately. Auction ID: ',
      cancelConfirm:'Cancel this auction? The seller will collect the NFT in a separate claim transaction.',
      finalizeConfirm:'Finalize auction rights? The beneficiary will claim the NFT separately. Sale proceeds, fees and royalties are withdrawn individually.'
    }
  };
  function message(key) {
    const language=typeof document!=='undefined'&&document.documentElement.lang.toLowerCase().startsWith('ja')?'ja':'en';
    return text[language][key]||text.en[key]||key;
  }
  async function verify(key, target, request, allowUnreleased = false) {
    const d = allowUnreleased ? read(key) : requireLive(key);
    if (!address(d.newMarketplace) || target.toLowerCase() !== d.newMarketplace.toLowerCase()) throw Error('New Marketplace target mismatch');
    const chain = await request({ method:'eth_chainId', params:[] });
    if (BigInt(chain) !== BigInt(d.chainId)) throw Error('Wallet network changed');
    const code = await request({ method:'eth_getCode', params:[target, 'latest'] });
    if (!code || code === '0x' || global.ethers.keccak256(code).toLowerCase() !== d.runtimeCodeHash.toLowerCase()) throw Error('Marketplace実行コードが確認済みのものと一致しません。');
    const abi = new global.ethers.Interface(['function marketplaceVersion() view returns(uint256)']);
    const result = await request({ method:'eth_call', params:[{ to:target, data:abi.encodeFunctionData('marketplaceVersion') }, 'latest'] });
    if (abi.decodeFunctionResult('marketplaceVersion', result)[0] !== 22400n) throw Error('Marketplace version mismatch');
    return d;
  }
  function banner(parent = document.body) {
    const box = document.createElement('aside');
    box.style.cssText = 'padding:12px 18px;background:#edf5ff;color:#173c65;border-bottom:1px solid #b9d0ed;font:14px/1.7 sans-serif;position:relative;z-index:5';
    const pending = Object.keys(deployments).filter(k => !read(k).live).map(k => read(k).name);
    const span = document.createElement('span');
    const link = document.createElement('a'); link.href='/marketplace-tools.html';
    const update=()=>{span.textContent=pending.length?pending.join(' / ')+': '+message('pending'):message('proceeds')+' ';link.textContent=message('link');};
    update();new MutationObserver(update).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
    box.append(span, link); parent.prepend(box);
  }
  global.JNCRelease = Object.freeze({ version:'2.24.0', deployments:Object.freeze(deployments), entry, read, requireLive, verify, banner, message });
})(window);
