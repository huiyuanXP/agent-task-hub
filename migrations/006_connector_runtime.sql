ALTER TABLE workspace_connections ADD COLUMN runtime_json TEXT
 CHECK(runtime_json IS NULL OR (json_valid(runtime_json) AND json_type(runtime_json)='object' AND length(runtime_json)<=500));
