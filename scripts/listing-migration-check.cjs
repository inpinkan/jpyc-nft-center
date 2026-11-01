const fs=require('node:fs'),path=require('node:path');
const {ethers,settings,args,rpc,save,root}=require('./release-common.cjs');
(async()=>{
  const opts=args(),d=settings().entry(opts.chain),inventory=JSON.parse(fs.readFileSync(path.join(root,'artifacts','inventory-'+opts.chain+'.json'),'utf8'));
  if(BigInt(await rpc(d,'eth_chainId'))!==BigInt(d.chainId))throw Error('Wrong chain');
  const block=await rpc(d,'eth_blockNumber');
  const abi=new ethers.Interface(['function ownerOf(uint256) view returns(address)','function getApproved(uint256) view returns(address)','function isApprovedForAll(address,address) view returns(bool)']);
  async function view(to,name,values){return abi.decodeFunctionResult(name,await rpc(d,'eth_call',[{to,data:abi.encodeFunctionData(name,values)},block]))[0];}
  const rows=[];
  for(const market of inventory.markets)for(const l of market.listings.filter(l=>l.values[5])){
    const [nft,id,seller,token,price]=l.values;
    const row={marketplace:market.address,listingId:l.id,nft,tokenId:id,seller,paymentToken:token,price};
    try{
      const [owner,approved,all]=await Promise.all([view(nft,'ownerOf',[id]),view(nft,'getApproved',[id]),view(nft,'isApprovedForAll',[seller,market.address])]);
      Object.assign(row,{owner,approved,operatorApproved:all,sellerStillOwns:owner.toLowerCase()===seller.toLowerCase(),transferApproval:all||approved.toLowerCase()===market.address.toLowerCase()});
      row.appearsTransferable=row.sellerStillOwns&&row.transferApproval;
    }catch(e){row.error=e.message;}
    rows.push(row);
  }
  save('listing-migration-'+opts.chain+'.json',{block,inventoryBlock:inventory.block,rows,warnings:['A read-only ownership and approval check is not a guarantee of purchase success.','No listings or approvals were cancelled. Owners must authorize their own changes.']});
})().catch(e=>{console.error(e.message);process.exitCode=1;});
