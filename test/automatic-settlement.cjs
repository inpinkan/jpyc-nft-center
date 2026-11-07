// Local EVM only: no public-chain RPC, wallets or transactions.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {ethers}=require('ethers'),ganache=require('ganache');
const {compile,root}=require('../scripts/build-contracts.cjs');
const file='contracts/JNCMarketplace_v2.24.1_VerifiedOrigin_AutoSettlement.sol';
const extra=Object.fromEntries(['NFT.sol','AuditMocks.sol'].map(n=>[n,{content:fs.readFileSync(path.join(__dirname,'fixtures',n),'utf8')}]));
const compiled=compile(extra,file),artifact=compiled.contracts[file].JNCMarketplace;
assert(artifact.evm.deployedBytecode.object.length/2<=24576);
assert(!artifact.abi.some(x=>['withdrawProceeds','pendingProceeds','claimAuctionNFT','auctionNFTClaimant'].includes(x.name)));
const rpc=ganache.provider({logging:{quiet:true},chain:{hardfork:'shanghai'},wallet:{totalAccounts:6}});
const provider=new ethers.BrowserProvider(rpc);provider.pollingInterval=10;
const paid=async p=>(await p).wait(),results=[];
async function rejected(fn){let failed=false;try{await paid(fn());}catch{failed=true;}assert(failed,'Expected revert');}
async function deploy(source,name,signer,args=[]){const a=compiled.contracts[source][name],c=await new ethers.ContractFactory(a.abi,a.evm.bytecode.object,signer).deploy(...args);await c.waitForDeployment();return c;}
async function now(){return Number(BigInt((await rpc.request({method:'eth_getBlockByNumber',params:['latest',false]})).timestamp));}
async function advance(seconds){await rpc.request({method:'evm_increaseTime',params:[seconds]});await rpc.request({method:'evm_mine',params:[]});}
(async()=>{
 const signers=await Promise.all([0,1,2,3,4].map(i=>provider.getSigner(i)));
 const [admin,artist,collector,buyer,other]=signers,[A,R,C,B,O]=await Promise.all(signers.map(s=>s.getAddress()));
 const token=await deploy('AuditMocks.sol','AuditToken',admin),T=await token.getAddress(),nft=await deploy('NFT.sol','JPYCNFT_ERC721',admin),N=await nft.getAddress();
 const market=await deploy(file,'JNCMarketplace',admin,[T,A,500,1000,1,ethers.ZeroAddress,[]]),M=await market.getAddress();
 await paid(market.setNewPositionsEnabled(true));
 for(const s of signers){await paid(token.mint(await s.getAddress(),1000000));await paid(token.connect(s).approve(M,ethers.MaxUint256));await paid(nft.connect(s).setApprovalForAll(M,true));}
 const balance=x=>token.balanceOf(x);
 async function mint(completed=false){await paid(nft.connect(artist).mint(R,'ipfs://test'));const id=await nft.nextTokenId();await paid(market.registerNFTOrigin(N,id,R,completed));return id;}
 async function listing(s,id){await paid(market.connect(s).createListing(N,id,10000,T));return market.nextListingId();}
 async function auction(id,buyNow=0){await paid(market.connect(artist).createAuction(N,id,10000,buyNow,(await now())+10,1,T));await advance(11);return market.nextAuctionId();}
 async function test(name,fn){const snapshot=await rpc.request({method:'evm_snapshot',params:[]});try{await fn();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(e){results.push({name,status:'FAIL',error:e.shortMessage||e.message});console.log('FAIL '+name+': '+(e.shortMessage||e.message));}finally{await rpc.request({method:'evm_revert',params:[snapshot]});}}
 await test('primary purchase immediately pays 95/5; resale immediately pays 85/10/5',async()=>{
  const id=await mint();await paid(market.connect(collector).buy(await listing(artist,id)));
  assert.equal(await balance(R),1009500n);assert.equal(await balance(A),1000500n);assert.equal(await balance(C),990000n);
  await paid(market.connect(buyer).buy(await listing(collector,id)));
  assert.equal(await balance(R),1010500n);assert.equal(await balance(C),998500n);assert.equal(await balance(A),1001000n);
  assert.equal(await balance(M),0n);assert.equal(await nft.ownerOf(id),B);assert.equal(await market.originalCreator(N,id),R);
 });
 await test('creator who is also seller receives combined primary/resale share',async()=>{
  const id=await mint(true);await paid(market.connect(buyer).buy(await listing(artist,id)));
  assert.equal(await balance(R),1009500n);assert.equal(await balance(A),1000500n);assert.equal(await balance(M),0n);
 });
 await test('purchase by fee wallet pays its fee back immediately (500 example scaled x20)',async()=>{
  const id=await mint(true);await paid(nft.connect(artist).transferFrom(R,C,id));await paid(market.buy(await listing(collector,id)));
  assert.equal(await balance(A),990500n);assert.equal(await balance(C),1008500n);assert.equal(await balance(R),1001000n);assert.equal(await balance(M),0n);
 });
 await test('accepted offer immediately delivers NFT and pays beneficiaries',async()=>{
  const id=await mint();await paid(market.connect(buyer).createOffer(N,id,10000,(await now())+1000,T));
  assert.equal(await balance(M),10000n);await paid(market.connect(artist).acceptOffer(await market.nextOfferId()));
  assert.equal(await nft.ownerOf(id),B);assert.equal(await balance(R),1009500n);assert.equal(await balance(A),1000500n);assert.equal(await balance(M),0n);
 });
 await test('auction finalization immediately delivers winning NFT and pays resale 85/10/5',async()=>{
  const id=await mint(true),a=await auction(id);await paid(market.connect(buyer).bid(a,10000));await advance(86401);await paid(market.finalizeAuction(a));
  assert.equal(await nft.ownerOf(id),B);assert.equal(await balance(R),1009500n);assert.equal(await balance(A),1000500n);assert.equal(await balance(M),0n);assert.equal(await market.heldAuctionByNFT(N,id),0n);
 });
 await test('auction buy-now immediately distributes proceeds; outbid refund remains independent',async()=>{
  const id=await mint(),a=await auction(id,20000);await paid(market.connect(buyer).bid(a,10000));await paid(market.connect(other).buyNowAuction(a));
  assert.equal(await nft.ownerOf(id),O);assert.equal(await balance(R),1019000n);assert.equal(await balance(A),1001000n);
  assert.equal(await market.pendingBidRefunds(T,B),10000n);assert.equal(await balance(M),10000n);
  await paid(market.connect(buyer).withdrawBidRefund(T));assert.equal(await balance(M),0n);
 });
 await test('cancel and no-bid auction finalization return NFT without another claim',async()=>{
  const id=await mint(),a=await auction(id);await paid(market.connect(artist).cancelAuction(a));assert.equal(await nft.ownerOf(id),R);assert.equal(await market.heldAuctionByNFT(N,id),0n);
  const id2=await mint(),b=await auction(id2);await advance(86401);await paid(market.finalizeAuction(b));assert.equal(await nft.ownerOf(id2),R);assert.equal(await market.heldAuctionByNFT(N,id2),0n);
 });
 await test('payment rejection rolls purchase back completely; retry after token unblocks works',async()=>{
  const id=await mint(),l=await listing(artist,id);await paid(token.setBlocked(R,true));await rejected(()=>market.connect(buyer).buy(l));
  assert.equal(await nft.ownerOf(id),R);assert.equal(await balance(B),1000000n);assert.equal(await balance(A),1000000n);assert.equal((await market.listings(l))[5],true);assert.equal(await market.primarySaleCompleted(N,id),false);
  await paid(token.setBlocked(R,false));await paid(market.connect(buyer).buy(l,{gasLimit:1500000}));assert.equal(await nft.ownerOf(id),B);
 });
 await test('auction NFT refusal rolls finalization back; accepting receiver can retry',async()=>{
  const id=await mint(),a=await auction(id),receiver=await deploy('AuditMocks.sol','AuditBidder',admin),D=await receiver.getAddress();await paid(token.mint(D,10000));await paid(receiver.approve(T,M));await paid(receiver.placeBid(M,a,10000));await advance(86401);
  await rejected(()=>market.finalizeAuction(a));assert.equal((await market.getAuctionCore(a))[6],true);assert.equal(await nft.ownerOf(id),M);assert.equal(await balance(M),10000n);
  await paid(receiver.setRejecting(false));await paid(market.finalizeAuction(a,{gasLimit:1500000}));assert.equal(await nft.ownerOf(id),D);assert.equal(await balance(M),0n);
 });
 await test('reentrant NFT receiver cannot purchase the same listing twice',async()=>{
  const id=await mint(),l=await listing(artist,id),receiver=await deploy('AuditMocks.sol','AuditBidder',admin),D=await receiver.getAddress();await paid(token.mint(D,10000));await paid(receiver.approve(T,M));await paid(receiver.setRejecting(false));await paid(receiver.buyWithReentry(M,l));
  assert.equal(await receiver.callbackBlocked(),true);assert.equal(await nft.ownerOf(id),D);assert.equal(await balance(R),1009500n);assert.equal(await balance(M),0n);
 });
 await test('unverified owner cannot claim creator; legacy primary status and snapshotted fee remain',async()=>{
  await paid(nft.connect(artist).mint(R,'ipfs://unknown'));const unknown=await nft.nextTokenId();await rejected(()=>market.connect(artist).registerNFTOriginByOwner(N,unknown));await rejected(()=>listing(artist,unknown));
  const legacy=await deploy('AuditMocks.sol','LegacyOriginMock',admin),next=await deploy(file,'JNCMarketplace',admin,[T,A,500,1000,1,await legacy.getAddress(),[]]),V=await next.getAddress();
  const id=await mint();await paid(legacy.setOrigin(N,id,R,true));await paid(next.registerNFTOrigin(N,id,R,false));assert.equal(await next.primarySaleCompleted(N,id),true);await paid(next.setNewPositionsEnabled(true));await paid(nft.connect(artist).setApprovalForAll(V,true));await paid(token.connect(buyer).approve(V,ethers.MaxUint256));
  await paid(next.connect(artist).createListing(N,id,10000,T));await paid(next.updateFeeBps(1000));await paid(next.connect(buyer).buy(await next.nextListingId()));assert.equal(await balance(A),1000500n);assert.equal(await balance(R),1009500n);
 });
 await test('unsettled offers and bids stay fully backed when another sale auto-pays',async()=>{
  const one=await mint(),two=await mint();await paid(market.connect(buyer).createOffer(N,one,10000,(await now())+200000,T));const offer=await market.nextOfferId(),a=await auction(two);await paid(market.connect(buyer).bid(a,10000));await paid(market.connect(other).bid(a,11000));await paid(market.connect(collector).buy(await listing(artist,one)));
  assert.equal(await balance(M),31000n);await paid(market.connect(buyer).cancelOffer(offer));await paid(market.connect(buyer).withdrawBidRefund(T));assert.equal(await balance(M),11000n);await advance(86401);await paid(market.finalizeAuction(a));assert.equal(await balance(M),0n);
 });
 const report={compiler:compiled.compiler,sourceHash:compiled.sourceHash,runtimeBytes:artifact.evm.deployedBytecode.object.length/2,passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,results};
 fs.mkdirSync(path.join(root,'test-results'),{recursive:true});fs.writeFileSync(path.join(root,'test-results/automatic-settlement.json'),JSON.stringify(report,null,2));
 fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});fs.writeFileSync(path.join(root,'artifacts/JNCMarketplace-2.24.1.json'),JSON.stringify({compiler:compiled.compiler,sourceHash:compiled.sourceHash,...artifact},null,2));fs.writeFileSync(path.join(root,'artifacts/standard-input-2.24.1.json'),JSON.stringify(compiled.input,null,2));
 console.log(JSON.stringify({passed:report.passed,failed:report.failed,runtimeBytes:report.runtimeBytes}));await rpc.disconnect();if(report.failed)process.exitCode=1;
})().catch(async e=>{console.error(e);process.exitCode=1;await rpc.disconnect();});
