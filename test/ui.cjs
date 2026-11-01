const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const http=require('node:http');
const assert=require('node:assert/strict');
const {ethers}=require('ethers');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'..');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
const messages=[];
const ok=name=>{messages.push(name);console.log('PASS '+name);};
for(const file of ['index.html','jnc_admin_center_v0.2.html','marketplace-tools.html']) {
  for(const match of read(file).matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(match[1].trim())new vm.Script(match[1],{filename:file});
}
for(const file of ['deployment-config.js','release.js','marketplace-tools.js'])new vm.Script(read(file),{filename:file});
ok('all HTML inline scripts and shared JavaScript parse');
function configContext(override) {
  const context={window:{ethers},ethers,console};vm.createContext(context);
  vm.runInContext(read('deployment-config.js'),context);
  if(override)override(context.window.JNC_DEPLOYMENTS);
  vm.runInContext(read('release.js'),context);return context.window;
}
const stagedConfig=configContext();
assert.equal(stagedConfig.JNCRelease.read('polygon').version,'2.24.0');
assert.equal(stagedConfig.JNCRelease.read('polygon').live,false);
assert.throws(()=>stagedConfig.JNCRelease.requireLive('polygon'));
const clearDeployments=x=>{for(const d of Object.values(x)){d.newMarketplace='';d.runtimeCodeHash='';d.ready=false;}};
const config=configContext(clearDeployments);
assert.equal(config.JNCRelease.read('polygon').version,'2.23.1');
assert.throws(()=>config.JNCRelease.requireLive('polygon'));
assert.throws(()=>config.JNCRelease.requireLive('bnb'));
assert.throws(()=>configContext(x=>{clearDeployments(x);x.polygon.ready=true;}));
assert.throws(()=>configContext(x=>x.polygon.newMarketplace=x.polygon.legacyMarketplaces[0]));
assert.throws(()=>configContext(x=>{clearDeployments(x);x.polygon.newMarketplace='0x1111111111111111111111111111111111111111';}));
ok('unconfigured release is read-only and malformed deployments are rejected');
const main=read('index.html'),admin=read('jnc_admin_center_v0.2.html');
for(const text of ['readMarketplaceOriginState','isLegacyResaleMigration','registerLegacyResaleOrigin'])assert(main.includes(text));
assert(!main.includes('!c.hasOffers&&'));assert(!main.includes('if(Array.isArray(n.offers)&&n.offers.length)'));
assert(main.includes('JNCRelease.read(key)'));assert(admin.includes('JNCRelease.read(key)'));
ok('both entry points share deployment settings and preserve migration safeguards');

(async()=>{
  const from='0x1111111111111111111111111111111111111111';
  const token='0x2222222222222222222222222222222222222222';
  const newAddress='0x3333333333333333333333333333333333333333';
  const fixtureConfig=override=>{
    const data=JSON.parse(JSON.stringify(config.JNC_DEPLOYMENTS));
    if(override)override(data);
    return 'window.JNC_DEPLOYMENTS = '+JSON.stringify(data)+';';
  };
  const types={'.html':'text/html','.js':'text/javascript','.png':'image/png'};
  const server=http.createServer((req,res)=>{
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(pathname.startsWith('/api/')){res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,collaborations:[],state:null}));return;}
    const target=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(!target.startsWith(root+path.sep)||pathname.includes('node_modules')||pathname.includes('.git')){res.writeHead(403).end();return;}
    try{res.setHeader('content-type',types[path.extname(target)]||'text/plain');res.end(fs.readFileSync(target));}catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  const edge=process.env.JNC_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  let browser;
  try{
    browser=await chromium.launch({executablePath:edge,headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>{
      if(route.request().url()===url+'/deployment-config.js')return route.fulfill({contentType:'text/javascript',body:fixtureConfig()});
      if(route.request().url().startsWith(url))return route.continue();
      const request=route.request();
      if(request.method()==='POST') {
        let rpc={};try{rpc=JSON.parse(request.postData()||'{}');}catch{}
        const result=rpc.method==='eth_getTransactionReceipt'?{status:'0x1',logs:[]}:rpc.method==='eth_chainId'?'0x89':'0x'+'0'.repeat(64);
        return route.fulfill({json:{jsonrpc:'2.0',id:1,result}});
      }
      return route.abort();
    });
    await page.addInitScript(({from})=>{
      window.__sends=[];
      window.ethereum={isMetaMask:true,request:async({method,params})=>{
        if(method==='eth_accounts'||method==='eth_requestAccounts')return [from];
        if(method==='eth_chainId')return '0x89';
        if(method==='wallet_switchEthereumChain')return null;
        if(method==='eth_getCode')return '0x6000';
        if(method==='eth_estimateGas')return '0x186a0';
        if(method==='eth_call')return '0x'+BigInt(22400).toString(16).padStart(64,'0');
        if(method==='eth_sendTransaction'){window.__sends.push(params[0]);return '0x'+'a'.repeat(64);}
        return null;
      },on:()=>{},removeListener:()=>{}};
    },{from});
    await page.goto(url+'/marketplace-tools.html');
    await page.getByText('新Marketplaceはまだ配置されていません。',{exact:true}).waitFor();
    await page.selectOption('#generation','0');
    await page.locator('#target').filter({hasText:'0xaB6659'}).waitFor();
    assert.equal(await page.locator('#action option').count(),6);
    await page.click('#connect');await page.selectOption('#action','refund');await page.fill('#token',token);
    await page.click('#inspect');await page.locator('#result').filter({hasText:'最小単位'}).waitFor();
    await page.fill('#recipient',token);await page.click('#execute');
    await page.locator('#result').filter({hasText:'接続ウォレット本人'}).waitFor();assert.equal(await page.evaluate(()=>window.__sends.length),0);
    ok('legacy maintenance shows correct target, reads without sending, rejects redirected legacy refunds');
    await page.fill('#recipient',from);page.once('dialog',dialog=>dialog.accept());await page.click('#execute');
    await page.locator('#result').filter({hasText:'取引が成功しました'}).waitFor();
    const sent=await page.evaluate(()=>window.__sends[0]);
    assert.equal(sent.to.toLowerCase(),config.JNCRelease.entry('polygon').legacyMarketplaces[0].toLowerCase());
    assert.equal(sent.data.slice(0,10),ethers.id('withdrawBidRefund(address)').slice(0,10));
    assert.equal(await page.evaluate(()=>window.__sends.length),1);
    ok('legacy refund sends exactly once to the selected old marketplace');
    fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
    await page.screenshot({path:path.join(root,'test-results/tools-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(root,'test-results/tools-mobile.png'),fullPage:true});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    ok('maintenance page fits desktop and mobile');
    await page.setViewportSize({width:1440,height:1000});
    await page.goto(url+'/jnc_admin_center_v0.2.html');
    await page.locator('aside').filter({hasText:'Marketplace更新準備中'}).first().waitFor();
    await page.selectOption('#chain','polygon');
    await page.selectOption('#chain','ethereum');
    await page.locator('#onchainRuntime').filter({hasText:'Marketplace未Deploy'}).waitFor();
    await page.selectOption('#chain','bnb');
    assert.equal((await page.locator('#onchainRuntime').innerText()).trim(),'未確認');
    await page.selectOption('#chain','polygon');
    ok('Admin chain switch resets stale undeployed status for a configured marketplace');
    await page.screenshot({path:path.join(root,'test-results/admin-desktop.png'),fullPage:true});
    assert.equal(errors.length,0,errors.join('\n'));
    ok('Admin Center loads shared release settings without script errors');
    await page.goto(url+'/');
    await page.locator('aside').filter({hasText:'Marketplace upgrade in progress'}).first().waitFor();
    await page.waitForTimeout(200);
    assert.equal(errors.length,0,errors.join('\n'));
    await page.screenshot({path:path.join(root,'test-results/market-desktop.png'),fullPage:true});
    ok('NFT Center loads with maintenance banner and no uncaught script errors');
    const cacheCheck=await page.evaluate(()=>{
      const original=getDeploymentByNftContract;
      try{
        getDeploymentByNftContract=()=>({contracts:{marketplace:'0x3333333333333333333333333333333333333333'}});
        const stale={contractAddress:'0x1111111111111111111111111111111111111111',listingId:'2',status:'listed',offers:[{offerId:'7'}],auction:{auctionId:'1'},priceWei:'500',originRegistered:true,marketStateSyncedAt:Date.now()};
        const invalidated=invalidateForeignMarketplaceState(stale);
        const fresh={...stale,listingId:'9',status:'listed',marketplaceSnapshotAddress:'0x3333333333333333333333333333333333333333'};
        return {invalidated,stale,preserved:!invalidateForeignMarketplaceState(fresh)&&fresh.listingId==='9'};
      }finally{getDeploymentByNftContract=original;}
    });
    assert(cacheCheck.invalidated);assert.equal(cacheCheck.stale.listingId,'0');assert.equal(cacheCheck.stale.auction,null);assert.equal(cacheCheck.stale.offers.length,0);assert.equal(cacheCheck.stale.originRegistered,false);assert(cacheCheck.preserved);
    ok('old-market cached listing, offer and auction IDs are discarded while current-market cache is preserved');
    const nextSteps=await page.evaluate(()=>{
      const original=resolveMarketplacePaymentRoute;
      try{
        resolveMarketplacePaymentRoute=()=>({chain:{id:'polygon'},tokenAddress:'0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29'});
        return {pending:marketplaceNextStepsHtml({tokenId:'15',originRegistered:false}),registered:marketplaceNextStepsHtml({tokenId:'15',originRegistered:true})};
      }finally{resolveMarketplacePaymentRoute=original;}
    });
    assert(nextSteps.pending.includes('action=registerOrigin&tokenId=15'));
    assert(!nextSteps.registered.includes('action=registerOrigin'));
    assert(nextSteps.registered.includes('action=proceeds&paymentToken=0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29'));
    ok('NFT details explain pending verification and link to proceeds with the correct token');
    const pendingResult=await page.evaluate(async()=>{try{await executeMarketplaceTransaction({});return 'unexpected';}catch(e){return e.message;}});
    assert(pendingResult.includes('upgrade in progress'));
    assert.equal(await page.evaluate(()=>window.__sends.length),0);
    ok('public transaction engine refuses writes before release');
    const modern=configContext(d=>{d.polygon.newMarketplace=newAddress;d.polygon.runtimeCodeHash=ethers.keccak256('0x6000');d.polygon.ready=true;});
    await modern.JNCRelease.verify('polygon',newAddress,async({method})=>method==='eth_chainId'?'0x89':method==='eth_getCode'?'0x6000':'0x'+22400n.toString(16).padStart(64,'0'));
    await assert.rejects(()=>modern.JNCRelease.verify('polygon',newAddress,async({method})=>method==='eth_chainId'?'0x38':'0x6000'));
    await assert.rejects(()=>modern.JNCRelease.verify('polygon',newAddress,async({method})=>method==='eth_chainId'?'0x89':'0x6001'));
    ok('new marketplace verification requires correct chain, runtime hash and version');
    const staged=fixtureConfig(d=>{for(const key of ['polygon','bnb']){d[key].newMarketplace=newAddress;d[key].runtimeCodeHash=ethers.keccak256('0x6000');}});
    await page.route('**/deployment-config.js',route=>route.fulfill({contentType:'text/javascript',body:staged}));
    await page.route('**/migration/polygon-origins.json',route=>route.fulfill({json:{chainId:137,target:newAddress,rows:[{tokenId:'15',creator:from,mintTransaction:'0x'+'b'.repeat(64)}]}}));
    await page.route('**/migration/bnb-origins.json',route=>route.fulfill({json:{chainId:56,target:newAddress,rows:[{tokenId:'1',creator:token,mintTransaction:'0x'+'c'.repeat(64)}]}}));
    await page.goto(url+'/marketplace-tools.html?action=proceeds&paymentToken='+token);
    assert.equal((await page.inputValue('#token')).toLowerCase(),token.toLowerCase());
    await page.click('#loadMigration');await page.locator('#migrationStatus').filter({hasText:'NFT #15：未登録'}).waitFor();
    await page.click('#nextMigration');
    assert.equal(await page.inputValue('#itemId'),'15');assert.equal(await page.inputValue('#creator'),from);
    assert.equal(await page.evaluate(()=>window.__sends.length),0);
    ok('migration queue loads reviewed fields and never submits on load or next');
    await page.selectOption('#action','claim');await page.fill('#itemId','1');await page.fill('#recipient',from);await page.click('#connect');
    page.once('dialog',dialog=>dialog.accept());await page.click('#execute');await page.locator('#result').filter({hasText:'取引が成功しました'}).waitFor();
    const claim=await page.evaluate(()=>window.__sends[0]);
    assert.equal(claim.to.toLowerCase(),newAddress.toLowerCase());assert.equal(claim.chainId,'0x89');assert.equal(claim.data.slice(0,10),ethers.id('claimAuctionNFT(uint256,address)').slice(0,10));
    ok('staged new-market claim uses verified runtime, selected recipient and explicit chain');
    await page.selectOption('#action','registerOrigin');await page.fill('#creator',from);await page.fill('#mintTx','0x'+'b'.repeat(64));await page.click('#execute');
    await page.locator('#result').filter({hasText:'Mintイベントがありません'}).waitFor();assert.equal(await page.evaluate(()=>window.__sends.length),1);
    ok('creator registration refuses missing Mint evidence without submitting a transaction');
    await page.selectOption('#chain','bnb');
    assert(await page.locator('#nextMigration').isDisabled());
    await page.click('#loadMigration');await page.locator('#migrationStatus').filter({hasText:'NFT #1：未登録'}).waitFor();
    await page.click('#nextMigration');assert.equal(await page.inputValue('#itemId'),'1');assert.equal(await page.inputValue('#creator'),token);
    assert.equal(await page.evaluate(()=>window.__sends.length),1);
    ok('chain switch clears previous queue and BNB loads its own NFT without sending');
    assert.equal(errors.length,0,errors.join('\n'));
    fs.writeFileSync(path.join(root,'test-results/ui.json'),JSON.stringify({passed:messages.length,checks:messages},null,2)+'\n');
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
