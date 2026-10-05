# Planning revisions

Every successful save of an Idea creates a new revision and automatically queues planning for that revision. This retains the existing save semantics, including a deliberate save of unchanged content. The optional project is validated as text of at most 120 characters before any write. Title, original content, project, priority and other saved context belong to the new revision. A duplicate submission using the previous revision returns 409 and does not create another history record or job.

The records API saves history, compare-and-swap revision update and deterministic `planning:<idea-id>:<revision>` job in one D1 batch. The job insert also checks this transaction's unique history ID and resulting Idea revision. Callback delivery starts only after that transaction succeeds; no subscription or failed delivery leaves the durable job available for recovery. A failed job insert rolls the entire revision/history change back.

Planner claims and plan saves remain revision-specific. An old claim cannot save after an Idea changes. Current Idea counts/result actions use only its current revision; prior Plans remain visible with a source/current revision label. Their Tickets, approvals and evidence are retained. Replanning does not execute, cancel or authorize a Ticket.

`npm run test:planning:revisions` exercises the actual built Worker with real synthetic Access JWTs, fresh isolated D1 and controlled JWKS. Build first. It checks event revision/project, stale duplicate submission, six concurrent edits, history/transaction rollback, stale planner and cross-owner rejection. Default `npm test` includes it. The isolated browser suite edits an Idea and checks current queuing plus its prior Plan label. No production data or external callback is used.
