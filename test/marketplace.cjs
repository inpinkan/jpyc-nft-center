const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {ethers}=require('ethers');
const ganache=require('ganache');
const {compile,file,root}=require('../scripts/build-contracts.cjs');
const extra=Object.fromEntries(['NFT.sol','AuditMocks.sol'].map(name=>[name,{content:fs.readFileSync(path.join(__dirname,'fixtures',name),'utf8')}]));
const compiled=compile(extra);
const rpc=ganache.provider({logging:{quiet:true},chain:{hardfork:'shanghai'},wallet:{totalAccounts:8}});
const provider=new ethers.BrowserProvider(rpc);provider.pollingInterval=10;
const ZERO=ethers.ZeroAddress, MAX=ethers.MaxUint256, results=[];
const paid=async p=>(await p).wait();
async function rejected(fn){let failed=false;try{const tx=await fn();if(tx?.wait)await tx.wait();}catch{failed=true;}assert.equal(failed,true,'Expected revert');}
async function deploy(source,name,signer,args=[]){const a=compiled.contracts[source][name];const c=await new ethers.ContractFactory(a.abi,a.evm.bytecode.object,signer).deploy(...args);await c.waitForDeployment();return c;}
async function now(){return Number(BigInt((await rpc.request({method:'eth_getBlockByNumber',params:['latest',false]})).timestamp));}
async function advance(seconds){await rpc.request({method:'evm_increaseTime',params:[seconds]});await rpc.request({method:'evm_mine',params:[]});}
(async()=>{
  const signers=await Promise.all(Array.from({length:6},(_,i)=>provider.getSigner(i)));
  const [admin,artist,collector,buyer,other]=signers;
  const [A,R,C,B,O]=await Promise.all(signers.slice(0,5).map(x=>x.getAddress()));
  const token=await deploy('AuditMocks.sol','AuditToken',admin),T=await token.getAddress();
  const nft=await deploy('NFT.sol','JPYCNFT_ERC721',admin),N=await nft.getAddress();
  async function newMarket(previous=ZERO,older=[]){return deploy(file,'JNCMarketplace',admin,[T,A,500,1000,1,previous,older]);}
  const market=await newMarket(),M=await market.getAddress();
  await paid(market.setNewPositionsEnabled(true));
  for(const signer of signers){await paid(token.mint(await signer.getAddress(),1000000));await paid(token.connect(signer).approve(M,MAX));await paid(nft.connect(signer).setApprovalForAll(M,true));}
  async function mint(signer=artist,verified=true,completed=false,target=market){await paid(nft.connect(signer).mint(await signer.getAddress(),'ipfs://test'));const id=await nft.nextTokenId();if(verified)await paid(target.registerNFTOrigin(N,id,await signer.getAddress(),completed));return id;}
  async function listing(signer,id,price=10000,target=market){await paid(nft.connect(signer).setApprovalForAll(await target.getAddress(),true));await paid(target.connect(signer).createListing(N,id,price,T));return target.nextListingId();}
  async function auction(signer,id,buyNow=0){const start=(await now())+10;await paid(market.connect(signer).createAuction(N,id,10000,buyNow,start,1,T));await advance(11);return market.nextAuctionId();}
  const balance=a=>market.pendingProceeds(T,a);
  async function test(name,fn){const snapshot=await rpc.request({method:'evm_snapshot',params:[]});try{await fn();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(e){results.push({name,status:'FAIL',error:e.shortMessage||e.message});console.log('FAIL '+name+': '+(e.shortMessage||e.message));}finally{await rpc.request({method:'evm_revert',params:[snapshot]});}}

  await test('F01 unknown origin cannot self-register, list, auction or receive offer',async()=>{
    const id=await mint(artist,false);await paid(nft.connect(artist).transferFrom(R,C,id));
    await rejected(()=>market.connect(collector).registerNFTOriginByOwner(N,id));
    await rejected(()=>market.connect(collector).createListing(N,id,10000,T));
    await paid(nft.connect(collector).setApprovalForAll(M,true));
    await rejected(()=>market.connect(collector).createListing(N,id,10000,T));
    const start=(await now())+100;
    await rejected(()=>market.connect(collector).createAuction(N,id,10000,0,start,1,T));
    await rejected(()=>market.connect(buyer).createOffer(N,id,10000,start+1000,T));
    assert.equal(await market.originRegistered(N,id),false);
  });
  await test('F01 only fee wallet can verify origin; no registration overwrite',async()=>{
    const id=await mint(artist,false);
    await rejected(()=>market.connect(collector).registerNFTOrigin(N,id,C,false));
    await paid(market.registerNFTOrigin(N,id,R,false));
    await rejected(()=>market.registerNFTOrigin(N,id,C,true));
    await rejected(()=>market.registerNFTOrigin(N,999999,R,false));
    assert.equal(await market.originalCreator(N,id),R);
  });
  await test('N01 primary 95/5, resale 85/10/5, and independent withdrawal',async()=>{
    const id=await mint(),l=await listing(artist,id);
    await paid(market.connect(collector).buy(l));
    assert.equal(await balance(R),9500n);assert.equal(await balance(A),500n);
    const l2=await listing(collector,id);await paid(market.connect(buyer).buy(l2));
    assert.equal(await balance(R),10500n);assert.equal(await balance(C),8500n);assert.equal(await balance(A),1000n);
    assert.equal(await token.balanceOf(M),20000n);
    await paid(market.connect(artist).withdrawProceeds(T,R));
    await paid(market.connect(collector).withdrawProceeds(T,C));
    await paid(market.withdrawProceeds(T,A));
    assert.equal(await token.balanceOf(M),0n);assert.equal(await nft.ownerOf(id),B);
    await rejected(()=>market.withdrawProceeds(T,A));
  });
  await test('F01 transferred untraded NFT pays real creator and never resets resale',async()=>{
    const id=await mint();await paid(nft.connect(artist).transferFrom(R,C,id));
    const l=await listing(collector,id);await paid(market.connect(artist).buy(l));
    assert.equal(await balance(R),1000n);assert.equal(await balance(C),8500n);assert.equal(await market.primarySaleCompleted(N,id),true);
    const next=await listing(artist,id);await paid(market.connect(buyer).buy(next));
    assert.equal(await balance(R),10500n);assert.equal(await balance(A),1000n);
  });
  await test('F04 unverified predecessor creator is never automatically imported',async()=>{
    const legacy=await deploy('AuditMocks.sol','LegacyOriginMock',admin),L=await legacy.getAddress();
    const id=await mint(artist,false);await paid(legacy.setOrigin(N,id,C,false));
    const next=await newMarket(L);await paid(next.setNewPositionsEnabled(true));
    await rejected(()=>listing(artist,id,10000,next));
    await paid(next.registerNFTOrigin(N,id,R,false));assert.equal(await next.originalCreator(N,id),R);
  });
  await test('F04 older-than-immediate sale history is preserved',async()=>{
    const old=await deploy('AuditMocks.sol','LegacyOriginMock',admin),middle=await deploy('AuditMocks.sol','LegacyOriginMock',admin);
    const id=await mint(artist,false);await paid(old.setOrigin(N,id,R,true));
    const next=await newMarket(await middle.getAddress(),[await old.getAddress()]);
    await paid(next.registerNFTOrigin(N,id,R,false));assert.equal(await next.primarySaleCompleted(N,id),true);
    assert.equal(await next.legacyMarketplaceCount(),2n);
    await rejected(async()=>newMarket(await middle.getAddress(),[await middle.getAddress()]));
  });
  await test('F05 old-market sale after registration is reflected at settlement',async()=>{
    const old=await deploy('AuditMocks.sol','LegacyOriginMock',admin),id=await mint(artist,false);
    await paid(old.setOrigin(N,id,R,false));
    const next=await newMarket(await old.getAddress());await paid(next.setNewPositionsEnabled(true));
    await paid(next.registerNFTOrigin(N,id,R,false));assert.equal(await next.primarySaleCompleted(N,id),false);
    await paid(old.setOrigin(N,id,R,true));assert.equal(await next.primarySaleCompleted(N,id),true);
    await paid(nft.connect(artist).transferFrom(R,C,id));
    const l=await listing(collector,id,10000,next);await paid(token.connect(buyer).approve(await next.getAddress(),MAX));
    await paid(next.connect(buyer).buy(l));assert.equal(await next.pendingProceeds(T,R),1000n);
    assert.equal(await next.pendingProceeds(T,C),8500n);
    assert.equal(await next.primarySaleCompleted(N,id),true);
  });
  await test('F02 rejecting winner does not block finalization, can claim to another address',async()=>{
    const id=await mint(),a=await auction(artist,id),bidder=await deploy('AuditMocks.sol','AuditBidder',admin),D=await bidder.getAddress();
    await paid(token.mint(D,10000));await paid(bidder.approve(T,M));await paid(bidder.placeBid(M,a,10000));await advance(86401);
    await paid(market.finalizeAuction(a));assert.equal((await market.getAuctionCore(a))[6],false);assert.equal(await market.auctionNFTClaimant(a),D);
    await rejected(()=>bidder.claim(M,a,D));assert.equal(await market.auctionNFTClaimant(a),D);
    await rejected(()=>market.connect(buyer).claimAuctionNFT(a,B));
    await paid(bidder.claim(M,a,B));assert.equal(await nft.ownerOf(id),B);
    assert.equal(await market.heldAuctionByNFT(N,id),0n);await rejected(()=>bidder.claim(M,a,B));
  });
  await test('F02 blocked seller does not block finalization or other beneficiaries',async()=>{
    const id=await mint(),a=await auction(artist,id);await paid(market.connect(buyer).bid(a,10000));await paid(token.setBlocked(R,true));await advance(86401);
    await paid(market.finalizeAuction(a));await paid(market.connect(buyer).claimAuctionNFT(a,B));
    await paid(market.withdrawProceeds(T,A));await rejected(()=>market.connect(artist).withdrawProceeds(T,R));
    assert.equal(await balance(R),9500n);await paid(market.connect(artist).withdrawProceeds(T,O));assert.equal(await token.balanceOf(M),0n);
  });
  await test('F02 sale funds cannot be claimed by NFT recipient or other users',async()=>{
    const id=await mint(),a=await auction(artist,id);await paid(market.connect(buyer).bid(a,10000));await advance(86401);await paid(market.finalizeAuction(a));
    await rejected(()=>market.connect(other).claimAuctionNFT(a,O));await rejected(()=>market.connect(other).withdrawProceeds(T,O));
    assert.equal(await balance(R),9500n);assert.equal(await market.auctionNFTClaimant(a),B);
  });
  await test('F03 valid and expired offers do not prevent auction; refunds remain possible',async()=>{
    const id=await mint();await paid(market.connect(buyer).createOffer(N,id,1,(await now())+10,T));const offer=await market.nextOfferId();await advance(11);
    const a=await auction(artist,id);await rejected(()=>market.connect(artist).acceptOffer(offer));
    await paid(market.connect(buyer).cancelOffer(offer));assert.equal(await token.balanceOf(M),0n);
    await paid(market.connect(artist).cancelAuction(a));await paid(market.connect(artist).claimAuctionNFT(a,R));
    await paid(market.connect(buyer).createOffer(N,id,1,(await now())+1000,T));await auction(artist,id);
  });
  await test('F06 fees and fee recipient are snapshotted for existing listing',async()=>{
    const id=await mint(),l=await listing(artist,id);await paid(market.updateFeeBps(2000));await paid(market.updateFeeWallet(O));
    assert.equal(await market.feeWallet(),A);assert.equal(await market.pendingFeeWallet(),O);
    await rejected(()=>market.connect(buyer).acceptFeeWallet());await paid(market.connect(other).acceptFeeWallet());
    await paid(market.connect(buyer).buy(l));assert.equal(await balance(A),500n);assert.equal(await balance(O),0n);assert.equal(await balance(R),9500n);
    await rejected(()=>market.updateFeeBps(500));
  });
  await test('F06 existing offer and auction retain agreed fee/royalty rates',async()=>{
    const id=await mint(artist,true,true);await paid(market.connect(buyer).createOffer(N,id,10000,(await now())+200000,T));const offer=await market.nextOfferId();
    const id2=await mint(),a=await auction(artist,id2);await paid(market.updateFeeBps(1000));await paid(market.updateRoyaltyBps(2000));
    await paid(market.connect(artist).acceptOffer(offer));assert.equal(await balance(R),9500n);assert.equal(await balance(A),500n);
    await paid(market.connect(buyer).bid(a,10000));await advance(86401);await paid(market.finalizeAuction(a));
    assert.equal(await balance(R),19000n);assert.equal(await balance(A),1000n);
  });
  await test('F07 authenticated alternate offer refund and bid refund recipients',async()=>{
    const id=await mint();await paid(market.connect(buyer).createOffer(N,id,10000,(await now())+10,T));const offer=await market.nextOfferId();
    await paid(token.setBlocked(B,true));await advance(11);await rejected(()=>market.connect(buyer).cancelOffer(offer));
    await paid(market.connect(buyer).cancelOfferTo(offer,O));assert.equal((await market.offers(offer))[6],false);
    await paid(token.setBlocked(B,false));const a=await auction(artist,id);await paid(market.connect(buyer).bid(a,10000));await paid(token.setBlocked(B,true));
    await paid(market.connect(other).bid(a,10001));await rejected(()=>market.connect(buyer).withdrawBidRefund(T));
    await paid(market.connect(buyer).withdrawBidRefundTo(T,O));assert.equal(await market.pendingBidRefunds(T,B),0n);
  });
  await test('F08 unsolicited safe NFT transfer rejected; ordinary auction deposit accepted',async()=>{
    const id=await mint();await rejected(()=>nft.connect(artist)['safeTransferFrom(address,address,uint256)'](R,M,id));assert.equal(await nft.ownerOf(id),R);
    const a=await auction(artist,id);assert.equal(await nft.ownerOf(id),M);assert.equal(await market.heldAuctionByNFT(N,id),a);
    await rejected(()=>market.onERC721Received(M,R,id,'0x'));
  });
  await test('N02 paused by default; pause does not freeze existing trades or withdrawals',async()=>{
    const fresh=await newMarket();assert.equal(await fresh.newPositionsEnabled(),false);
    const id=await mint(),l=await listing(artist,id);await paid(market.setNewPositionsEnabled(false));
    const id2=await mint();await rejected(()=>market.connect(artist).createListing(N,id2,10000,T));
    await paid(market.connect(buyer).buy(l));await paid(market.connect(artist).withdrawProceeds(T,R));
    await rejected(()=>market.connect(buyer).setNewPositionsEnabled(true));
  });
  await test('N03 listing cancellation, stale approval and token disable behavior',async()=>{
    const id=await mint(),l=await listing(artist,id);await rejected(()=>market.connect(buyer).cancelListing(l));
    await paid(market.connect(artist).cancelListing(l));await rejected(()=>market.connect(buyer).buy(l));
    const next=await listing(artist,id);await paid(nft.connect(artist).setApprovalForAll(M,false));await rejected(()=>market.connect(buyer).buy(next));
    await paid(nft.connect(artist).setApprovalForAll(M,true));await paid(market.setPaymentTokenEnabled(T,false));
    await paid(market.connect(buyer).buy(next,{gasLimit:1500000}));assert.equal(await nft.ownerOf(id),B);
  });
  await test('N04 auction cancel/no-bid finalize use recoverable claims',async()=>{
    const id=await mint(),a=await auction(artist,id);await paid(market.connect(artist).cancelAuction(a));
    assert.equal(await nft.ownerOf(id),M);assert.equal(await market.auctionNFTClaimant(a),R);await paid(market.connect(artist).claimAuctionNFT(a,R));
    const id2=await mint(),b=await auction(artist,id2);await advance(86401);await paid(market.finalizeAuction(b));await paid(market.connect(artist).claimAuctionNFT(b,R));assert.equal(await nft.ownerOf(id2),R);
  });
  await test('N05 auction buy-now delivers atomically and retains previous bid refund',async()=>{
    const id=await mint(),a=await auction(artist,id,20000);await paid(market.connect(buyer).bid(a,10000));await paid(market.connect(other).buyNowAuction(a));
    assert.equal(await nft.ownerOf(id),O);assert.equal(await market.heldAuctionByNFT(N,id),0n);assert.equal(await market.pendingBidRefunds(T,B),10000n);
    await paid(market.connect(buyer).withdrawBidRefund(T));await paid(market.connect(artist).withdrawProceeds(T,R));await paid(market.withdrawProceeds(T,A));assert.equal(await token.balanceOf(M),0n);
  });
  await test('N06 reentrancy guard prevents a receiver from buying twice',async()=>{
    const id=await mint(),l=await listing(artist,id),receiver=await deploy('AuditMocks.sol','AuditBidder',admin),D=await receiver.getAddress();
    await paid(token.mint(D,10000));await paid(receiver.approve(T,M));await paid(receiver.setRejecting(false));await paid(receiver.buyWithReentry(M,l));
    assert.equal(await receiver.callbackBlocked(),true);assert.equal(await balance(R),9500n);
  });
  await test('N07 taxed deposits revert without consuming listing or buyer balance',async()=>{
    const id=await mint(),l=await listing(artist,id),before=await token.balanceOf(B);await paid(token.setTaxed(true));await rejected(()=>market.connect(buyer).buy(l));
    assert.equal(await token.balanceOf(B),before);assert.equal(await nft.ownerOf(id),R);assert.equal((await market.listings(l))[5],true);
  });
  await test('N08 unauthorized configuration, zero recipients and rate limits rejected',async()=>{
    await rejected(()=>market.connect(buyer).updateFeeBps(1000));await rejected(()=>market.updateFeeBps(2001));await rejected(()=>market.updateRoyaltyBps(2001));
    await paid(market.updateFeeBps(2000));await rejected(()=>market.updateRoyaltyBps(1001));
    const id=await mint(),l=await listing(artist,id);await paid(market.connect(buyer).buy(l));await rejected(()=>market.connect(artist).withdrawProceeds(T,ZERO));
    await rejected(()=>market.connect(artist).withdrawProceeds(T,M));
    await rejected(()=>market.connect(buyer).withdrawProceeds(T,B));
  });
  await test('N09 token minima and immutable floors remain enforced',async()=>{
    const second=await deploy('AuditMocks.sol','AuditToken',admin),S=await second.getAddress();
    await paid(market.configurePaymentToken(S,100,200,50,true));await rejected(()=>market.configurePaymentToken(S,100,200,50,true));
    await rejected(()=>market.updatePaymentTokenMinimum(S,99));await rejected(()=>market.updatePaymentTokenBidIncrement(S,0));
    const id=await mint();await rejected(()=>market.connect(artist).createListing(N,id,199,S));await paid(market.connect(artist).createListing(N,id,200,S));
  });
  await test('N10 overlapping offers, auction bid, proceeds and refunds preserve escrow backing',async()=>{
    const first=await mint(),second=await mint();
    await paid(market.connect(buyer).createOffer(N,first,10000,(await now())+200000,T));
    const offer=await market.nextOfferId(),a=await auction(artist,second);
    await paid(market.connect(buyer).bid(a,10000));await paid(market.connect(other).bid(a,11000));
    const l=await listing(artist,first);await paid(market.connect(collector).buy(l));
    assert.equal(await token.balanceOf(M),41000n);
    assert.equal(await balance(R)+await balance(A)+await market.pendingBidRefunds(T,B)+11000n+10000n,41000n);
    await paid(market.connect(buyer).cancelOffer(offer));await paid(market.connect(buyer).withdrawBidRefund(T));
    await paid(market.connect(artist).withdrawProceeds(T,R));await paid(market.withdrawProceeds(T,A));
    assert.equal(await token.balanceOf(M),11000n);
    await advance(86401);await paid(market.finalizeAuction(a));await paid(market.connect(other).claimAuctionNFT(a,O));
    await paid(market.connect(artist).withdrawProceeds(T,R));await paid(market.withdrawProceeds(T,A));
    assert.equal(await token.balanceOf(M),0n);
  });
  const report={compiler:compiled.compiler,sourceHash:compiled.sourceHash,runtimeBytes:compiled.contracts[file].JNCMarketplace.evm.deployedBytecode.object.length/2,passed:results.filter(x=>x.status==='PASS').length,failed:results.filter(x=>x.status==='FAIL').length,results};
  fs.mkdirSync(path.join(root,'test-results'),{recursive:true});fs.writeFileSync(path.join(root,'test-results/marketplace.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({passed:report.passed,failed:report.failed}));await rpc.disconnect();if(report.failed)process.exitCode=1;
})().catch(async e=>{console.error(e.shortMessage||e.message);process.exitCode=1;await rpc.disconnect();});
