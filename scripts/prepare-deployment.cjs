// Produces an unsigned deployment plan. Never signs or broadcasts transactions.
const {ethers,settings,args,rpc,save}=require('./release-common.cjs');
const {compile,file}=require('./build-contracts.cjs');
(async()=>{
  const opts=args(),d=settings().entry(opts.chain);
  if(!ethers.isAddress(opts.token||''))throw Error('Required: --chain polygon|bnb --token 0x...');
  const chain=await rpc(d,'eth_chainId');if(BigInt(chain)!==BigInt(d.chainId))throw Error('Wrong RPC chain');
  const tokenCode=await rpc(d,'eth_getCode',[opts.token,'latest']);if(tokenCode==='0x')throw Error('Token has no code');
  const abi=new ethers.Interface(['function decimals() view returns(uint8)']);
  const raw=await rpc(d,'eth_call',[{to:opts.token,data:abi.encodeFunctionData('decimals')},'latest']);
  const decimals=Number(abi.decodeFunctionResult('decimals',raw)[0]);
  const previousABI=new ethers.Interface(['function paymentTokenConfigs(address) view returns(bool,bool,uint256,uint256,uint256)']);
  const previousRaw=await rpc(d,'eth_call',[{to:d.legacyMarketplaces[0],data:previousABI.encodeFunctionData('paymentTokenConfigs',[opts.token])},'latest']);
  const config=previousABI.decodeFunctionResult('paymentTokenConfigs',previousRaw);
  if(!config[0])throw Error('Initial migration token must already be configured in the current market');
  const floor=opts.floor?ethers.parseUnits(opts.floor,decimals):config[2];
  if(floor!==config[2])throw Error('Floor differs from the existing immutable floor');
  if(floor<=0n)throw Error('Floor must be positive');
  const constructorArgs=[ethers.getAddress(opts.token),ethers.getAddress(d.feeWallet),500,1000,floor,d.legacyMarketplaces[0],d.legacyMarketplaces.slice(1)];
  const compiled=compile(),artifact=compiled.contracts[file].JNCMarketplace;
  const factory=new ethers.ContractFactory(artifact.abi,artifact.evm.bytecode.object);
  const tx=await factory.getDeployTransaction(...constructorArgs);
  save('deployment-'+opts.chain+'.json',{status:'UNSIGNED_NOT_DEPLOYED',chainId:d.chainId,chain:opts.chain,compiler:compiled.compiler,sourceHash:compiled.sourceHash,settings:compiled.input.settings,tokenDecimals:decimals,expectedTokenConfig:{token:opts.token,enabled:config[1],floor:config[2],minimum:config[3],bidIncrement:config[4]},constructorArgs,unsignedTransaction:{data:tx.data,value:'0',chainId:d.chainId},newPositionsEnabledOnDeployment:false,notes:['Review all creator data and old liabilities before opening.','Constructor sets minimum and bid increment to floor: synchronize reviewed values before reopening.','No signing or broadcast is performed by this script.']});
})().catch(e=>{console.error(e.message);process.exitCode=1;});
