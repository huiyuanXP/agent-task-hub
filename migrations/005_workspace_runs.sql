CREATE TABLE workspace_runs (
 id TEXT PRIMARY KEY NOT NULL,
 owner TEXT NOT NULL,
 ticket_id TEXT NOT NULL,
 ticket_revision INTEGER NOT NULL CHECK(ticket_revision>0),
 ticket_body TEXT NOT NULL CHECK(json_valid(ticket_body) AND json_type(ticket_body)='object' AND length(ticket_body)<=80000),
 connection_id TEXT NOT NULL REFERENCES workspace_connections(id),
 project_id TEXT NOT NULL REFERENCES workspace_projects(id),
 project TEXT NOT NULL,
 workspace TEXT NOT NULL,
 operation TEXT NOT NULL DEFAULT 'workspace.develop.v1' CHECK(operation='workspace.develop.v1'),
 request_id TEXT NOT NULL,
 input_key TEXT NOT NULL,
 previous_run_id TEXT REFERENCES workspace_runs(id),
 timeout_ms INTEGER NOT NULL CHECK(timeout_ms BETWEEN 1000 AND 3600000),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','running','review','succeeded','failed','cancelled')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
 lease_hash TEXT,
 lease_expires_at INTEGER,
 deadline_at INTEGER,
 physical_closed_at INTEGER,
 cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
 error TEXT,
 result TEXT CHECK(result IS NULL OR (json_valid(result) AND length(result)<=1048576)),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 CHECK((generation=0 AND lease_hash IS NULL AND deadline_at IS NULL) OR (generation>0 AND lease_hash IS NOT NULL AND deadline_at IS NOT NULL)),
 CHECK(state NOT IN ('review','succeeded') OR result IS NOT NULL)
);
CREATE UNIQUE INDEX workspace_runs_request ON workspace_runs(owner,request_id);
CREATE UNIQUE INDEX workspace_runs_active_ticket ON workspace_runs(owner,ticket_id) WHERE state IN ('pending','approved','running','review');
CREATE UNIQUE INDEX workspace_runs_physical_ticket ON workspace_runs(owner,ticket_id) WHERE generation>0 AND physical_closed_at IS NULL;
CREATE UNIQUE INDEX workspace_runs_physical_connection ON workspace_runs(connection_id) WHERE generation>0 AND physical_closed_at IS NULL;
CREATE INDEX workspace_runs_owner_created ON workspace_runs(owner,created_at,id);
CREATE INDEX workspace_runs_claim ON workspace_runs(connection_id,state,created_at);

CREATE TABLE workspace_run_events (
 run_id TEXT NOT NULL REFERENCES workspace_runs(id),
 id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence>0),
 stage TEXT NOT NULL CHECK(length(stage) BETWEEN 1 AND 64),
 message TEXT NOT NULL CHECK(length(message)<=4000),
 created_at INTEGER NOT NULL,
 PRIMARY KEY(run_id,id),
 UNIQUE(run_id,sequence)
);
CREATE TABLE workspace_run_decisions (
 run_id TEXT NOT NULL REFERENCES workspace_runs(id),
 version INTEGER NOT NULL,
 actor TEXT NOT NULL,
 action TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(run_id,version)
);
CREATE TRIGGER workspace_runs_created AFTER INSERT ON workspace_runs
BEGIN INSERT INTO workspace_run_events(run_id,id,sequence,stage,message,created_at)
 VALUES(NEW.id,'state:1',1,'pending','Local development prepared; owner approval required',NEW.created_at); END;
CREATE TRIGGER workspace_runs_state_event AFTER UPDATE ON workspace_runs
WHEN NEW.state IS NOT OLD.state
BEGIN INSERT INTO workspace_run_events(run_id,id,sequence,stage,message,created_at)
 VALUES(NEW.id,'state:'||NEW.version,COALESCE((SELECT MAX(sequence) FROM workspace_run_events WHERE run_id=NEW.id),0)+1,
 CASE WHEN NEW.state='running' THEN 'claimed' WHEN NEW.state='review' THEN 'delivery' ELSE NEW.state END,
 CASE WHEN NEW.state='running' THEN 'Approved local Agent claimed development' WHEN NEW.state='review' THEN 'Diff and test receipts submitted for owner acceptance'
 WHEN NEW.state='failed' THEN COALESCE(NEW.error,'Development failed') WHEN NEW.state='cancelled' THEN 'Owner cancelled development' ELSE NEW.state END,NEW.updated_at); END;
CREATE TRIGGER workspace_runs_immutable BEFORE UPDATE ON workspace_runs
WHEN NEW.id IS NOT OLD.id OR NEW.owner IS NOT OLD.owner OR NEW.ticket_id IS NOT OLD.ticket_id
 OR NEW.ticket_revision IS NOT OLD.ticket_revision OR NEW.ticket_body IS NOT OLD.ticket_body
 OR NEW.connection_id IS NOT OLD.connection_id OR NEW.project_id IS NOT OLD.project_id
 OR NEW.project IS NOT OLD.project OR NEW.workspace IS NOT OLD.workspace OR NEW.operation IS NOT OLD.operation
 OR NEW.request_id IS NOT OLD.request_id OR NEW.input_key IS NOT OLD.input_key
 OR NEW.previous_run_id IS NOT OLD.previous_run_id OR NEW.timeout_ms IS NOT OLD.timeout_ms OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.result IS NOT NULL AND NEW.result IS NOT OLD.result)
 OR NEW.cancel_requested<OLD.cancel_requested
 OR NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1
 OR (OLD.generation>0 AND (NEW.generation IS NOT OLD.generation OR NEW.lease_hash IS NOT OLD.lease_hash OR NEW.deadline_at IS NOT OLD.deadline_at))
 OR (OLD.physical_closed_at IS NOT NULL AND NEW.physical_closed_at IS NOT OLD.physical_closed_at)
BEGIN SELECT RAISE(ABORT,'Immutable workspace Run contract'); END;
CREATE TRIGGER workspace_runs_edges BEFORE UPDATE ON workspace_runs
WHEN NEW.version!=OLD.version+1 OR NOT (
 NEW.state=OLD.state OR
 (OLD.state='pending' AND NEW.state IN ('approved','cancelled','failed')) OR
 (OLD.state='approved' AND NEW.state IN ('running','cancelled','failed')) OR
 (OLD.state='running' AND NEW.state IN ('review','cancelled','failed')) OR
 (OLD.state='review' AND NEW.state IN ('succeeded','cancelled','failed')))
BEGIN SELECT RAISE(ABORT,'Invalid workspace Run transition'); END;
CREATE TRIGGER workspace_runs_accept BEFORE UPDATE ON workspace_runs
WHEN NEW.state='succeeded' AND OLD.state='review'
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM records WHERE id=OLD.ticket_id AND owner=OLD.owner AND kind='ticket' AND revision=OLD.ticket_revision AND body=OLD.ticket_body)
 THEN RAISE(ABORT,'Workspace Ticket revision conflict') END;
 INSERT INTO records(id,owner,kind,body,revision,created,updated)
 SELECT 'workspace-accept:'||OLD.id,OLD.owner,'history',json_object('title',json_extract(body,'$.title'),'recordId',id,'recordKind','ticket','previousRevision',revision,'snapshot',json(body)),1,
 strftime('%Y-%m-%dT%H:%M:%fZ',NEW.updated_at/1000.0,'unixepoch'),strftime('%Y-%m-%dT%H:%M:%fZ',NEW.updated_at/1000.0,'unixepoch')
 FROM records WHERE id=OLD.ticket_id AND owner=OLD.owner AND kind='ticket' AND revision=OLD.ticket_revision;
 UPDATE records SET body=json_set(body,'$.status','done'),revision=revision+1,
 updated=strftime('%Y-%m-%dT%H:%M:%fZ',NEW.updated_at/1000.0,'unixepoch')
 WHERE id=OLD.ticket_id AND owner=OLD.owner AND kind='ticket' AND revision=OLD.ticket_revision;
END;
CREATE TRIGGER workspace_runs_no_delete BEFORE DELETE ON workspace_runs
BEGIN SELECT RAISE(ABORT,'Immutable workspace Run history'); END;
CREATE TRIGGER workspace_run_events_no_update BEFORE UPDATE ON workspace_run_events
BEGIN SELECT RAISE(ABORT,'Immutable workspace Run event'); END;
CREATE TRIGGER workspace_run_events_no_delete BEFORE DELETE ON workspace_run_events
BEGIN SELECT RAISE(ABORT,'Immutable workspace Run event'); END;
CREATE TRIGGER workspace_run_decisions_no_update BEFORE UPDATE ON workspace_run_decisions
BEGIN SELECT RAISE(ABORT,'Immutable workspace Run decision'); END;
CREATE TRIGGER workspace_run_decisions_no_delete BEFORE DELETE ON workspace_run_decisions
BEGIN SELECT RAISE(ABORT,'Immutable workspace Run decision'); END;
