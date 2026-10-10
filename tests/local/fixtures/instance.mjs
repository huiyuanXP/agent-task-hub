import { localFixture } from '../fixture.mjs';
const f=await localFixture();
try{
 const headers={authorization:'Bearer '+f.aliceToken,origin:f.origin,'content-type':'application/json'};
 const response=await fetch(f.origin+'/api/records',{method:'POST',headers,body:JSON.stringify({kind:'idea',title:process.argv[2]})});
 if(response.status!==201)throw Error('Native seed failed');
 await response.text();await f.stop();await f.start();
 const records=await (await fetch(f.origin+'/api/records',{headers})).json();
 process.send({file:f.file,dir:f.dir,origin:f.origin,pid:f.pid,owner:f.alice.userId,titles:records.records.filter(r=>r.kind==='idea').map(r=>r.title)});
 process.on('message',async message=>{if(message==='close'){await f.close();process.send({closed:true});process.disconnect();}});
}catch(error){await f.close();throw error;}
