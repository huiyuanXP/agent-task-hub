import { request } from 'node:http';
import { existsSync } from 'node:fs';
export async function requireDocker(){
 if(!existsSync('/var/run/docker.sock'))throw Error('Real Docker prerequisite unavailable: /var/run/docker.sock is required; the mandatory Docker suite did not run.');
 try{
  await new Promise((resolve,reject)=>{
   const req=request({socketPath:'/var/run/docker.sock',path:'/_ping',method:'GET',timeout:3000},res=>{
    let bytes=0,body='';res.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024)req.destroy(Error('Unbounded Docker prerequisite reply'));else body+=chunk;});
    res.on('end',()=>res.statusCode===200&&body==='OK'?resolve():reject(Error('Docker daemon did not answer its local health check')));
   });
   req.on('timeout',()=>req.destroy(Error('Docker prerequisite timed out')));req.on('error',reject);req.end();
  });
 }catch(cause){throw Error('Real Docker prerequisite unavailable: the explicit local daemon must answer before mandatory execution checks run.',{cause});}
}
