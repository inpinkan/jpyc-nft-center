// Read-only Mint evidence ledger. Mint recipient is a candidate, not proof of authorship.
const fs=require('node:fs');
const path=require('node:path');
const {ethers,settings,args,rpc,save,root}=require('./release-common.cjs');
(async()=>{
  const opts=args(),d={...settings().entry(opts.chain)};
  if(opts.rpc){if(!opts.rpc.startsWith('https://'))throw Error('HTTPS RPC required');d.rpc=opts.rpc;}
  if(BigInt(await rpc(d,'eth_chainId'))!==BigInt(d.chainId))throw Error('Wrong chain');
  const latest=await rpc(d,'eth_blockNumber'),end=Number(BigInt(latest));
  let lo=0,hi=end;
  while(lo<hi){const mid=Math.floor((lo+hi)/2);const code=await rpc(d,'eth_getCode',[d.nft,ethers.toQuantity(mid)]);if(code==='0x')lo=mid+1;else hi=mid;}
  const first=lo,logs=[],ranges=[];
  for(let start=first;start<=end;start+=10000)ranges.push([start,Math.min(start+9999,end)]);
  console.log('NFT deployed at '+first+'; scanning '+ranges.length+' ranges');
  let cursor=0,completed=0;
  async function fetchRange(start,stop){
    try{return await rpc(d,'eth_getLogs',[{address:d.nft,fromBlock:ethers.toQuantity(start),toBlock:ethers.toQuantity(stop),topics:[ethers.id('Transfer(address,address,uint256)'),ethers.ZeroHash]}]);}
    catch(e){if(/range|limit|too many/i.test(e.message)&&stop-start>=100){const mid=Math.floor((start+stop)/2);return [...await fetchRange(start,mid),...await fetchRange(mid+1,stop)];}throw e;}
  }
  await Promise.all(Array.from({length:4},async()=>{
    while(cursor<ranges.length){const [start,stop]=ranges[cursor++];let result;
      for(let attempt=0;attempt<3;attempt++){try{result=await fetchRange(start,stop);break;}catch(e){if(attempt===2)throw e;}}
      logs.push(...result);completed++;if(completed%100===0)console.log(completed+'/'+ranges.length+' ranges');
    }
  }));
  logs.sort((a,b)=>Number(BigInt(a.blockNumber)-BigInt(b.blockNumber))||Number(BigInt(a.logIndex)-BigInt(b.logIndex)));
  const inventory=JSON.parse(fs.readFileSync(path.join(root,'artifacts','inventory-'+opts.chain+'.json'),'utf8'));
  const mintABI=new ethers.Interface(['function mint(address,string)']);
  const rows=[];
  for(const nft of inventory.nfts){
    const matches=logs.filter(l=>BigInt(l.topics[3]).toString()===nft.tokenId);
    const row={tokenId:nft.tokenId,currentOwner:nft.owner,oldOrigins:nft.origins,reviewStatus:'REQUIRES_OPERATOR_AUTHORSHIP_REVIEW'};
    if(matches.length!==1){row.error='Expected exactly one Mint log, got '+matches.length;rows.push(row);continue;}
    const log=matches[0],receipt=await rpc(d,'eth_getTransactionReceipt',[log.transactionHash]),tx=await rpc(d,'eth_getTransactionByHash',[log.transactionHash]);
    row.mintRecipient=ethers.getAddress('0x'+log.topics[2].slice(-40));row.mintTransaction=log.transactionHash;row.mintBlock=log.blockNumber;row.mintBlockHash=log.blockHash;
    row.receiptVerified=receipt?.status==='0x1'&&receipt.blockHash===log.blockHash&&receipt.logs.some(l=>l.address.toLowerCase()===d.nft.toLowerCase()&&l.logIndex===log.logIndex&&l.topics.join()===log.topics.join());
    try{const decoded=mintABI.parseTransaction({data:tx.input});row.directSelfMint=tx.to?.toLowerCase()===d.nft.toLowerCase()&&tx.from.toLowerCase()===row.mintRecipient.toLowerCase()&&decoded.args[0].toLowerCase()===row.mintRecipient.toLowerCase();}catch{row.directSelfMint=false;}
    row.originConflicts=nft.origins.filter(o=>o.registered&&o.creator.toLowerCase()!==row.mintRecipient.toLowerCase());
    rows.push(row);
  }
  save('origin-history-'+opts.chain+'.json',{status:'EVIDENCE_ONLY_NOT_APPROVED_FOR_REGISTRATION',chainId:d.chainId,rpc:d.rpc,nft:d.nft,deploymentBlock:first,throughBlock:latest,completeMintLogScan:true,rows,warnings:['Mint recipient and direct caller do not prove legal authorship or copyright ownership.','No registration transactions were sent.','Historical resale events outside the configured markets are not covered.']});
})().catch(e=>{console.error(e.message);process.exitCode=1;});
