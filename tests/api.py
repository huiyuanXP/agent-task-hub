"""Synthetic loopback-only integration checks; no provider calls or secrets."""
import json, os, re, urllib.request, urllib.error
from urllib.parse import urlsplit
from pathlib import Path
def loopback_url(value):
    assert re.fullmatch(r'http://(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?/?', value), 'HTTP loopback URL required'
    parsed = urlsplit(value)
    assert parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost', '::1'), 'HTTP loopback URL required'
    assert parsed.username is None and parsed.password is None, 'Credentials forbidden'
    assert parsed.path in ('', '/') and not parsed.query and not parsed.fragment, 'Origin required'
    assert parsed.port is None or 0 < parsed.port <= 65535, 'Invalid port'
    return parsed.scheme + '://' + parsed.netloc
DEV=loopback_url(os.environ['TEST_DEV_URL'])
PREVIEW=loopback_url(os.environ['TEST_PREVIEW_URL'])
OUT=Path(os.environ['TEST_ARTIFACT_DIR'])
OUT.mkdir(parents=True, exist_ok=True)
checks=[]
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args): return None
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
def request(base,path,method='GET',body=None,headers=None,status=200):
    assert loopback_url(base) in [DEV,PREVIEW]
    assert path.startswith('/') and not path.startswith('//'), 'Relative application path required'
    h=dict(headers or {})
    data=None if body is None else json.dumps(body).encode()
    if data is not None: h.setdefault('Content-Type','application/json')
    req=urllib.request.Request(base+path,data=data,headers=h,method=method)
    try: response=opener.open(req,timeout=30)
    except urllib.error.HTTPError as e: response=e
    raw=response.read().decode(); code=response.code
    assert code==status,(path,code,status,raw[:400])
    value=json.loads(raw) if 'application/json' in response.headers.get('Content-Type','') else raw
    return value,response.headers
def ok(name): checks.append(name); print('PASS:',name,flush=True)
def rpc(name,args=None,headers=None,error=None,base=DEV,method='tools/call'):
    params={'name':name,'arguments':args or {}} if method=='tools/call' else (args or {})
    result,_=request(base,'/mcp','POST',{'jsonrpc':'2.0','id':len(checks)+1,'method':method,'params':params},headers)
    if error is not None:
        assert result['error']['code']==error,result
        return result['error']
    assert 'error' not in result,result
    return result['result'].get('structuredContent',result['result'])
def save(body,status=201,headers=None):
    return request(DEV,'/api/records','POST',body,headers or AUTH,status)[0]
try:
    for base in [DEV,PREVIEW]:
        html,_=request(base,'/')
        assert 'AGENT TASK HUB' in html and 'lang="zh-CN"' in html
        assert '点子工坊' in html
        request(base,'/favicon.svg')
        for path in ['/api/records','/api/planning']: request(base,path,status=401)
        request(base,'/mcp',status=401)
        request(base,'/mcp','POST',{'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'list_planning_jobs'}},headers={'Origin':base},status=401)
        _,discovery_login=request(base,'/api/auth/login','POST',{'username':'alice','password':'synthetic-password'},{'Origin':base})
        discovery_auth={'Cookie':discovery_login['Set-Cookie'].split(';')[0],'Origin':base}
        info=rpc('',method='initialize',base=base,headers=discovery_auth)
        assert info['capabilities']['tools']=={} and info['capabilities']['events']=={}
        tools=rpc('',method='tools/list',base=base,headers=discovery_auth)['tools']
        assert {'create_idea','get_idea','list_planning_jobs','claim_planning_job','save_plan_and_tickets'} <= {tool['name'] for tool in tools}
        ok(('dev' if base==DEV else 'built preview')+' HTML/assets, anonymous API/MCP denial, MCP discovery')
    spoof={'oai-authenticated-user-id':'validation_spoof','oai-authenticated-user-email':'spoof@example.test'}
    request(DEV,'/api/records',headers=spoof,status=401)
    request(DEV,'/signin')
    request(DEV,'/api/auth/login','POST',{'username':'alice','password':'wrong'}, {'Origin':DEV},401)
    _,h=request(DEV,'/api/auth/login','POST',{'username':'alice','password':'synthetic-password'},{'Origin':DEV})
    cookie=h['Set-Cookie'].split(';')[0]
    assert 'HttpOnly' in h['Set-Cookie'] and 'SameSite=Strict' in h['Set-Cookie']
    AUTH={'Cookie':cookie,'Origin':DEV}
    ok('real local password login denies invalid passwords and issues private same-origin session')
    empty,_=request(DEV,'/api/records',headers=AUTH); assert empty['records']==[],empty
    planning,_=request(DEV,'/api/planning',headers=AUTH); assert planning=={'jobs':[],'subscriptions':0},planning
    request(PREVIEW,'/api/records',headers={'Cookie':cookie},status=401)
    ok('authenticated fresh DB empty; independent production database rejects other instance session')
    save({'kind':'idea','title':'No origin'},403,{'Cookie':cookie})
    save({'kind':'idea','title':'Bad origin'},403,{'Cookie':cookie,'Origin':'https://example.test'})
    save({'kind':'idea','title':''},400)
    save({'kind':'ticket','title':'Invalid status','status':'invalid'},400)
    save({'kind':'ticket','title':'Waiting without reason','status':'waiting'},400)
    save({'kind':'ticket','title':'Done without evidence','status':'done'},400)
    save({'kind':'ticket','title':'Missing plan','status':'todo','planId':'missing'},400)
    save({'kind':'run','title':'Missing ticket','ticketId':'missing'},400)
    ok('records reject invalid input, cross-origin writes and broken references')
    idea={'kind':'idea','title':'Native synthetic idea','text':'Local verification only','project':'Native validation'}
    created=save(idea); idea_id=created['id']; assert created['revision']==1
    planjob,_=request(DEV,'/api/planning','POST',{'ideaId':idea_id},AUTH)
    assert planjob['job']['delivery']=='no_subscription'
    changed=save({**idea,'id':idea_id,'revision':1,'title':'Native synthetic idea revision 2'},200)
    assert changed['revision']==2
    automatic=rpc('list_planning_jobs',headers=AUTH)['jobs']
    current=[job for job in automatic if job['idea_id']==idea_id and job['idea_revision']==2]
    assert len(current)==1,('Saved idea revision must automatically enqueue exactly one job',current)
    assert current[0]['status']=='queued' and current[0]['delivery']=='no_subscription',current
    save({**idea,'id':idea_id,'revision':1},409)
    records,_=request(DEV,'/api/records',headers=AUTH)
    history=[r for r in records['records'] if r['kind']=='history' and r['recordId']==idea_id]
    assert len(history)==1 and history[0]['snapshot']['title']==idea['title']
    request(DEV,'/api/planning','POST',{'ideaId':idea_id},{'Cookie':cookie},403)
    request(DEV,'/api/planning','POST',{'ideaId':'missing'},AUTH,404)
    request(DEV,'/api/planning','POST',{'ideaId':idea_id},AUTH)
    jobs=rpc('list_planning_jobs',headers=AUTH)['jobs']; old=next(j for j in jobs if j['idea_revision']==1)
    assert old['status']=='superseded'
    rpc('claim_planning_job',{'job_id':old['id']},AUTH,error=-32602)
    ok('idea/job creation, revision conflict, history snapshot and superseded job protection')
    args={'request_id':'vm1-initial-validation','title':'Native synthetic MCP idea','text':'Planning only','project':'Native validation'}
    mcp_idea=rpc('create_idea',args,AUTH); retry=rpc('create_idea',args,AUTH)
    assert mcp_idea['idea_id']==retry['idea_id'] and mcp_idea['job_id']==retry['job_id']
    assert mcp_idea['delivery']=='no_subscription'
    got=rpc('get_idea',{'idea_id':mcp_idea['idea_id']},AUTH); assert got['revision']==1
    claim=rpc('claim_planning_job',{'job_id':mcp_idea['job_id']},AUTH)
    assert 'Planning only' in claim['constraint']
    rpc('claim_planning_job',{'job_id':mcp_idea['job_id']},AUTH,error=-32602)
    proposed={'job_id':mcp_idea['job_id'],'claim_token':claim['claim_token'],
      'plan':{'title':'Native validation plan','goal':'Validate local flow','scope':'Local synthetic records','acceptance':'Checks pass'},
      'tickets':[{'key':'verify','title':'Native validation ticket','goal':'Validate snapshot','scope':'Loopback only','acceptance':'Snapshot is immutable'}]}
    rpc('save_plan_and_tickets',{**proposed,'claim_token':'invalid'},AUTH,error=-32602)
    output=rpc('save_plan_and_tickets',proposed,AUTH); repeated=rpc('save_plan_and_tickets',proposed,AUTH)
    assert output==repeated and len(output['ticket_ids'])==1
    got=rpc('get_idea',{'idea_id':mcp_idea['idea_id']},AUTH)
    assert got['planningStatus']=='planned' and got['planId']==output['plan_id']
    ok('MCP idempotent creation, exclusive claim, invalid token rejection and atomic/idempotent plan save')
    ticket_id=output['ticket_ids'][0]
    records,_=request(DEV,'/api/records',headers=AUTH)
    ticket=next(r for r in records['records'] if r['id']==ticket_id)
    assert ticket['status']=='todo' and ticket['allowedActions']=='仅规划；执行授权待单独确认'
    run=save({'kind':'run','title':'Native synthetic snapshot','ticketId':ticket_id,'evidence':'Synthetic API checks'})
    save({'kind':'ticket','title':'Native edited ticket','id':ticket_id,'revision':1,'status':'done','evidence':'Synthetic test passed'},200)
    save({'kind':'run','title':'Cannot edit run','id':run['id'],'revision':1},400)
    records,_=request(DEV,'/api/records',headers=AUTH)
    snapshot=next(r for r in records['records'] if r['id']==run['id'])
    assert snapshot['ticketRevision']==1 and snapshot['contract']['title']=='Native validation ticket'
    ok('ticket evidence requirement, revision update and immutable Run contract snapshot')
    stale=rpc('claim_planning_job',{'job_id':f'planning:{idea_id}:2'},AUTH)
    save({**idea,'id':idea_id,'revision':2},200)
    rpc('save_plan_and_tickets',{**proposed,'job_id':stale['job_id'],'claim_token':stale['claim_token']},AUTH,error=-32602)
    ok('MCP save rejects idea revisions changed after claiming')
    rpc('',{'name':'idea.planning_requested','delivery':{'mode':'webhook','url':'http://127.0.0.1:9999/no-network','secret':'synthetic-invalid'}},AUTH,error=-32602,method='events/subscribe')
    ok('invalid callback secret rejected before local delivery')
    _,preview_login=request(PREVIEW,'/api/auth/login','POST',{'username':'alice','password':'synthetic-password'},{'Origin':PREVIEW})
    owner={'Cookie':preview_login['Set-Cookie'].split(';')[0],'Origin':PREVIEW}
    _,other_login=request(PREVIEW,'/api/auth/login','POST',{'username':'bob','password':'synthetic-password'},{'Origin':PREVIEW})
    other={'Cookie':other_login['Set-Cookie'].split(';')[0],'Origin':PREVIEW}
    assert request(PREVIEW,'/api/records',headers=owner)[0]['records']==[]
    isolated,_=request(PREVIEW,'/api/records','POST',{'kind':'idea','title':'Separate database'},owner,201)
    assert request(PREVIEW,'/api/records',headers=other)[0]['records']==[]
    rpc('get_idea',{'idea_id':isolated['id']},other,error=-32602,base=PREVIEW)
    assert rpc('list_planning_jobs',headers=other,base=PREVIEW)['jobs']==[]
    request(PREVIEW,'/api/records','POST',{'kind':'idea','title':'Cross owner update','id':isolated['id'],'revision':1},other,404)
    request(PREVIEW,'/api/planning','POST',{'ideaId':isolated['id']},other,404)
    spoof_with_cookie={**AUTH,**spoof}
    assert any(r['id']==idea_id for r in request(DEV,'/api/records',headers=spoof_with_cookie)[0]['records'])
    ok('independent native databases and real account owner scoping; identity headers cannot replace session')
    (OUT / 'fixtures.json').write_text(json.dumps({'ideaId':mcp_idea['idea_id'],'ideaTitle':args['title'],'project':args['project'],'planId':output['plan_id'],'planTitle':proposed['plan']['title'],'ticketId':ticket_id,'ticketTitle':'Native edited ticket','runId':run['id'],'runTitle':'Native synthetic snapshot'},indent=2)+'\n')
    _,out=request(DEV,'/api/auth/logout','POST',headers=AUTH,status=200)
    assert '1970' in out['Set-Cookie']
    request(DEV,'/api/records',headers={'Cookie':'hub_session='},status=401)
    ok('real logout expires cookie and anonymous access is denied')
    (OUT / 'api-evidence.json').write_text(json.dumps({'status':'passed','checks':checks,'synthetic_records_only':True,'external_callbacks':False,'limitations':['Synthetic planning and manual snapshots only; no Ticket dispatch.']},indent=2)+'\n')
except Exception:
    (OUT / 'api-evidence.json').write_text(json.dumps({'status':'failed','checks_completed':checks},indent=2)+'\n')
    raise
