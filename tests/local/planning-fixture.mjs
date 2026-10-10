import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
export const secret = 'whsec_' + Buffer.alloc(32, 27).toString('base64');
export async function consumer() {
  const events = [], challenges = [];
  let status = 204, pause;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const id = req.headers['webhook-id'], timestamp = req.headers['webhook-timestamp'];
    const expected = 'v1,' + createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${timestamp}.${body}`).digest('base64');
    assert.ok(req.headers['webhook-signature'].split(' ').includes(expected), 'real HTTP consumer authenticates HMAC');
    const event = JSON.parse(body);
    if (event.type === 'verification') { challenges.push(event); res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({challenge: event.challenge})); return; }
    events.push({id, event, body}); if (pause) await pause;
    res.writeHead(status); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {events, challenges, url: `http://127.0.0.1:${server.address().port}/events`, set status(value) {status=value;}, set pause(value) {pause=value;}, close: () => new Promise(resolve => server.close(resolve))};
}
export async function seedJob(db, owner, id = 'job', revision = 1) {
  const time = new Date().toISOString();
  await db.prepare('INSERT INTO records(id,owner,kind,body,revision,created,updated) VALUES(?,?,\'idea\',?,?,?,?)').bind('idea-'+id,owner,JSON.stringify({title:'Synthetic planner',project:'Local'}),revision,time,time).run();
  const event = {eventId:'evt_'+id+':g0',name:'idea.planning_requested',timestamp:time,data:{idea_id:'idea-'+id,idea_revision:revision,job_id:id,project:'Local'},cursor:null};
  await db.prepare('INSERT INTO jobs(id,owner,idea_id,idea_revision,status,event,created) VALUES(?,?,?,?,\'queued\',?,?)').bind(id,owner,'idea-'+id,revision,JSON.stringify(event),time).run();
  return id;
}
export async function seedSubscription(db, owner, url, id = 'subscription', args = {}) {
  await db.prepare('INSERT INTO subscriptions(id,owner,body,expires) VALUES(?,?,?,?)').bind(id,owner,JSON.stringify({id,url,secret,args}),Date.now()+86400000).run();
}
export async function waitFor(predicate, ms = 5000) {
  const until = Date.now()+ms;
  while (Date.now()<until) { if (await predicate()) return; await new Promise(resolve=>setTimeout(resolve,25)); }
  assert.ok(await predicate(), 'expected persisted planner progress before deadline');
}
