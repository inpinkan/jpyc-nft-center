// Applies JNC's operator-confirmed self-mint policy to evidence. Never signs or sends.
const fs=require('node:fs'),path=require('node:path');
const {ethers,settings,args,rpc,save,root}=require('./release-common.cjs');
(async()=>{
  const opts=args(),d={...settings().entry(opts.chain)};
  if(opts.rpc)d.rpc=opts.rpc;
  if(BigInt(await rpc(d,'eth_chainId'))!==BigInt(d.chainId))throw Error('Wrong chain');
  const evidence=JSON.parse(fs.readFileSync(path.join(root,'artifacts','origin-history-'+opts.chain+'.json'),'utf8'));
  if(evidence.chainId!==d.chainId||evidence.nft.toLowerCase()!==d.nft.toLowerCase())throw Error('Evidence chain/NFT mismatch');
  const abi=new ethers.Interface(['function registerNFTOrigin(address,uint256,address,bool)','function originRegistered(address,uint256) view returns(bool)']);
  const rows=[];
  for(const row of evidence.rows){
    const tx=await rpc(d,'eth_getTransactionByHash',[row.mintTransaction]);
    const candidate={tokenId:row.tokenId,creator:row.mintRecipient,mintTransaction:row.mintTransaction,mintCaller:tx?.from,mintTarget:tx?.to,directSelfMint:row.directSelfMint};
    const callerMatches=tx?.from?.toLowerCase()===row.mintRecipient?.toLowerCase();
    if(!row.receiptVerified||!callerMatches||row.originConflicts?.length){candidate.status='REQUIRES_EXCEPTION_REVIEW';rows.push(candidate);continue;}
    const registeredRaw=await rpc(d,'eth_call',[{to:d.newMarketplace,data:abi.encodeFunctionData('originRegistered',[d.nft,row.tokenId])},'latest']);
    if(abi.decodeFunctionResult('originRegistered',registeredRaw)[0]){candidate.status='ALREADY_REGISTERED_REQUIRES_VALUE_CHECK';rows.push(candidate);continue;}
    // false does not override any completed sale: the deployed contract ORs historical sale state.
    const args=[d.nft,row.tokenId,row.mintRecipient,false];
    const unsignedTransaction={from:d.feeWallet,to:d.newMarketplace,data:abi.encodeFunctionData('registerNFTOrigin',args),value:'0x0'};
    await rpc(d,'eth_call',[unsignedTransaction,'latest']);
    Object.assign(candidate,{status:'POLICY_MATCH_SIMULATION_PASS_NOT_SENT',args,unsignedTransaction:{...unsignedTransaction,chainId:d.chainId}});
    rows.push(candidate);
  }
  save('origin-migration-'+opts.chain+'.json',{status:'UNSIGNED_NOT_REGISTERED',policy:'JNC operator confirmed: self-mint recipient is fixed Creator; do not replace with current owner.',chainId:d.chainId,target:d.newMarketplace,rows,warnings:['On-chain evidence does not prove copyright ownership.','Historical sale state remains checked by the deployed contract; false is not proof of no external sales.','No wallet approval, registration, or broadcast performed.']});
})().catch(e=>{console.error(e.message);process.exitCode=1;});
