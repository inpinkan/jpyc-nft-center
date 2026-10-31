// Read-only verification of an already deployed candidate.
const {ethers,settings,args,rpc,save}=require('./release-common.cjs');
const {compile,file}=require('./build-contracts.cjs');
function strip(hex){const bytes=parseInt(hex.slice(-4),16);return hex.slice(0,hex.length-(bytes+2)*2);}
(async()=>{
  const opts=args(),d=settings().entry(opts.chain);
  if(!ethers.isAddress(opts.address||''))throw Error('Required: --chain polygon|bnb --address 0x...');
  const target=ethers.getAddress(opts.address);
  if(d.legacyMarketplaces.some(x=>x.toLowerCase()===target.toLowerCase()))throw Error('Cannot activate a legacy address');
  if(BigInt(await rpc(d,'eth_chainId'))!==BigInt(d.chainId))throw Error('Wrong chain');
  const block=await rpc(d,'eth_blockNumber'),code=await rpc(d,'eth_getCode',[target,block]);
  const compiled=compile(),artifact=compiled.contracts[file].JNCMarketplace,abi=new ethers.Interface(artifact.abi);
  async function view(name,values=[]){return abi.decodeFunctionResult(name,await rpc(d,'eth_call',[{to:target,data:abi.encodeFunctionData(name,values)},block]))[0];}
  let local=strip(artifact.evm.deployedBytecode.object),remote=strip(code.slice(2));
  const expected=ethers.zeroPadValue(d.legacyMarketplaces[0],32).slice(2).toLowerCase();
  for(const ref of Object.values(artifact.evm.deployedBytecode.immutableReferences).flat()){
    if(remote.slice(ref.start*2,(ref.start+ref.length)*2).toLowerCase()!==expected)throw Error('Immutable previous marketplace mismatch');
    const mask=x=>x.slice(0,ref.start*2)+'0'.repeat(ref.length*2)+x.slice((ref.start+ref.length)*2);local=mask(local);remote=mask(remote);
  }
  if(local!==remote)throw Error('Executable bytecode does not match the reviewed build');
  if(await view('marketplaceVersion')!==22400n)throw Error('Wrong version');
  if((await view('feeWallet')).toLowerCase()!==d.feeWallet.toLowerCase())throw Error('Fee wallet mismatch');
  if(await view('feeBps')!==500n||await view('royaltyBps')!==1000n)throw Error('Unexpected fee/royalty rates');
  if(Number(await view('legacyMarketplaceCount'))!==d.legacyMarketplaces.length)throw Error('Legacy source count mismatch');
  for(let i=0;i<d.legacyMarketplaces.length;i++)if((await view('legacyMarketplaces',[i])).toLowerCase()!==d.legacyMarketplaces[i].toLowerCase())throw Error('Legacy source mismatch');
  const newPositionsEnabled=await view('newPositionsEnabled');
  save('verified-'+opts.chain+'.json',{status:'CODE_AND_SETTINGS_VERIFIED_NOT_RELEASE_APPROVAL',chainId:d.chainId,block,target,sourceHash:compiled.sourceHash,runtimeCodeHash:ethers.keccak256(code),newPositionsEnabled,configCandidate:{...d,newMarketplace:target,runtimeCodeHash:ethers.keccak256(code),ready:false},remaining:['Verify token settings, origin ledger and old liabilities.','Keep ready=false until final release review.']});
})().catch(e=>{console.error(e.message);process.exitCode=1;});
