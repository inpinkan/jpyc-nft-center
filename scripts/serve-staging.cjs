// Local static preview only. APIs are blocked to prevent production writes.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const files=new Set(['index.html','jnc_admin_center_v0.2.html','marketplace-tools.html','marketplace-tools.js','deployment-config.js','release.js','vendor/ethers.umd.min.js','migration/polygon-origins.json','migration/bnb-origins.json','jnc-og-image.png']);
http.createServer((req,res)=>{
  if(req.method!=='GET'){res.writeHead(405).end();return;}
  const name=new URL(req.url,'http://localhost').pathname.slice(1)||'marketplace-tools.html';
  if(!files.has(name)){res.writeHead(404).end();return;}
  const type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.png':'image/png'}[path.extname(name)];
  fs.readFile(path.join(root,name),(err,data)=>{if(err){res.writeHead(404).end();return;}res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data);});
}).listen(8787,'127.0.0.1',()=>console.log('Local preview: http://127.0.0.1:8787/marketplace-tools.html (production APIs blocked)'));
