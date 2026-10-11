CREATE TABLE execution_worker_credentials (
 credential_id TEXT PRIMARY KEY NOT NULL CHECK(length(credential_id)=36 AND credential_id=lower(credential_id)
  AND substr(credential_id,9,1)='-' AND substr(credential_id,14,1)='-' AND substr(credential_id,19,1)='-' AND substr(credential_id,24,1)='-'
  AND substr(credential_id,15,1)='4' AND substr(credential_id,20,1) IN ('8','9','a','b')
  AND length(replace(credential_id,'-',''))=32 AND replace(credential_id,'-','') NOT GLOB '*[^0-9a-f]*'),
 owner TEXT NOT NULL REFERENCES local_users(id),
 actor TEXT NOT NULL CHECK(length(actor) BETWEEN 1 AND 256),
 origin TEXT NOT NULL CHECK(length(origin) BETWEEN 1 AND 2048),
 issuer_token_hash TEXT NOT NULL CHECK(length(issuer_token_hash)=64 AND issuer_token_hash NOT GLOB '*[^0-9a-f]*'),
 issuer_expires_at INTEGER NOT NULL CHECK(typeof(issuer_expires_at)='integer'),
 run_id TEXT NOT NULL REFERENCES execution_runs(id),
 project TEXT NOT NULL CHECK(length(project) BETWEEN 1 AND 200),
 ticket_id TEXT NOT NULL,
 ticket_revision INTEGER NOT NULL CHECK(ticket_revision>0),
 attempt INTEGER NOT NULL CHECK(attempt>0),
 authorization_id TEXT NOT NULL,
 verifier TEXT NOT NULL CHECK(length(verifier)=64 AND verifier NOT GLOB '*[^0-9a-f]*'),
 label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
 request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 128),
 input_key TEXT NOT NULL CHECK(length(input_key)<=4096),
 created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
 expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at>created_at AND expires_at<=created_at+900000 AND expires_at<=issuer_expires_at),
 revoked_at INTEGER CHECK(revoked_at IS NULL OR (typeof(revoked_at)='integer' AND revoked_at>=created_at)),
 revoke_request_id TEXT CHECK(revoke_request_id IS NULL OR length(revoke_request_id) BETWEEN 1 AND 128),
 CHECK((revoked_at IS NULL)=(revoke_request_id IS NULL)),
 UNIQUE(owner,request_id), UNIQUE(owner,revoke_request_id)
);
CREATE INDEX execution_worker_credentials_owner ON execution_worker_credentials(owner,created_at,credential_id);
CREATE TRIGGER execution_worker_credentials_binding BEFORE INSERT ON execution_worker_credentials
WHEN NOT EXISTS(SELECT 1 FROM execution_runs r WHERE r.id=NEW.run_id AND r.owner=NEW.owner
 AND r.ticket_id=NEW.ticket_id AND r.ticket_revision=NEW.ticket_revision AND r.attempt=NEW.attempt
 AND r.authorization_id=NEW.authorization_id AND COALESCE(NULLIF(json_extract(r.ticket_body,'$.project'),''),'通用')=NEW.project)
BEGIN SELECT RAISE(ABORT,'Invalid Worker Run binding'); END;
CREATE TRIGGER execution_worker_credentials_immutable BEFORE UPDATE ON execution_worker_credentials
WHEN NEW.credential_id IS NOT OLD.credential_id OR NEW.owner IS NOT OLD.owner OR NEW.actor IS NOT OLD.actor
 OR NEW.origin IS NOT OLD.origin OR NEW.issuer_token_hash IS NOT OLD.issuer_token_hash OR NEW.issuer_expires_at IS NOT OLD.issuer_expires_at
 OR NEW.run_id IS NOT OLD.run_id OR NEW.project IS NOT OLD.project OR NEW.ticket_id IS NOT OLD.ticket_id
 OR NEW.ticket_revision IS NOT OLD.ticket_revision OR NEW.attempt IS NOT OLD.attempt OR NEW.authorization_id IS NOT OLD.authorization_id
 OR NEW.verifier IS NOT OLD.verifier OR NEW.label IS NOT OLD.label OR NEW.request_id IS NOT OLD.request_id
 OR NEW.input_key IS NOT OLD.input_key OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
 OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS NOT OLD.revoked_at OR NEW.revoke_request_id IS NOT OLD.revoke_request_id))
BEGIN SELECT RAISE(ABORT,'Immutable Worker credential'); END;
CREATE TRIGGER execution_worker_credentials_no_delete BEFORE DELETE ON execution_worker_credentials
BEGIN SELECT RAISE(ABORT,'Immutable Worker credential history'); END;
CREATE TABLE execution_worker_checks (
 id TEXT PRIMARY KEY NOT NULL,
 valid INTEGER NOT NULL CONSTRAINT execution_worker_authorized CHECK(valid=1)
);
