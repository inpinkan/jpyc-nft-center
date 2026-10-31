const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {ethers}=require('ethers');
const root=path.resolve(__dirname,'..');
function settings(){const ctx={window:{ethers},ethers,console};vm.createContext(ctx);for(const f of ['deployment-config.js','release.js'])vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx);return ctx.window.JNCRelease;}
function args(){const out={};for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i].startsWith('--')||process.argv[i+1]===undefined)throw Error('Use --name value');out[process.argv[i].slice(2)]=process.argv[i+1];}return out;}
async function rpc(d,method,params=[]){const res=await fetch(d.rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)});const data=await res.json();if(data.error||data.result===undefined)throw Error(data.error?.message||'Missing RPC result');return data.result;}
function save(name,value){const dir=path.join(root,'artifacts');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,name);fs.writeFileSync(file,JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');console.log(file);return file;}
module.exports={root,ethers,settings,args,rpc,save};
