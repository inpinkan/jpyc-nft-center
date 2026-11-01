/* global ethers, JNCRelease */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const abi = [
    'function feeWallet() view returns(address)', 'function pendingFeeWallet() view returns(address)',
    'function newPositionsEnabled() view returns(bool)',
    'function originRegistered(address,uint256) view returns(bool)',
    'function originalCreator(address,uint256) view returns(address)',
    'function primarySaleCompleted(address,uint256) view returns(bool)',
    'function registerNFTOrigin(address,uint256,address,bool)',
    'function pendingProceeds(address,address) view returns(uint256)',
    'function pendingBidRefunds(address,address) view returns(uint256)',
    'function auctionNFTClaimant(uint256) view returns(address)',
    'function getAuctionCore(uint256) view returns(address,uint256,address,address,uint256,uint256,bool)',
    'function offers(uint256) view returns(address,uint256,address,address,uint256,uint64,bool)',
    'function listings(uint256) view returns(address,uint256,address,address,uint256,bool)',
    'function withdrawProceeds(address,address)', 'function withdrawBidRefund(address)',
    'function withdrawBidRefundTo(address,address)', 'function claimAuctionNFT(uint256,address)',
    'function cancelOffer(uint256)', 'function cancelOfferTo(uint256,address)',
    'function cancelListing(uint256)', 'function cancelAuction(uint256)', 'function finalizeAuction(uint256)',
    'function setNewPositionsEnabled(bool)', 'function setPaymentTokenEnabled(address,bool)',
    'function configurePaymentToken(address,uint256,uint256,uint256,bool)',
    'function updatePaymentTokenMinimum(address,uint256)', 'function updatePaymentTokenBidIncrement(address,uint256)',
    'function paymentTokenConfigs(address) view returns(bool,bool,uint256,uint256,uint256)',
    'function updateFeeWallet(address)', 'function acceptFeeWallet()',
    'event SaleCompleted(uint8 indexed saleType,uint256 indexed referenceId,address indexed nftContract,uint256 tokenId,address seller,address buyer,address paymentToken,uint256 price,bool resale)'
  ];
  const iface = new ethers.Interface(abi);
  const nftIface = new ethers.Interface(['event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']);
  const tokenIface = new ethers.Interface(['function decimals() view returns(uint8)']);
  const actions = {
    proceeds: { title:'売上・ロイヤリティ・手数料を引き出す', modern:true, token:true, recipient:true, note:'売買成立時に記録された、接続ウォレットの残高を引き出します。' },
    claim: { title:'確定したオークションNFTを受け取る', modern:true, id:true, recipient:true, note:'権利者本人が受取先を指定します。受取りに失敗しても権利は残ります。' },
    refund: { title:'旧入札の返金を引き出す', token:true, recipient:true, note:'旧市場では返金先は入札者本人です。新市場では本人が別の受取先を指定できます。' },
    cancelOffer: { title:'自分のオファーを取消し・返金', id:true, recipient:true },
    cancelListing: { title:'自分の出品を取り消す', id:true },
    cancelAuction: { title:'入札のない自分のオークションを取り消す', id:true, note:'新市場では取消し後、NFTの受取りを別途実行してください。' },
    finalize: { title:'終了したオークションの権利を確定する', id:true, note:'新市場では確定後、権利者がNFTを受け取ります。旧市場の精算方法は変更されません。' },
    registerOrigin: { title:'運営：確認したCreatorを登録する', modern:true, id:true, origin:true, note:'Token IDを指定します。登録後は上書きできません。履歴を確認した運営Fee Walletだけが実行できます。' },
    configureToken: { title:'運営：決済トークンを新規登録する（無効状態）', modern:true, token:true, tokenConfig:true },
    updateMinimum: { title:'運営：決済トークンの最低価格を同期する', modern:true, token:true, amount:true },
    updateIncrement: { title:'運営：最低入札増加額を同期する', modern:true, token:true, amount:true },
    enableToken: { title:'運営：決済トークンを有効化する', modern:true, token:true },
    disableToken: { title:'運営：決済トークンの新規受付を止める', token:true, note:'既存の購入・入札・精算・返金を一括停止する機能ではありません。' },
    pause: { title:'運営：新規出品・オファー・オークションを停止', modern:true },
    resume: { title:'運営：新規出品・オファー・オークションを再開', modern:true, note:'移行台帳と全トークン設定の確認後に実行してください。公開画面の再開設定は別に行います。' },
    proposeFee: { title:'運営：Fee Walletの変更先を提案', modern:true, fee:true },
    acceptFee: { title:'新管理者：Fee Walletの変更を受諾', modern:true }
  };
  let wallet, busy=false, migration=[];
  function registrationKey(c,id){return 'jnc-origin-tx:'+c.d.chainId+':'+c.target.toLowerCase()+':'+id;}
  async function loadMigration(){
    const c=context();
    if(!c.modern)throw Error('新市場を選んでください。');
    const response=await fetch('/migration/'+c.key+'-origins.json');
    if(!response.ok)throw Error('移行台帳を読み込めません。');
    const data=await response.json();
    if(data.chainId!==c.d.chainId||data.target.toLowerCase()!==c.target.toLowerCase())throw Error('台帳と操作先が一致しません。');
    migration=[];
    for(const row of data.rows){
      if(!/^[1-9]\d*$/.test(row.tokenId)||!ethers.isAddress(row.creator)||!/^0x[0-9a-f]{64}$/i.test(row.mintTransaction))throw Error('台帳の形式が不正です。');
      const registered=(await view(c,'originRegistered',[c.d.nft,row.tokenId]))[0];
      let status='未登録';
      if(registered){
        const creator=(await view(c,'originalCreator',[c.d.nft,row.tokenId]))[0];
        status=creator.toLowerCase()===row.creator.toLowerCase()?'登録済み':'Creator不一致：要確認';
      }else{
        const hash=localStorage.getItem(registrationKey(c,row.tokenId));
        if(hash){const receipt=await read(c,'eth_getTransactionReceipt',[hash]);status=receipt&&BigInt(receipt.status)===0n?'未登録':'送信済み：再確認待ち';}
      }
      migration.push({...row,status,target:c.target,key:c.key});
    }
    $('migrationStatus').textContent='登録済み '+migration.filter(x=>x.status==='登録済み').length+' / '+migration.length+'件\n'+migration.map(x=>'NFT #'+x.tokenId+'：'+x.status).join('\n');
  }
  function nextMigration(){
    const c=context(),row=migration.find(x=>x.status==='未登録'&&x.target===c.target&&x.key===c.key);
    if(!row)throw Error('次の未登録NFTがありません。台帳と登録状況を読み直してください。');
    $('action').value='registerOrigin';renderAction();
    $('itemId').value=row.tokenId;$('creator').value=row.creator;$('mintTx').value=row.mintTransaction;$('completed').checked=false;$('saleTx').value='';
    output('NFT #'+row.tokenId+' の登録候補を入力しました。Creator: '+row.creator+'\n内容を確認してから実行してください。');
    $('originFields').scrollIntoView({block:'center'});
  }
  function context() {
    const key=$('chain').value, d=JNCRelease.entry(key), generation=$('generation').value;
    const modern=generation==='new';
    const target=modern?d.newMarketplace:d.legacyMarketplaces[Number(generation)];
    if (!ethers.isAddress(target || '') || target===ethers.ZeroAddress) throw Error('新Marketplaceはまだ配置されていません。');
    return { key, d, target, modern };
  }
  function renderMarket() {
    const d=JNCRelease.entry($('chain').value);
    migration=[];$('nextMigration').disabled=true;
    $('migrationStatus').textContent='台帳は未読込みです。';
    $('migrationIntro').textContent=d.name+'の既存NFT（'+($('chain').value==='polygon'?'38':'1')+'件）を確認し、未登録の1件を入力します。読込みだけでは送信しません。登録は運営ウォレットで1件ずつ承認してください。';
    $('generation').replaceChildren();
    const add=(value,title)=>{const o=document.createElement('option');o.value=value;o.textContent=title;$('generation').append(o);};
    add('new',d.newMarketplace?'新市場 v2.24.0':'新市場：配置待ち');
    d.legacyMarketplaces.forEach((_,i)=>add(String(i),i===0?'旧市場 v2.23.1':'さらに前の市場 '+i));
    renderActions();
  }
  function renderActions() {
    const modern=$('generation').value==='new';
    $('action').replaceChildren();
    for(const [key,a] of Object.entries(actions)) {
      if(a.modern&&!modern)continue;
      const o=document.createElement('option');o.value=key;o.textContent=a.title;$('action').append(o);
    }
    try { const c=context();$('target').textContent=c.d.name+' / '+(c.modern?'新市場':'旧市場')+'\n'+c.target; }
    catch(e){$('target').textContent=e.message;}
    renderAction();
  }
  function renderAction() {
    const a=actions[$('action').value];
    for(const [id,key] of [['tokenField','token'],['idField','id'],['recipientField','recipient'],['originFields','origin'],['tokenConfigFields','tokenConfig'],['feeField','fee'],['amountField','amount']])$(id).hidden=!a[key];
    $('amountLabel').textContent=$('action').value==='updateMinimum'?'新しい最低価格':'新しい最低入札増加額';
    $('idLabel').textContent=a.origin?'NFTのToken ID':a.id?'取引ID':'ID';
    $('actionNote').textContent=a.note||'';
    output('操作するチェーン・市場・取引IDを確認してください。');
  }
  function output(message,error=false) { $('result').textContent=message; if(error)$('result').setAttribute('role','alert');else $('result').removeAttribute('role'); }
  async function read(c,method,args=[]) {
    const response=await fetch(c.d.rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:args}),signal:AbortSignal.timeout(15000)});
    const payload=await response.json();if(payload.error)throw Error(payload.error.message);if(payload.result===undefined)throw Error('RPCから結果が返りません。');return payload.result;
  }
  async function view(c,name,args=[]) {return iface.decodeFunctionResult(name,await read(c,'eth_call',[{to:c.target,data:iface.encodeFunctionData(name,args)},'latest']));}
  function validAddress(value,label) { if(!ethers.isAddress(value)||value===ethers.ZeroAddress)throw Error(label+'のアドレスを確認してください。');return ethers.getAddress(value); }
  function idValue(){if(!/^[1-9]\d*$/.test($('itemId').value))throw Error('IDは1以上の整数で入力してください。');return BigInt($('itemId').value);}
  function provider() {
    if(wallet)return wallet;
    const list=window.ethereum?.providers;
    wallet=Array.isArray(list)?list.find(x=>x.isMetaMask)||list[0]:window.ethereum;
    if(!wallet)throw Error('対応するウォレット拡張を開いてください。');return wallet;
  }
  async function account(connect=false) {
    const accounts=await provider().request({method:connect?'eth_requestAccounts':'eth_accounts'});
    if(!accounts?.[0])throw Error('ウォレットを接続してください。');
    $('account').textContent=accounts[0];
    if(!$('recipient').value)$('recipient').value=accounts[0];
    return ethers.getAddress(accounts[0]);
  }
  async function inspect() {
    const c=context(),action=$('action').value,from=await account();let result;
    if(action==='proceeds')result=await view(c,'pendingProceeds',[validAddress($('token').value,'トークン'),from]);
    else if(action==='refund')result=await view(c,'pendingBidRefunds',[validAddress($('token').value,'トークン'),from]);
    else if(action==='claim')result=await view(c,'auctionNFTClaimant',[idValue()]);
    else if(action==='cancelOffer')result=await view(c,'offers',[idValue()]);
    else if(action==='cancelListing')result=await view(c,'listings',[idValue()]);
    else if(['cancelAuction','finalize'].includes(action))result=await view(c,'getAuctionCore',[idValue()]);
    else if(action==='registerOrigin')result={registered:(await view(c,'originRegistered',[c.d.nft,idValue()]))[0],creator:(await view(c,'originalCreator',[c.d.nft,idValue()]))[0],completed:(await view(c,'primarySaleCompleted',[c.d.nft,idValue()]))[0]};
    else if(['configureToken','enableToken','disableToken','updateMinimum','updateIncrement'].includes(action))result=await view(c,'paymentTokenConfigs',[validAddress($('token').value,'トークン')]);
    else result={feeWallet:(await view(c,'feeWallet'))[0],pendingFeeWallet:c.modern?(await view(c,'pendingFeeWallet'))[0]:'—',newPositionsEnabled:c.modern?(await view(c,'newPositionsEnabled'))[0]:'旧市場には全体停止機能なし'};
    output(c.d.name+' / '+c.target+'\n'+JSON.stringify(result,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n金額が数値の場合はトークンの最小単位です。');
  }
  async function successfulReceipt(c,hash) {
    if(!/^0x[0-9a-f]{64}$/i.test(hash))throw Error('取引ハッシュを確認してください。');
    const receipt=await read(c,'eth_getTransactionReceipt',[hash]);
    if(!receipt||BigInt(receipt.status)!==1n)throw Error('成功した取引を確認できません。');
    return receipt;
  }
  async function originEvidence(c,id,creator) {
    const receipt=await successfulReceipt(c,$('mintTx').value.trim());
    const mint=receipt.logs.some(log=>{
      if(log.address.toLowerCase()!==c.d.nft.toLowerCase())return false;
      try{const e=nftIface.parseLog(log);return e?.name==='Transfer'&&e.args.from===ethers.ZeroAddress&&e.args.to.toLowerCase()===creator.toLowerCase()&&e.args.tokenId===id;}catch{return false;}
    });
    if(!mint)throw Error('指定NFT・Token ID・Creatorに一致するMintイベントがありません。');
    if($('completed').checked) {
      const saleReceipt=await successfulReceipt(c,$('saleTx').value.trim());
      const sold=saleReceipt.logs.some(log=>{
        if(!c.d.legacyMarketplaces.some(x=>x.toLowerCase()===log.address.toLowerCase()))return false;
        try{const e=iface.parseLog(log);return e?.name==='SaleCompleted'&&e.args.nftContract.toLowerCase()===c.d.nft.toLowerCase()&&e.args.tokenId===id;}catch{return false;}
      });
      if(!sold)throw Error('確認済み旧市場の販売イベントと一致しません。旧版でイベント形式が違う場合は台帳で確認して専用の移行スクリプトを使用してください。');
    }
  }
  async function build(c,from) {
    const action=$('action').value;
    const token=()=>validAddress($('token').value.trim(),'トークン'),recipient=()=>validAddress($('recipient').value.trim(),'受取先');
    if(action==='proceeds')return ['withdrawProceeds',[token(),recipient()]];
    if(action==='claim')return ['claimAuctionNFT',[idValue(),recipient()]];
    if(action==='refund') {
      if(c.modern)return ['withdrawBidRefundTo',[token(),recipient()]];
      if(recipient().toLowerCase()!==from.toLowerCase())throw Error('旧市場は接続ウォレット本人への返金のみ対応しています。');
      return ['withdrawBidRefund',[token()]];
    }
    if(action==='cancelOffer') {
      if(c.modern)return ['cancelOfferTo',[idValue(),recipient()]];
      if(recipient().toLowerCase()!==from.toLowerCase())throw Error('旧市場は本人への返金のみ対応しています。');
      return ['cancelOffer',[idValue()]];
    }
    if(action==='cancelListing')return ['cancelListing',[idValue()]];
    if(action==='cancelAuction')return ['cancelAuction',[idValue()]];
    if(action==='finalize')return ['finalizeAuction',[idValue()]];
    if(action==='registerOrigin') {
      const creator=validAddress($('creator').value.trim(),'Creator'),id=idValue();
      if((await view(c,'originRegistered',[c.d.nft,id]))[0])throw Error('このNFTは登録済みです。台帳を再読込みしてください。');
      const previousHash=localStorage.getItem(registrationKey(c,id));
      if(previousHash){const receipt=await read(c,'eth_getTransactionReceipt',[previousHash]);if(!receipt||BigInt(receipt.status)!==0n)throw Error('登録取引は送信済みです。再送せず台帳を再読込みしてください。tx: '+previousHash);}
      await originEvidence(c,id,creator);
      return ['registerNFTOrigin',[c.d.nft,id,creator,$('completed').checked]];
    }
    if(['configureToken','updateMinimum','updateIncrement'].includes(action)) {
      const t=token(),raw=await read(c,'eth_call',[{to:t,data:tokenIface.encodeFunctionData('decimals')},'latest']);
      const decimals=Number(tokenIface.decodeFunctionResult('decimals',raw)[0]);
      if(action!=='configureToken')return [action==='updateMinimum'?'updatePaymentTokenMinimum':'updatePaymentTokenBidIncrement',[t,ethers.parseUnits($('settingAmount').value,decimals)]];
      return ['configurePaymentToken',[t,ethers.parseUnits($('floor').value,decimals),ethers.parseUnits($('minimum').value,decimals),ethers.parseUnits($('increment').value,decimals),false]];
    }
    if(['enableToken','disableToken'].includes(action))return ['setPaymentTokenEnabled',[token(),action==='enableToken']];
    if(['resume','pause'].includes(action))return ['setNewPositionsEnabled',[action==='resume']];
    if(action==='proposeFee')return ['updateFeeWallet',[validAddress($('newFeeWallet').value.trim(),'新Fee Wallet')]];
    if(action==='acceptFee')return ['acceptFeeWallet',[]];
    throw Error('未対応の操作です。');
  }
  async function execute() {
    const c=context(),from=await account(true),p=provider();
    if(BigInt(await p.request({method:'eth_chainId'}))!==BigInt(c.d.chainId))await p.request({method:'wallet_switchEthereumChain',params:[{chainId:c.d.chainHex}]});
    const [name,args]=await build(c,from);
    const summary=actions[$('action').value].title+'\n'+c.d.name+'\n市場: '+c.target+'\n送信者: '+from+'\n'+name+'\n'+JSON.stringify(args,(_,v)=>typeof v==='bigint'?v.toString():v);
    if(!window.confirm(summary+'\n\nこの内容でウォレットへ承認を依頼しますか？'))return;
    // Recheck the UI selection, chain and account after async evidence/RPC calls and confirmation.
    const current=context();
    if(current.key!==c.key||current.target.toLowerCase()!==c.target.toLowerCase())throw Error('操作先が変わりました。やり直してください。');
    if(await account()!==from)throw Error('ウォレットが変わりました。');
    if(BigInt(await p.request({method:'eth_chainId'}))!==BigInt(c.d.chainId))throw Error('ネットワークが変わりました。');
    if(c.modern)await JNCRelease.verify(c.key,c.target,x=>p.request(x),true);
    else if((await p.request({method:'eth_getCode',params:[c.target,'latest']}))==='0x')throw Error('旧Marketplaceのコードがありません。');
    const tx={from,to:c.target,data:iface.encodeFunctionData(name,args),value:'0x0',chainId:c.d.chainHex};
    await p.request({method:'eth_call',params:[tx,'latest']});
    await p.request({method:'eth_estimateGas',params:[tx]});
    const hash=await p.request({method:'eth_sendTransaction',params:[tx]});
    if(name==='registerNFTOrigin')localStorage.setItem(registrationKey(c,args[1]),hash);
    output('送信済みです。再送しないでください。\n'+hash+'\n確定を確認しています…');
    try { for(let i=0;i<90;i++) {
      const receipt=await read(c,'eth_getTransactionReceipt',[hash]);
      if(receipt) {
        if(BigInt(receipt.status)!==1n){output('取引が失敗しました。tx: '+hash,true);return;}
        output('取引が成功しました。\n'+hash+'\n状態を再確認してください。'+(['cancelAuction','finalize'].includes($('action').value)&&c.modern?'\nNFTは権利者が「確定したオークションNFTを受け取る」で受け取ってください。':''));
        return;
      }
      await new Promise(resolve=>setTimeout(resolve,2000));
    } } catch(e) {
      output('送信済み・確定確認は保留です。再送せず、取引履歴で確認してください。\n'+hash+'\n'+e.message,true);
      return;
    }
    output('送信済み・確定確認は保留です。再送せず、チェーンの取引履歴で確認してください。\n'+hash);
  }
  async function run(fn) {
    if(busy)return;busy=true;
    document.querySelectorAll('button,input,select').forEach(x=>x.disabled=true);
    try{await fn();}catch(e){output(e.shortMessage||e.message||String(e),true);}
    finally{busy=false;document.querySelectorAll('button,input,select').forEach(x=>x.disabled=false);$('nextMigration').disabled=!migration.some(x=>x.status==='未登録');}
  }
  $('chain').addEventListener('change',renderMarket);$('generation').addEventListener('change',renderActions);$('action').addEventListener('change',renderAction);
  $('connect').addEventListener('click',()=>run(()=>account(true)));
  $('inspect').addEventListener('click',()=>run(inspect));$('execute').addEventListener('click',()=>run(execute));
  $('loadMigration').addEventListener('click',()=>run(loadMigration));$('nextMigration').addEventListener('click',()=>run(async()=>nextMigration()));
  const initial=new URLSearchParams(window.location.search);
  if(['polygon','bnb'].includes(initial.get('chain')))$('chain').value=initial.get('chain');
  renderMarket();
  if(actions[initial.get('action')]&&$('action').querySelector('option[value="'+initial.get('action')+'"]')){
    $('action').value=initial.get('action');renderAction();
  }
  const initialId=initial.get('tokenId')||initial.get('auctionId');
  if(/^[1-9]\d*$/.test(initialId||''))$('itemId').value=initialId;
  const initialToken=initial.get('paymentToken');
  if(ethers.isAddress(initialToken||'')&&initialToken!==ethers.ZeroAddress)$('token').value=ethers.getAddress(initialToken);
})();
