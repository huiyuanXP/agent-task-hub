declare namespace Cloudflare {
  interface Env {
    EXECUTION_REGISTRY?: string; EXECUTION_RUNNER_URL?: string; EXECUTION_RUNNER_AUDIENCE?: string;
    EXECUTION_CHECKPOINT_AUDIENCE?: string; EXECUTION_CONTROL_KEY?: string; EXECUTION_RUNNER_KEY?: string; EXECUTION_EVIDENCE_KEY?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
