CREATE TABLE execution_worker_leases (
 lease_id TEXT PRIMARY KEY NOT NULL CHECK(length(lease_id)=36 AND lease_id=lower(lease_id)
  AND substr(lease_id,9,1)='-' AND substr(lease_id,14,1)='-' AND substr(lease_id,19,1)='-' AND substr(lease_id,24,1)='-'
  AND substr(lease_id,15,1)='4' AND substr(lease_id,20,1) IN ('8','9','a','b')
  AND length(replace(lease_id,'-',''))=32 AND replace(lease_id,'-','') NOT GLOB '*[^0-9a-f]*'),
 owner TEXT NOT NULL REFERENCES local_users(id),
 credential_id TEXT NOT NULL REFERENCES execution_worker_credentials(credential_id),
 run_id TEXT NOT NULL REFERENCES execution_runs(id),
 generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991),
 mode TEXT NOT NULL CHECK(mode IN ('execute','reconcile')),
 verifier TEXT NOT NULL CHECK(length(verifier)=64 AND verifier NOT GLOB '*[^0-9a-f]*'),
 request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 128),
 input_key TEXT NOT NULL CHECK(length(input_key)<=4096),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
 expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at>created_at),
 renewed_at INTEGER NOT NULL CHECK(typeof(renewed_at)='integer' AND renewed_at>=created_at AND expires_at<=renewed_at+6000),
 UNIQUE(run_id,generation), UNIQUE(credential_id,request_id),
 UNIQUE(lease_id,credential_id,run_id,owner,generation)
);
CREATE INDEX execution_worker_leases_current ON execution_worker_leases(run_id,generation DESC);
CREATE TRIGGER execution_worker_leases_binding BEFORE INSERT ON execution_worker_leases
WHEN NOT EXISTS(SELECT 1 FROM execution_worker_credentials w WHERE w.credential_id=NEW.credential_id
 AND w.owner=NEW.owner AND w.run_id=NEW.run_id AND NEW.expires_at<=w.expires_at AND NEW.expires_at<=w.issuer_expires_at)
BEGIN SELECT RAISE(ABORT,'Invalid Worker lease binding'); END;
CREATE TRIGGER execution_worker_leases_immutable BEFORE UPDATE ON execution_worker_leases
WHEN NEW.lease_id IS NOT OLD.lease_id OR NEW.owner IS NOT OLD.owner OR NEW.credential_id IS NOT OLD.credential_id
 OR NEW.run_id IS NOT OLD.run_id OR NEW.generation IS NOT OLD.generation OR NEW.mode IS NOT OLD.mode
 OR NEW.verifier IS NOT OLD.verifier OR NEW.request_id IS NOT OLD.request_id OR NEW.input_key IS NOT OLD.input_key
 OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at<OLD.expires_at OR NEW.renewed_at<OLD.renewed_at
 OR NOT EXISTS(SELECT 1 FROM execution_worker_credentials w WHERE w.credential_id=NEW.credential_id
  AND NEW.expires_at<=w.expires_at AND NEW.expires_at<=w.issuer_expires_at)
BEGIN SELECT RAISE(ABORT,'Immutable Worker lease binding'); END;
CREATE TRIGGER execution_worker_leases_no_delete BEFORE DELETE ON execution_worker_leases
BEGIN SELECT RAISE(ABORT,'Immutable Worker lease history'); END;
CREATE TABLE execution_worker_actions (
 owner TEXT NOT NULL REFERENCES local_users(id),
 credential_id TEXT NOT NULL REFERENCES execution_worker_credentials(credential_id),
 run_id TEXT NOT NULL REFERENCES execution_runs(id),
 lease_id TEXT NOT NULL,
 generation INTEGER NOT NULL,
 request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 128),
 kind TEXT NOT NULL CHECK(kind IN ('claim','renew','report','start','complete','cancel')),
 input_key TEXT NOT NULL CHECK(length(input_key)<=4096),
 status TEXT NOT NULL CHECK(status IN ('pending','completed')),
 response_json TEXT CHECK(response_json IS NULL OR (json_valid(response_json) AND length(CAST(response_json AS BLOB))<=16384)),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
 updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>=created_at),
 CHECK((status='pending' AND response_json IS NULL) OR (status='completed' AND response_json IS NOT NULL)),
 PRIMARY KEY(credential_id,request_id),
 FOREIGN KEY(lease_id,credential_id,run_id,owner,generation) REFERENCES execution_worker_leases(lease_id,credential_id,run_id,owner,generation)
);
CREATE TRIGGER execution_worker_actions_immutable BEFORE UPDATE ON execution_worker_actions
WHEN NEW.owner IS NOT OLD.owner OR NEW.credential_id IS NOT OLD.credential_id OR NEW.run_id IS NOT OLD.run_id
 OR NEW.lease_id IS NOT OLD.lease_id OR NEW.generation IS NOT OLD.generation OR NEW.request_id IS NOT OLD.request_id
 OR NEW.kind IS NOT OLD.kind OR NEW.input_key IS NOT OLD.input_key OR NEW.created_at IS NOT OLD.created_at
 OR NEW.updated_at<OLD.updated_at OR (OLD.status='completed' AND
   (NEW.status IS NOT OLD.status OR NEW.response_json IS NOT OLD.response_json OR NEW.updated_at IS NOT OLD.updated_at))
BEGIN SELECT RAISE(ABORT,'Immutable Worker action receipt'); END;
CREATE TRIGGER execution_worker_actions_no_delete BEFORE DELETE ON execution_worker_actions
BEGIN SELECT RAISE(ABORT,'Immutable Worker action history'); END;
