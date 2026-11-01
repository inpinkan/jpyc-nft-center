// Read-only comparison and simulation. Does not send transactions.
const {ethers,settings,args,rpc,save}=require('./release-common.cjs');
(async()=>{
  const opts=args(),d=settings().entry(opts.chain),token=ethers.getAddress(opts.token);
  if(!ethers.isAddress(d.newMarketplace))throw Error('No staged deployment');
  if(BigInt(await rpc(d,'eth_chainId'))!==BigInt(d.chainId))throw Error('Wrong chain');
  const block=await rpc(d,'eth_blockNumber');
  const abi=new ethers.Interface([
    'function paymentTokenConfigs(address) view returns(bool,bool,uint256,uint256,uint256)',
    'function updatePaymentTokenMinimum(address,uint256)',
    'function updatePaymentTokenBidIncrement(address,uint256)',
    'function newPositionsEnabled() view returns(bool)'
  ]);
  async function read(to,name,values=[]){return Array.from(abi.decodeFunctionResult(name,await rpc(d,'eth_call',[{to,data:abi.encodeFunctionData(name,values)},block])));}
  const previous=await read(d.legacyMarketplaces[0],'paymentTokenConfigs',[token]);
  const staged=await read(d.newMarketplace,'paymentTokenConfigs',[token]);
  if(!previous[0]||!staged[0]||previous[2]!==staged[2])throw Error('Configured token and matching floor required');
  const transactions=[];
  for(const [name,index] of [['updatePaymentTokenMinimum',3],['updatePaymentTokenBidIncrement',4]]){
    if(previous[index]===staged[index])continue;
    const tx={from:d.feeWallet,to:d.newMarketplace,data:abi.encodeFunctionData(name,[token,previous[index]]),value:'0x0'};
    await rpc(d,'eth_call',[tx,block]);
    transactions.push({function:name,args:[token,previous[index]],simulation:'PASS',unsignedTransaction:{...tx,chainId:d.chainId}});
  }
  save('staged-token-'+opts.chain+'.json',{status:'READ_ONLY_CHECK_UNSIGNED_PLAN',block,token,previous,staged,newPositionsEnabled:(await read(d.newMarketplace,'newPositionsEnabled'))[0],transactions});
})().catch(e=>{console.error(e.message);process.exitCode=1;});
