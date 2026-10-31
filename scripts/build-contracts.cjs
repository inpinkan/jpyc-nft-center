const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const solc=require('solc');
const root=path.resolve(__dirname,'..');
const file='contracts/JNCMarketplace_v2.24.0_VerifiedOrigin_ClaimSettlement.sol';
function compile(extraSources={}) {
  const source=fs.readFileSync(path.join(root,file),'utf8');
  const settings={optimizer:{enabled:true,runs:200},evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode','evm.deployedBytecode']}}};
  const input={language:'Solidity',sources:{[file]:{content:source},...extraSources},settings};
  const output=JSON.parse(solc.compile(JSON.stringify(input)));
  const errors=(output.errors||[]).filter(e=>e.severity==='error');
  if(errors.length)throw Error(errors.map(e=>e.formattedMessage).join('\n'));
  return {contracts:output.contracts,input,compiler:solc.version(),sourceHash:crypto.createHash('sha256').update(source).digest('hex')};
}
if(require.main===module){
  const result=compile(),artifact=result.contracts[file].JNCMarketplace;
  if(artifact.evm.deployedBytecode.object.length/2>24576)throw Error('Contract exceeds runtime size limit');
  fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});
  fs.writeFileSync(path.join(root,'artifacts/JNCMarketplace.json'),JSON.stringify({compiler:result.compiler,sourceHash:result.sourceHash,...artifact},null,2)+'\n');
  fs.writeFileSync(path.join(root,'artifacts/standard-input.json'),JSON.stringify(result.input,null,2)+'\n');
  console.log('Built JNCMarketplace 2.24.0; runtime '+artifact.evm.deployedBytecode.object.length/2+' bytes');
}
module.exports={compile,file,root};
