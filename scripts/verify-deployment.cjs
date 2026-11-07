// Read-only verification of an already deployed candidate.
const {ethers,settings,args,rpc,save}=require('./release-common.cjs');
const {compile,file:defaultSource}=require('./build-contracts.cjs');
function strip(hex){const bytes=parseInt(hex.slice(-4),16);return hex.slice(0,hex.length-(bytes+2)*2);}
(async()=>{
  const opts=args(),d=settings().entry(opts.chain);
  const version=opts.version ?? '2.24.0';
  if(!['2.24.0','2.24.1'].includes(version))throw Error('Unsupported Marketplace version');
  const automatic=version==='2.24.1';
  if(automatic && (!d.newMarketplace || d.version!=='2.24.0'))throw Error('Expected an existing 2.24.0 deployment');
  const history=automatic?[d.newMarketplace,...d.legacyMarketplaces]:d.legacyMarketplaces;
  const source=automatic?'contracts/JNCMarketplace_v2.24.1_VerifiedOrigin_AutoSettlement.sol':defaultSource;
  if(!ethers.isAddress(opts.address||''))throw Error('Required: --chain polygon|bnb --address 0x...');
  const target=ethers.getAddress(opts.address);
  if(history.some(x=>x.toLowerCase()===target.toLowerCase()))throw Error('Cannot activate a legacy address');
  if(BigInt(await rpc(d,'eth_chainId'))!==BigInt(d.chainId))throw Error('Wrong chain');
  const block=await rpc(d,'eth_blockNumber'),code=await rpc(d,'eth_getCode',[target,block]);
  const compiled=compile({},source),artifact=compiled.contracts[source].JNCMarketplace,abi=new ethers.Interface(artifact.abi);
  async function view(name,values=[]){return abi.decodeFunctionResult(name,await rpc(d,'eth_call',[{to:target,data:abi.encodeFunctionData(name,values)},block]))[0];}
  let local=strip(artifact.evm.deployedBytecode.object),remote=strip(code.slice(2));
  const expected=ethers.zeroPadValue(history[0],32).slice(2).toLowerCase();
  for(const ref of Object.values(artifact.evm.deployedBytecode.immutableReferences).flat()){
    if(remote.slice(ref.start*2,(ref.start+ref.length)*2).toLowerCase()!==expected)throw Error('Immutable previous marketplace mismatch');
    const mask=x=>x.slice(0,ref.start*2)+'0'.repeat(ref.length*2)+x.slice((ref.start+ref.length)*2);local=mask(local);remote=mask(remote);
  }
  if(local!==remote)throw Error('Executable bytecode does not match the reviewed build');
  if(await view('marketplaceVersion')!==(automatic?22401n:22400n))throw Error('Wrong version');
  if((await view('feeWallet')).toLowerCase()!==d.feeWallet.toLowerCase())throw Error('Fee wallet mismatch');
  if(await view('feeBps')!==500n||await view('royaltyBps')!==1000n)throw Error('Unexpected fee/royalty rates');
  if(Number(await view('legacyMarketplaceCount'))!==history.length)throw Error('Legacy source count mismatch');
  for(let i=0;i<history.length;i++)if((await view('legacyMarketplaces',[i])).toLowerCase()!==history[i].toLowerCase())throw Error('Legacy source mismatch');
  const newPositionsEnabled=await view('newPositionsEnabled');
  save('verified-'+opts.chain+(automatic?'-2.24.1':'')+'.json',{version,status:'CODE_AND_SETTINGS_VERIFIED_NOT_RELEASE_APPROVAL',chainId:d.chainId,block,target,sourceHash:compiled.sourceHash,runtimeCodeHash:ethers.keccak256(code),newPositionsEnabled,configCandidate:{...d,version,legacyMarketplaces:history,legacyVersions:automatic?[d.version,...d.legacyVersions]:d.legacyVersions,newMarketplace:target,runtimeCodeHash:ethers.keccak256(code),ready:false},remaining:['Verify token settings, origin ledger and old liabilities.','Keep ready=false until final release review.']});
})().catch(e=>{console.error(e.message);process.exitCode=1;});
