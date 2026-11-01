// Read-only post-registration verification at a fixed block.
const fs=require('node:fs'),path=require('node:path');
const {ethers,settings,args,rpc,save,root}=require('./release-common.cjs');
(async()=>{
  const opts=args(),d=settings().entry(opts.chain);
  if(BigInt(await rpc(d,'eth_chainId'))!==BigInt(d.chainId))throw Error('Wrong chain');
  const evidence=JSON.parse(fs.readFileSync(path.join(root,'artifacts','origin-history-'+opts.chain+'.json'),'utf8'));
  if(evidence.chainId!==d.chainId||evidence.nft.toLowerCase()!==d.nft.toLowerCase())throw Error('Evidence mismatch');
  const abi=new ethers.Interface(['function originRegistered(address,uint256) view returns(bool)','function originalCreator(address,uint256) view returns(address)','function primarySaleCompleted(address,uint256) view returns(bool)','function newPositionsEnabled() view returns(bool)']);
  const block=await rpc(d,'eth_blockNumber');
  async function view(target,name,values=[]){return abi.decodeFunctionResult(name,await rpc(d,'eth_call',[{to:target,data:abi.encodeFunctionData(name,values)},block]))[0];}
  const rows=[];
  for(const row of evidence.rows){
    const args=[d.nft,row.tokenId];
    const [registered,creator,completed,...legacy]=await Promise.all([view(d.newMarketplace,'originRegistered',args),view(d.newMarketplace,'originalCreator',args),view(d.newMarketplace,'primarySaleCompleted',args),...d.legacyMarketplaces.map(m=>view(m,'primarySaleCompleted',args))]);
    rows.push({tokenId:row.tokenId,registered,creator,expectedCreator:row.mintRecipient,creatorMatches:creator.toLowerCase()===row.mintRecipient.toLowerCase(),completed,legacyCompleted:legacy,saleStatePreserved:!legacy.some(Boolean)||completed});
  }
  const pass=rows.every(r=>r.registered&&r.creatorMatches&&r.saleStatePreserved);
  save('origin-verification-'+opts.chain+'.json',{status:pass?'PASS':'MISMATCH',chainId:d.chainId,target:d.newMarketplace,block,newPositionsEnabled:await view(d.newMarketplace,'newPositionsEnabled'),registered:rows.filter(r=>r.registered).length,total:rows.length,rows});
  console.log(JSON.stringify({pass,total:rows.length,registered:rows.filter(r=>r.registered).length,legacySold:rows.filter(r=>r.legacyCompleted.some(Boolean)).length,mismatches:rows.filter(r=>!r.registered||!r.creatorMatches||!r.saleStatePreserved)}));
  if(!pass)process.exitCode=1;
})().catch(e=>{console.error(e.message);process.exitCode=1;});
