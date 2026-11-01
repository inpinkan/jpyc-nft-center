const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
(async()=>{
  for(const name of ['save-state','save-collaboration']){
    const source=fs.readFileSync(require('node:path').join(__dirname,'..','api',name+'.js'),'utf8').replace('export default async function handler','async function handler');
    for(const env of ['preview','production']){
      let calls=0;const ctx={process:{env:{VERCEL_ENV:env}},fetch:()=>{calls++;throw Error('Unexpected network call');}};
      vm.createContext(ctx);vm.runInContext(source,ctx);
      const response={setHeader(){},status(n){this.code=n;return this;},json(x){this.body=x;return this;},end(){return this;}};
      await ctx.handler({method:'POST',headers:{},body:{}},response);
      assert.equal(response.code,env==='preview'?403:name==='save-state'?400:401);assert.equal(calls,0);
    }
    console.log('PASS '+name+': preview writes blocked, production validation preserved');
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
