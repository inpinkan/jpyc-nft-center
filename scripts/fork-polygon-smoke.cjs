// Transactions run ONLY in an in-memory Ganache fork, never on the public RPC.
const assert=require('node:assert/strict');
const ganache=require('ganache');
const {ethers,settings,save}=require('./release-common.cjs');
const {compile,file}=require('./build-contracts.cjs');
(async()=>{
  const d=settings().entry('polygon'),token='0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
  const sellers=['0x2C3C93c609e1040E1A14BA2b4bf6BCad955e88E9','0xEc6554e6e845e76ADeFb64959EeCd3b7FE02B6a0'];
  const local=ganache.provider({logging:{quiet:true},fork:{url:'https://polygon.gateway.tenderly.co'},chain:{hardfork:'shanghai'},wallet:{unlockedAccounts:[d.feeWallet,...sellers]}});
  try{
    const provider=new ethers.BrowserProvider(local);provider.pollingInterval=20;
    const artifact=compile().contracts[file].JNCMarketplace;
    const admin=await provider.getSigner(d.feeWallet),market=new ethers.Contract(d.newMarketplace,artifact.abi,admin);
    const nft=new ethers.Contract(d.nft,['function ownerOf(uint256) view returns(address)','function approve(address,uint256)'],admin);
    const erc20=new ethers.Contract(token,['function approve(address,uint256) returns(bool)','function balanceOf(address) view returns(uint256)'],admin);
    const paid=async tx=>(await tx).wait();
    for(const addr of [d.feeWallet,...sellers])await local.request({method:'evm_setAccountBalance',params:[addr,ethers.toQuantity(ethers.parseEther('100'))]});
    assert.equal(await market.newPositionsEnabled(),false);
    await paid(market.setNewPositionsEnabled(true));
    await paid(erc20.approve(d.newMarketplace,ethers.MaxUint256));
    const results=[];
    for(const [id,seller,resale] of [[15,sellers[0],true],[38,sellers[1],false]]){
      assert.equal((await nft.ownerOf(id)).toLowerCase(),seller.toLowerCase());
      assert.equal(await market.originRegistered(d.nft,id),true);
      assert.equal(await market.primarySaleCompleted(d.nft,id),resale);
      const creator=await market.originalCreator(d.nft,id),signer=await provider.getSigner(seller),price=ethers.parseUnits('100',18);
      await paid(nft.connect(signer).approve(d.newMarketplace,id));
      const old=new ethers.Contract(d.legacyMarketplaces[0],['function listingIdByNFT(address,uint256) view returns(uint256)','function cancelListing(uint256)'],signer);
      const oldId=await old.listingIdByNFT(d.nft,id);
      if(oldId>0n)await paid(old.cancelListing(oldId));
      await paid(market.connect(signer).createListing(d.nft,id,price,token));
      const listingId=await market.nextListingId();
      const addresses=[...new Set([seller,creator,d.feeWallet].map(a=>a.toLowerCase()))];
      const before=Object.fromEntries(await Promise.all(addresses.map(async a=>[a,await market.pendingProceeds(token,a)])));
      await paid(market.buy(listingId));
      assert.equal((await nft.ownerOf(id)).toLowerCase(),d.feeWallet.toLowerCase());
      const expected={};const add=(a,n)=>expected[a.toLowerCase()]=(expected[a.toLowerCase()]||0n)+n;
      add(seller,price*BigInt(resale?85:95)/100n);add(d.feeWallet,price*5n/100n);if(resale)add(creator,price/10n);
      for(const a of addresses)assert.equal(await market.pendingProceeds(token,a)-before[a],expected[a]||0n);
      const balanceBefore=await erc20.balanceOf(seller);
      await paid(market.connect(signer).withdrawProceeds(token,seller));
      assert.equal(await market.pendingProceeds(token,seller),0n);
      assert.equal(await erc20.balanceOf(seller)-balanceBefore,before[seller.toLowerCase()]+expected[seller.toLowerCase()]);
      assert.equal((await market.originalCreator(d.nft,id)).toLowerCase(),creator.toLowerCase());
      results.push({tokenId:id,resale,status:'PASS',checks:['approval','old listing cancellation','new listing','purchase','owner transfer','distribution','seller withdrawal','fixed creator']});
    }
    save('fork-polygon-smoke.json',{status:'LOCAL_FORK_ONLY_PASS',publicTransactionsSent:0,results});
  }finally{await local.disconnect();}
})().catch(e=>{console.error(e.shortMessage||e.message);process.exitCode=1;});
