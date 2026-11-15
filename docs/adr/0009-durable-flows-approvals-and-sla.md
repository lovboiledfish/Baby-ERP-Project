# ADR 0009: Durable Flows, Approvals & SLA Engine

- **Status:** Accepted (Phase 7)
- **Context:** Steward needs low-code process automation (`sys_hub_flow`) capable of pausing on human approvals (`sysapproval_approver`) or record conditions (`wait_for_condition`) and resuming across process restarts, plus a declarative SLA engine (`contract_sla`, `task_sla`) with start/pause/resume/stop/breach lifecycle management.

## Decisions

### 1. Durable Flow Engine (`FlowService`)
- Flows are stored as records in `sys_hub_flow` with triggers (`record_created`, `record_updated`, `record_created_or_updated`, `event`), an optional encoded-query `condition`, and a JSON array of typed `steps`.
- Every flow invocation creates a row in `sys_flow_context` storing `current_step`, `state` (`in_progress`, `waiting`, `complete`, `cancelled`, `error`), and `context_data` (including the active step queue, scope, initiator, and runtime variables), plus per-step execution history in `sys_flow_step`.
- Supported step types:
  - `update_record`, `create_record`, `log`, `event`, `notify` (queues `sys_email` with `${field}` and `${variables.*}` interpolation), `run_script` (executes in `isolated-vm`), `if` (evaluates encoded query and splices `thenSteps` or `elseSteps` into the persisted step queue), `ask_for_approval`, and `wait_for_condition`.
- **Pause and Resume Across Restarts:**
  - When `ask_for_approval` executes, `FlowService` inserts a `sysapproval_approver` record (`state = 'requested'`, `flow_context = contextSysId`), sets `sys_flow_context.state = 'waiting'` and `waiting_for_approval = approvalSysId`, and returns.
  - Because the entire execution state (`current_step` and `context_data`) is committed to Postgres, even if the worker process restarts, updating `sysapproval_approver.state` to `'approved'` or `'rejected'` reloads `sys_flow_context` from the database and resumes execution at `current_step + 1` (or runs `onRejectSteps` / cancels on rejection).

### 2. SLA Engine (`SlaService`)
- `contract_sla` defines `collection`, `duration_seconds`, `start_condition`, `pause_condition`, `stop_condition`, and `reset_condition` using Steward's encoded-query syntax.
- On record writes, `SlaService.onRecordWrite` evaluates matching SLA definitions:
  - Attaches a `task_sla` record (`stage = 'in_progress'`, `planned_end_time = start_time + duration_seconds`) when `start_condition` matches.
  - Transitions to `stage = 'paused'` and records `pause_time` when `pause_condition` matches.
  - When resuming from `paused` to `in_progress`, accumulates `pause_duration` and shifts `planned_end_time` forward by the paused duration.
  - Completes (`stage = 'completed'` or `'breached'`, `active = false`) when `stop_condition` matches, or cancels (`stage = 'cancelled'`, `active = false`) when `start_condition` no longer holds.
- During `EventService.tick(engine, now)`, `SlaService.evaluateBreaches(engine, now)` updates elapsed durations/percentages and marks any overdue `in_progress` `task_sla` rows as `stage = 'breached'`, `has_breached = true`, queuing an `sla.breached` event in `sys_event`.
