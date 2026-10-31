// Initial read-only inventory. Refund address coverage is explicitly partial.
const {ethers,settings,args,rpc,save}=require('./release-common.cjs');
const abi=new ethers.Interface([
  'function nextTokenId() view returns(uint256)','function ownerOf(uint256) view returns(address)',
  'function nextListingId() view returns(uint256)','function nextOfferId() view returns(uint256)','function nextAuctionId() view returns(uint256)',
  'function originRegistered(address,uint256) view returns(bool)','function originalCreator(address,uint256) view returns(address)','function primarySaleCompleted(address,uint256) view returns(bool)',
  'function listings(uint256) view returns(address,uint256,address,address,uint256,bool)',
  'function offers(uint256) view returns(address,uint256,address,address,uint256,uint64,bool)',
  'function getAuctionCore(uint256) view returns(address,uint256,address,address,uint256,uint256,bool)',
  'function getAuctionBidState(uint256) view returns(uint256,uint256,address,uint64,uint64,uint32)',
  'function pendingBidRefunds(address,address) view returns(uint256)','function balanceOf(address) view returns(uint256)'
]);
(async()=>{
  const opts=args(),d=settings().entry(opts.chain);
  if(BigInt(await rpc(d,'eth_chainId'))!==BigInt(d.chainId))throw Error('Wrong chain');
  const block=await rpc(d,'eth_blockNumber'),blockData=await rpc(d,'eth_getBlockByNumber',[block,false]);
  async function view(target,name,values=[]){return abi.decodeFunctionResult(name,await rpc(d,'eth_call',[{to:target,data:abi.encodeFunctionData(name,values)},block]));}
  const output={status:'INITIAL_INVENTORY_REQUIRES_HISTORY_REVIEW',chainId:d.chainId,block,blockHash:blockData.hash,nft:d.nft,nfts:[],markets:[],warnings:['Historical bid-event enumeration is not performed: refunds are checked only for discovered candidate addresses.','Origin values are unreviewed claims, not authenticated artist identity.','This file is not a transaction or approved migration ledger.']};
  const addresses=new Set([d.feeWallet.toLowerCase()]),tokens=new Set((opts.tokens||'').split(',').filter(Boolean).map(x=>ethers.getAddress(x)));
  const max=Number(opts.limit||1000),total=Number((await view(d.nft,'nextTokenId'))[0]);
  if(total>max)throw Error('NFT enumeration exceeds limit; use --limit explicitly after review');
  for(let id=1;id<=total;id++){
    const row={tokenId:String(id),reviewStatus:'UNREVIEWED',origins:[]};
    try{row.owner=(await view(d.nft,'ownerOf',[id]))[0];addresses.add(row.owner.toLowerCase());}catch(e){row.error=e.message;}
    for(const market of d.legacyMarketplaces){try{const registered=(await view(market,'originRegistered',[d.nft,id]))[0];const origin={marketplace:market,registered};if(registered){origin.creator=(await view(market,'originalCreator',[d.nft,id]))[0];origin.completed=(await view(market,'primarySaleCompleted',[d.nft,id]))[0];addresses.add(origin.creator.toLowerCase());}row.origins.push(origin);}catch(e){row.origins.push({marketplace:market,error:e.message});}}
    output.nfts.push(row);
  }
  for(const target of d.legacyMarketplaces){
    const market={address:target,listings:[],offers:[],auctions:[],refunds:[],tokenBalances:[]};
    for(const [counter,name,key] of [['nextListingId','listings','listings'],['nextOfferId','offers','offers'],['nextAuctionId','getAuctionCore','auctions']]){
      try{const count=Number((await view(target,counter))[0]);if(count>max)throw Error('Enumeration limit exceeded');
        for(let id=1;id<=count;id++){const values=Array.from(await view(target,name,[id]));addresses.add(values[2].toLowerCase());tokens.add(values[3]);const row={id,values};if(key==='auctions'){row.bid=Array.from(await view(target,'getAuctionBidState',[id]));if(row.bid[2]!==ethers.ZeroAddress)addresses.add(row.bid[2].toLowerCase());}market[key].push(row);}
      }catch(e){market[key+'Error']=e.message;}
    }
    output.markets.push(market);
  }
  for(const market of output.markets)for(const token of tokens){
    try{market.tokenBalances.push({token,balance:(await view(token,'balanceOf',[market.address]))[0]});}catch(e){market.tokenBalances.push({token,error:e.message});}
    for(const account of addresses){if(account===ethers.ZeroAddress)continue;try{const amount=(await view(market.address,'pendingBidRefunds',[token,account]))[0];if(amount>0n)market.refunds.push({token,account,amount});}catch(e){market.refundReadError=e.message;break;}}
  }
  output.refundCandidateAddresses=[...addresses];output.tokens=[...tokens];
  output.warnings.push('Payment-token discovery is limited to enumerated positions and explicitly supplied tokens; token registration events require a separate complete review.');
  save('inventory-'+opts.chain+'.json',output);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
