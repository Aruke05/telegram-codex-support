import { randomUUID } from "node:crypto"
import { chmod, mkdir } from "node:fs/promises"
import path from "node:path"
import { DatabaseSync, type StatementSync } from "node:sqlite"

import { baselineOperatorStyleProfile } from "../support/operator-style.js"
import { DATABASE_SCHEMA_VERSION } from "../version.js"
import {
  directiveSchema,
  maintenanceRunSchema,
  memoryEventSchema,
  memoryFactSchema,
  memoryVersionSchema,
  memoryViewSchema,
  operatorStyleVersionSchema,
  databaseResourceRecordSchema,
  projectRecordSchema,
  projectRepositoryRecordSchema,
  projectServiceRepositoryBindingRecordSchema,
  projectServiceRecordSchema,
  replyRecordSchema,
  runtimeGroupSchema,
  serverResourceRecordSchema,
  telegramAccountSchema,
  telegramOutgoingCandidateRowSchema,
  telegramOutputOwnershipRowSchema,
  telegramRoleSchema,
  type Directive,
  type DatabaseResourceRecord,
  type MaintenanceRun,
  type MemoryEvent,
  type MemoryFact,
  type MemoryVersion,
  type MemoryView,
  type OperatorStyleVersion,
  type ProjectRecord,
  type ProjectRepositoryRecord,
  type ProjectServiceRepositoryBindingRecord,
  type ProjectServiceRecord,
  type ReplyRecord,
  type RuntimeGroup,
  type ServerResourceRecord,
  type TelegramAccount,
  type TelegramRole,
} from "./types.js"

type SqlRow = Record<string, unknown>
type SqlParameter = string | number | null

const baselineOperatorStyleProfileJson = JSON.stringify(baselineOperatorStyleProfile).replaceAll("'", "''")

const learningSourceObservationsV22TableDefinition = `(
  id TEXT PRIMARY KEY,
  message_event_id TEXT NOT NULL UNIQUE REFERENCES support_message_events(id) ON DELETE CASCADE,
  source_telegram_user_id TEXT NOT NULL CHECK (length(source_telegram_user_id)>0 AND source_telegram_user_id NOT GLOB '*[^0-9]*'),
  source_role TEXT NOT NULL CHECK (source_role IN ('operator', 'technical', 'reviewer', 'ignored')),
  thread_id TEXT REFERENCES support_threads(id) ON DELETE SET NULL,
  service_id TEXT REFERENCES project_services(id) ON DELETE SET NULL,
  association_reason TEXT NOT NULL CHECK (association_reason IN ('direct_question','direct_bot_reply','reply_chain','single_active_thread','ambiguous','none')),
  association_confidence REAL NOT NULL CHECK (association_confidence BETWEEN 0 AND 1),
  takeover_status TEXT NOT NULL CHECK (takeover_status IN ('cancelled','delivery_in_flight','thread_already_terminal','ambiguous','not_linked')),
  classification TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
  processing_status TEXT NOT NULL CHECK (processing_status IN ('pending','ignored','running','completed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count>=0),
  lock_token TEXT,
  locked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`

const observationCurrentRunColumn = "current_run_id TEXT REFERENCES memory_maintenance_runs(id) ON DELETE SET NULL"
const learningSourceObservationsTableDefinition = learningSourceObservationsV22TableDefinition.replace(
  "  created_at TEXT NOT NULL,",
  `  ${observationCurrentRunColumn},\n  created_at TEXT NOT NULL,`,
)
const migratedLearningSourceObservationsTableDefinition = learningSourceObservationsV22TableDefinition.replace(
  "  updated_at TEXT NOT NULL\n)",
  `  updated_at TEXT NOT NULL,\n  ${observationCurrentRunColumn}\n)`,
)
const learningSourceObservationEvidenceColumns = `message_event_id,source_telegram_user_id,source_role,thread_id,service_id,association_reason,
  association_confidence,takeover_status,classification,risk,created_at`

const learningSourceObservationsAuxiliarySchema = `
CREATE INDEX IF NOT EXISTS learning_source_observations_queue_idx
  ON learning_source_observations(processing_status,locked_at,id);
CREATE INDEX IF NOT EXISTS learning_source_observations_thread_idx
  ON learning_source_observations(thread_id,created_at DESC);
CREATE INDEX IF NOT EXISTS learning_source_observations_user_idx
  ON learning_source_observations(source_telegram_user_id,created_at DESC);
CREATE TRIGGER IF NOT EXISTS learning_source_observations_no_evidence_update
BEFORE UPDATE OF ${learningSourceObservationEvidenceColumns} ON learning_source_observations
WHEN COALESCE((SELECT value FROM metadata WHERE key='allow_maintenance_delete'), '0') != '1'
BEGIN SELECT RAISE(ABORT, 'learning source observations are append only'); END;
CREATE TRIGGER IF NOT EXISTS learning_source_observations_no_delete
BEFORE DELETE ON learning_source_observations
WHEN COALESCE((SELECT value FROM metadata WHERE key='allow_maintenance_delete'), '0') != '1'
BEGIN SELECT RAISE(ABORT, 'learning source observations are append only'); END;
`

const learningSourceObservationsSchema = `
CREATE TABLE IF NOT EXISTS learning_source_observations ${learningSourceObservationsTableDefinition};
${learningSourceObservationsAuxiliarySchema}
`

const learningSourceObservationsV22Schema = `
CREATE TABLE IF NOT EXISTS learning_source_observations ${learningSourceObservationsV22TableDefinition};
${learningSourceObservationsAuxiliarySchema}
`

const referenceLearningResultsTableDefinition = `(
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES memory_maintenance_runs(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES learning_source_observations(id) ON DELETE CASCADE,
  classification TEXT NOT NULL CHECK (classification IN (
    'unclassified','style','correction','business_rule','ephemeral','action_result','general'
  )),
  action TEXT NOT NULL CHECK (action IN ('add','reinforce','conflict','noop')),
  risk TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'noop','candidate','conflict','active','style_candidate','style_active','ignored','failed'
  )),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'proposal_noop','deterministic_noop','non_learnable_classification',
    'memory_candidate','memory_conflict','memory_active','style_candidate','style_active',
    'unsafe_learning_material','invalid_proposal_batch','processing_failed','interrupted_run'
  )),
  memory_version_id TEXT,
  operator_style_version_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, observation_id),
  CHECK (
    (outcome IN ('candidate','conflict','active') AND memory_version_id IS NOT NULL AND operator_style_version_id IS NULL)
    OR (outcome IN ('style_candidate','style_active') AND memory_version_id IS NULL AND operator_style_version_id IS NOT NULL)
    OR (outcome IN ('noop','ignored','failed') AND memory_version_id IS NULL AND operator_style_version_id IS NULL)
  )
)`

const referenceLearningResultsSchema = `
CREATE TABLE IF NOT EXISTS reference_learning_results ${referenceLearningResultsTableDefinition};
CREATE INDEX IF NOT EXISTS reference_learning_results_observation_idx
  ON reference_learning_results(observation_id,created_at DESC,id DESC);
CREATE TRIGGER IF NOT EXISTS reference_learning_results_no_update
BEFORE UPDATE ON reference_learning_results
WHEN COALESCE((SELECT value FROM metadata WHERE key='allow_maintenance_delete'), '0') != '1'
BEGIN SELECT RAISE(ABORT, 'reference learning results are append only'); END;
CREATE TRIGGER IF NOT EXISTS reference_learning_results_no_delete
BEFORE DELETE ON reference_learning_results
WHEN COALESCE((SELECT value FROM metadata WHERE key='allow_maintenance_delete'), '0') != '1'
BEGIN SELECT RAISE(ABORT, 'reference learning results are append only'); END;
`

// 仅供旧数据库逐级迁移时还原当时结构，v24 会删除这些单线程约束。
const supportThreadMessageInvariantSchema = `
CREATE TRIGGER IF NOT EXISTS support_thread_messages_single_thread_insert
BEFORE INSERT ON support_thread_messages
WHEN COALESCE((SELECT value FROM metadata WHERE key='allow_support_history_import'),'0')!='1' AND (EXISTS (
  SELECT 1 FROM support_thread_messages existing
  WHERE existing.message_event_id=NEW.message_event_id AND existing.thread_id<>NEW.thread_id
) OR EXISTS (
  SELECT 1 FROM support_message_events incoming
  JOIN support_message_events sibling ON sibling.ingest_batch_id=incoming.ingest_batch_id
  JOIN support_thread_messages existing ON existing.message_event_id=sibling.id
  WHERE incoming.id=NEW.message_event_id AND incoming.ingest_batch_id IS NOT NULL
    AND existing.thread_id<>NEW.thread_id
))
BEGIN SELECT RAISE(ABORT, 'support ingest batch already linked to another thread'); END;
CREATE TRIGGER IF NOT EXISTS support_thread_messages_single_thread_update
BEFORE UPDATE OF thread_id,message_event_id ON support_thread_messages
WHEN COALESCE((SELECT value FROM metadata WHERE key='allow_support_history_import'),'0')!='1' AND EXISTS (
  SELECT 1 FROM support_thread_messages existing
  WHERE existing.message_event_id=NEW.message_event_id AND existing.thread_id<>NEW.thread_id
)
BEGIN SELECT RAISE(ABORT, 'support ingest batch already linked to another thread'); END;
CREATE TRIGGER IF NOT EXISTS support_message_events_batch_link_update
BEFORE UPDATE OF ingest_batch_id ON support_message_events
WHEN COALESCE((SELECT value FROM metadata WHERE key='allow_support_history_import'),'0')!='1'
  AND NEW.ingest_batch_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM support_thread_messages current_link
    JOIN support_message_events sibling ON sibling.ingest_batch_id=NEW.ingest_batch_id
    JOIN support_thread_messages existing ON existing.message_event_id=sibling.id
    WHERE current_link.message_event_id=NEW.id AND existing.thread_id<>current_link.thread_id
  )
BEGIN SELECT RAISE(ABORT, 'support ingest batch already linked to another thread'); END;
`

const supportThreadSchema = `
CREATE TABLE IF NOT EXISTS support_threads (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  service_id TEXT NOT NULL REFERENCES project_services(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('collecting','generating','answered','escalated','closed')),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  settle_at TEXT NOT NULL,
  anchor_message_id TEXT NOT NULL,
  latest_message_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  origin_batch_id TEXT,
  operator_style_version_id TEXT REFERENCES operator_style_versions(id) ON DELETE SET NULL,
  operator_style_profile_json TEXT NOT NULL DEFAULT '${baselineOperatorStyleProfileJson}',
  answer_model_instance_id TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001',
  answer_reply_style TEXT NOT NULL DEFAULT 'unrestricted' CHECK (answer_reply_style IN ('human','unrestricted')),
  answer_timeout_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (answer_timeout_seconds BETWEEN 30 AND 3600),
  answer_max_concurrency INTEGER NOT NULL DEFAULT 2 CHECK (answer_max_concurrency BETWEEN 1 AND 8),
  answer_binding_enabled INTEGER NOT NULL DEFAULT 1 CHECK (answer_binding_enabled IN (0, 1)),
  answer_include_ai_memory INTEGER NOT NULL DEFAULT 1 CHECK (answer_include_ai_memory IN (0, 1)),
  answer_include_interface_docs INTEGER NOT NULL DEFAULT 1 CHECK (answer_include_interface_docs IN (0, 1)),
  answer_include_magic_book INTEGER NOT NULL DEFAULT 1 CHECK (answer_include_magic_book IN (0, 1)),
  answer_operation_mode TEXT NOT NULL DEFAULT 'live' CHECK(answer_operation_mode IN ('live','learning')),
  generation_started_at TEXT,
  progress_due_at TEXT,
  hard_deadline_at TEXT,
  human_priority_state TEXT NOT NULL DEFAULT 'none'
    CHECK(human_priority_state IN ('none','waiting','sending','claimed','answered')),
  human_priority_user_ids_json TEXT NOT NULL DEFAULT '[]',
  human_priority_due_at TEXT,
  human_priority_source_event_id TEXT,
  human_priority_progress_message_id TEXT,
  human_priority_error TEXT,
  closed_at TEXT,
  closed_by TEXT,
  closed_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS support_threads_due_idx ON support_threads(status,settle_at);
CREATE INDEX IF NOT EXISTS support_threads_route_idx ON support_threads(group_id,service_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS support_threads_recent_idx ON support_threads(latest_message_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS support_threads_status_recent_idx ON support_threads(status,latest_message_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS support_threads_project_recent_idx ON support_threads(project_id,latest_message_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS support_threads_service_recent_idx ON support_threads(service_id,latest_message_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS support_threads_group_recent_idx ON support_threads(group_id,latest_message_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS support_threads_progress_due_idx ON support_threads(status,progress_due_at);
CREATE INDEX IF NOT EXISTS support_threads_hard_deadline_idx ON support_threads(status,hard_deadline_at);
CREATE INDEX IF NOT EXISTS support_threads_human_priority_due_idx
  ON support_threads(human_priority_state,human_priority_due_at,id);
CREATE UNIQUE INDEX IF NOT EXISTS support_threads_origin_batch_unique_idx
  ON support_threads(origin_batch_id) WHERE origin_batch_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS support_thread_notifications (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  input_revision INTEGER NOT NULL CHECK(input_revision >= 1),
  kind TEXT NOT NULL CHECK(kind IN ('progress','timeout_operator','timeout_alert')),
  status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','unknown')),
  due_at TEXT NOT NULL,
  telegram_message_id TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(thread_id,input_revision,kind)
);
CREATE INDEX IF NOT EXISTS support_thread_notifications_due_idx ON support_thread_notifications(status,due_at,id);

CREATE TABLE IF NOT EXISTS support_message_events (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES telegram_accounts(id) ON DELETE SET NULL,
  telegram_message_id TEXT NOT NULL,
  reply_to_message_id TEXT,
  message_thread_id TEXT,
  media_group_id TEXT,
  sender_user_id TEXT NOT NULL,
  sender_username TEXT,
  sender_display_name TEXT,
  sender_role TEXT CHECK(sender_role IS NULL OR sender_role IN ('operator','technical','reviewer','ignored')),
  safe_text TEXT NOT NULL,
  attachment_summary TEXT NOT NULL,
  ingest_batch_id TEXT,
  human_priority_user_ids_json TEXT NOT NULL DEFAULT '[]',
  human_priority_due_at TEXT,
  route_status TEXT NOT NULL CHECK(route_status IN ('received','batched','ignored','role_skipped','command','routed','correction')),
  skip_reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(group_id,telegram_message_id)
);
CREATE INDEX IF NOT EXISTS support_message_events_recent_idx ON support_message_events(group_id,created_at DESC);
CREATE INDEX IF NOT EXISTS support_message_events_sender_idx ON support_message_events(sender_user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS support_message_events_username_idx ON support_message_events(sender_username COLLATE NOCASE,created_at DESC);
CREATE INDEX IF NOT EXISTS support_message_events_retention_idx ON support_message_events(created_at,id);
CREATE INDEX IF NOT EXISTS support_message_events_batch_idx ON support_message_events(ingest_batch_id)
  WHERE ingest_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS support_message_events_media_group_idx ON support_message_events(group_id,media_group_id)
  WHERE media_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS support_message_events_unrouted_idx
  ON support_message_events(route_status,created_at,id)
  WHERE route_status IN ('received','batched','command');

CREATE TABLE IF NOT EXISTS support_thread_messages (
  thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  message_event_id TEXT NOT NULL REFERENCES support_message_events(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK(relation IN ('origin','supplement','reopen')),
  question_fragment TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(thread_id,message_event_id,question_fragment)
);
CREATE INDEX IF NOT EXISTS support_thread_messages_event_idx ON support_thread_messages(message_event_id);

CREATE TABLE IF NOT EXISTS support_message_attachments (
  id TEXT PRIMARY KEY,
  message_event_id TEXT NOT NULL REFERENCES support_message_events(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK(file_size >= 0),
  kind TEXT NOT NULL CHECK(kind IN ('text','image','video','archive','pdf','other')),
  storage_path TEXT NOT NULL,
  extracted_text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS support_message_attachments_event_idx ON support_message_attachments(message_event_id,created_at);
CREATE INDEX IF NOT EXISTS support_message_attachments_retention_idx
  ON support_message_attachments(created_at,id) WHERE storage_path<>'';
`

const supportThreadLinkSchema = `
CREATE TABLE IF NOT EXISTS support_thread_links (
  source_thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  target_thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK(relation IN ('merged_into','split_from','related')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(source_thread_id,target_thread_id,relation),
  CHECK(source_thread_id<>target_thread_id)
);
CREATE INDEX IF NOT EXISTS support_thread_links_target_idx
  ON support_thread_links(target_thread_id,created_at DESC,source_thread_id);
CREATE TRIGGER IF NOT EXISTS support_thread_links_no_update
BEFORE UPDATE ON support_thread_links
BEGIN SELECT RAISE(ABORT, 'support thread links are append only'); END;
`

const supportSenderFocusSchema = `
CREATE TABLE IF NOT EXISTS support_sender_focus (
  group_id TEXT NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES project_services(id) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL CHECK(length(sender_user_id) BETWEEN 1 AND 80),
  thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('explicit_reply','new_thread','operator_reply','clarification_answer')),
  last_operator_message_id TEXT CHECK(last_operator_message_id IS NULL OR length(last_operator_message_id) BETWEEN 1 AND 80),
  last_bot_message_id TEXT CHECK(last_bot_message_id IS NULL OR length(last_bot_message_id) BETWEEN 1 AND 80),
  focused_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(group_id,service_id,sender_user_id)
);
CREATE INDEX IF NOT EXISTS support_sender_focus_expiry_idx
  ON support_sender_focus(expires_at,group_id,service_id,sender_user_id);
CREATE INDEX IF NOT EXISTS support_sender_focus_thread_idx
  ON support_sender_focus(thread_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS support_route_clarifications (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES telegram_groups(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES project_services(id) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL CHECK(length(sender_user_id) BETWEEN 1 AND 80),
  message_event_id TEXT NOT NULL REFERENCES support_message_events(id) ON DELETE CASCADE,
  candidate_thread_ids_json TEXT NOT NULL CHECK(
    json_valid(candidate_thread_ids_json)
    AND json_type(candidate_thread_ids_json)='array'
    AND json_array_length(candidate_thread_ids_json) BETWEEN 1 AND 2
  ),
  candidate_labels_json TEXT NOT NULL CHECK(
    json_valid(candidate_labels_json)
    AND json_type(candidate_labels_json)='array'
    AND json_array_length(candidate_labels_json)=json_array_length(candidate_thread_ids_json)
  ),
  status TEXT NOT NULL CHECK(status IN ('pending','resolved','expired','cancelled')),
  prompt_reply_id TEXT REFERENCES support_replies(id) ON DELETE SET NULL,
  selected_thread_id TEXT REFERENCES support_threads(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS support_route_clarifications_one_pending_idx
  ON support_route_clarifications(group_id,service_id,sender_user_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS support_route_clarifications_expiry_idx
  ON support_route_clarifications(status,expires_at,id);
CREATE INDEX IF NOT EXISTS support_route_clarifications_event_idx
  ON support_route_clarifications(message_event_id,created_at DESC);
`

const telegramOutputOwnershipTableSchema = `
CREATE TABLE IF NOT EXISTS telegram_output_ownership (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES telegram_accounts(id) ON DELETE SET NULL,
  delivery_group_id TEXT REFERENCES telegram_groups(id) ON DELETE CASCADE,
  telegram_chat_id TEXT NOT NULL,
  telegram_message_id TEXT,
  thread_id TEXT REFERENCES support_threads(id) ON DELETE CASCADE,
  service_id TEXT REFERENCES project_services(id) ON DELETE SET NULL,
  reply_id TEXT REFERENCES support_replies(id) ON DELETE CASCADE,
  notification_id TEXT REFERENCES support_thread_notifications(id) ON DELETE CASCADE,
  output_kind TEXT NOT NULL CHECK(length(output_kind) BETWEEN 1 AND 80),
  delivery_status TEXT NOT NULL CHECK(delivery_status IN ('sending','sent','failed','unknown')),
  request_key TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
  reply_to_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
`

const telegramOutgoingCandidatesTableSchema = `
CREATE TABLE IF NOT EXISTS telegram_outgoing_candidates (
  id TEXT PRIMARY KEY,
  ownership_id TEXT NOT NULL REFERENCES telegram_output_ownership(id) ON DELETE CASCADE,
  telegram_message_id TEXT NOT NULL,
  resolution_status TEXT NOT NULL CHECK(resolution_status IN ('pending','application','manual','unknown')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
`

const telegramOutputOwnershipSchema = `
${telegramOutputOwnershipTableSchema};
CREATE UNIQUE INDEX IF NOT EXISTS telegram_output_ownership_message_unique_idx
  ON telegram_output_ownership(account_id,telegram_chat_id,telegram_message_id)
  WHERE telegram_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS telegram_output_ownership_group_message_unique_idx
  ON telegram_output_ownership(delivery_group_id,telegram_message_id)
  WHERE delivery_group_id IS NOT NULL AND telegram_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS telegram_output_ownership_pending_idx
  ON telegram_output_ownership(account_id,telegram_chat_id,delivery_status,content_sha256,reply_to_message_id,created_at,id)
  WHERE telegram_message_id IS NULL AND delivery_status IN ('sending','unknown');
CREATE INDEX IF NOT EXISTS telegram_output_ownership_thread_status_idx
  ON telegram_output_ownership(thread_id,delivery_status,updated_at,id)
  WHERE thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS telegram_output_ownership_retention_idx
  ON telegram_output_ownership(created_at,id);

${telegramOutgoingCandidatesTableSchema};
CREATE UNIQUE INDEX IF NOT EXISTS telegram_outgoing_candidates_owner_message_unique_idx
  ON telegram_outgoing_candidates(ownership_id,telegram_message_id);
CREATE INDEX IF NOT EXISTS telegram_outgoing_candidates_resolution_idx
  ON telegram_outgoing_candidates(resolution_status,updated_at,id);
`

const adminChatSchema = `
CREATE TABLE IF NOT EXISTS admin_chat_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  service_id TEXT NOT NULL REFERENCES project_services(id) ON DELETE RESTRICT,
  created_by_user_id TEXT REFERENCES admin_users(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_chat_sessions_service_recent_idx
  ON admin_chat_sessions(service_id,updated_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS admin_chat_sessions_owner_recent_idx
  ON admin_chat_sessions(created_by_user_id,updated_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS admin_chat_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES admin_chat_sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position>=1),
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  decision TEXT CHECK(decision IS NULL OR decision IN ('reply','ignore','escalate')),
  status TEXT NOT NULL CHECK(status IN ('pending','generating','completed','failed','cancelled')),
  investigation_json TEXT NOT NULL,
  decision_reason TEXT,
  decision_confidence REAL CHECK(decision_confidence IS NULL OR decision_confidence BETWEEN 0 AND 1),
  code_revision TEXT,
  code_snapshot_id TEXT REFERENCES service_code_snapshots(id) ON DELETE SET NULL,
  code_sync_batch_id TEXT REFERENCES service_code_sync_batches(id) ON DELETE SET NULL,
  memory_version_refs_json TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  generation_started_at TEXT,
  completed_at TEXT,
  UNIQUE(session_id,position)
);
CREATE INDEX IF NOT EXISTS admin_chat_turns_work_idx ON admin_chat_turns(status,created_at,id);
`

const adminAccessSchema = `
CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(trim(username)) BETWEEN 1 AND 80),
  password_hash TEXT NOT NULL CHECK(length(password_hash)>0),
  password_salt TEXT NOT NULL CHECK(length(password_salt)>0),
  password_cost INTEGER NOT NULL DEFAULT 16384 CHECK(password_cost BETWEEN 16384 AND 262144),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  auth_version INTEGER NOT NULL DEFAULT 1 CHECK(auth_version>=1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_roles (
  id TEXT PRIMARY KEY,
  role_key TEXT NOT NULL UNIQUE CHECK(length(trim(role_key)) BETWEEN 1 AND 80),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
  is_super_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_super_admin IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_user_roles (
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES admin_roles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,role_id)
);
CREATE INDEX IF NOT EXISTS admin_user_roles_role_idx ON admin_user_roles(role_id,user_id);

CREATE TABLE IF NOT EXISTS admin_role_menus (
  role_id TEXT NOT NULL REFERENCES admin_roles(id) ON DELETE CASCADE,
  menu_key TEXT NOT NULL CHECK(menu_key IN (
    'overview','projects','connections','replies','chat','memories','docs','models','runtime','transfer','settings','access'
  )),
  created_at TEXT NOT NULL,
  PRIMARY KEY(role_id,menu_key)
);
CREATE INDEX IF NOT EXISTS admin_role_menus_menu_idx ON admin_role_menus(menu_key,role_id);
`

const adminAccessSeedSql = `
INSERT OR IGNORE INTO admin_roles(id,role_key,name,is_super_admin,created_at,updated_at)
VALUES
  ('00000000-0000-4000-8000-000000000100','super_admin','系统管理',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000200','standard','业务使用',0,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR IGNORE INTO admin_users(
  id,username,password_hash,password_salt,password_cost,enabled,auth_version,created_at,updated_at
) VALUES
  ('00000000-0000-4000-8000-000000000901','09','71FbesRBIOWOKT330xvtE46PKwwmkX6Zi83n6bfZ35BepucrMY9gmyoYiFkBh0o8C1jj9y1XQe4S8CfKmzpQ5g','BbQicl6cISpfLdCWlFJddA',16384,1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000902','oldwang','umMSbpANfbqbnBC1j04DF66cwi66fIEWdLCmhSYoaJeGsEKjp8XKStLgGyHhq1oGWdXdTklBxedYlcZsCD8YQA','q5fXUG7vbYWNVTzxPFpKJQ',16384,1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR IGNORE INTO admin_user_roles(user_id,role_id,created_at)
SELECT id,'00000000-0000-4000-8000-000000000100',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM admin_users WHERE username IN ('09','oldwang') COLLATE NOCASE;

INSERT OR IGNORE INTO admin_role_menus(role_id,menu_key,created_at)
VALUES
  ('00000000-0000-4000-8000-000000000100','overview',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000100','projects',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000100','connections',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000100','replies',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000100','chat',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000100','memories',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000100','docs',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000100','models',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000100','runtime',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000100','transfer',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000100','settings',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000100','access',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000200','chat',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`

const adminChatConversationExtensionSchema = `
CREATE TABLE IF NOT EXISTS admin_chat_attachments (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES admin_chat_turns(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK(file_size >= 0),
  kind TEXT NOT NULL CHECK(kind IN ('text','image','video','archive','pdf','other')),
  storage_path TEXT NOT NULL,
  extracted_text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_chat_attachments_turn_idx
  ON admin_chat_attachments(turn_id,created_at,id);
CREATE INDEX IF NOT EXISTS admin_chat_attachments_retention_idx
  ON admin_chat_attachments(created_at,id) WHERE storage_path<>'';

CREATE TABLE IF NOT EXISTS admin_chat_corrections (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES admin_chat_turns(id) ON DELETE CASCADE,
  corrected_answer TEXT NOT NULL,
  reason TEXT NOT NULL,
  corrected_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_chat_corrections_turn_idx
  ON admin_chat_corrections(turn_id,created_at,id);
`

const operatorStyleV17Schema = `
CREATE TABLE IF NOT EXISTS operator_style_versions (
  id TEXT PRIMARY KEY,
  version_number INTEGER NOT NULL UNIQUE CHECK(version_number >= 1),
  profile_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('candidate','active','superseded')),
  sample_count INTEGER NOT NULL CHECK(sample_count > 0),
  source_user_count INTEGER NOT NULL CHECK(source_user_count > 0),
  thread_count INTEGER NOT NULL CHECK(thread_count > 0),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  superseded_at TEXT,
  CHECK(source_user_count<=sample_count AND thread_count<=sample_count),
  CHECK(status!='active' OR (sample_count>=20 AND source_user_count>=2 AND thread_count>=5 AND activated_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS operator_style_one_active_idx
  ON operator_style_versions(status) WHERE status='active';
CREATE INDEX IF NOT EXISTS operator_style_versions_status_idx
  ON operator_style_versions(status,version_number DESC);

CREATE TABLE IF NOT EXISTS operator_style_version_evidence (
  operator_style_version_id TEXT NOT NULL REFERENCES operator_style_versions(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES learning_source_observations(id) ON DELETE RESTRICT,
  PRIMARY KEY(operator_style_version_id,observation_id)
);
CREATE INDEX IF NOT EXISTS operator_style_version_evidence_observation_idx
  ON operator_style_version_evidence(observation_id,operator_style_version_id);
`

const operatorStyleSchema = `
CREATE TABLE IF NOT EXISTS operator_style_versions (
  id TEXT PRIMARY KEY,
  version_number INTEGER NOT NULL UNIQUE CHECK(version_number >= 1),
  profile_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('candidate','active','superseded')),
  sample_count INTEGER NOT NULL CHECK(sample_count > 0),
  source_user_count INTEGER NOT NULL CHECK(source_user_count > 0),
  thread_count INTEGER NOT NULL CHECK(thread_count > 0),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  superseded_at TEXT,
  CHECK(source_user_count<=sample_count AND thread_count<=sample_count),
  CHECK(status!='active' OR (sample_count>=20 AND source_user_count>=2 AND thread_count>=5 AND activated_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS operator_style_one_active_idx
  ON operator_style_versions(status) WHERE status='active';
CREATE INDEX IF NOT EXISTS operator_style_versions_status_idx
  ON operator_style_versions(status,version_number DESC);

CREATE TABLE IF NOT EXISTS operator_style_version_evidence (
  id TEXT PRIMARY KEY CHECK(length(id)>0),
  operator_style_version_id TEXT NOT NULL REFERENCES operator_style_versions(id) ON DELETE CASCADE,
  observation_id TEXT REFERENCES learning_source_observations(id) ON DELETE SET NULL,
  source_telegram_user_id TEXT NOT NULL
    CHECK(length(source_telegram_user_id)>0 AND source_telegram_user_id NOT GLOB '*[^0-9]*'),
  thread_id TEXT NOT NULL CHECK(length(thread_id)>0)
);
CREATE UNIQUE INDEX IF NOT EXISTS operator_style_version_evidence_live_observation_unique_idx
  ON operator_style_version_evidence(operator_style_version_id,observation_id) WHERE observation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS operator_style_version_evidence_observation_idx
  ON operator_style_version_evidence(observation_id,operator_style_version_id);
`

const shadowLearningSchema = `
CREATE TABLE IF NOT EXISTS shadow_answer_results (
  id TEXT PRIMARY KEY,
  reply_id TEXT NOT NULL UNIQUE REFERENCES support_replies(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  input_revision INTEGER NOT NULL CHECK (input_revision >= 1),
  outcome_status TEXT NOT NULL CHECK (outcome_status IN ('completed','failed')),
  decision TEXT CHECK (decision IS NULL OR decision IN ('reply','ignore','escalate')),
  answer TEXT NOT NULL DEFAULT '',
  quote_text TEXT,
  reason TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  code_revision TEXT,
  memory_version_refs_json TEXT NOT NULL DEFAULT '[]',
  simulated_action TEXT NOT NULL,
  output_redacted INTEGER NOT NULL DEFAULT 0 CHECK (output_redacted IN (0,1)),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(thread_id,input_revision)
);
CREATE INDEX IF NOT EXISTS shadow_answer_results_status_idx
  ON shadow_answer_results(outcome_status,created_at,id);
CREATE INDEX IF NOT EXISTS shadow_answer_results_thread_idx
  ON shadow_answer_results(thread_id,input_revision);

CREATE TABLE IF NOT EXISTS shadow_human_answer_links (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL REFERENCES learning_source_observations(id) ON DELETE RESTRICT,
  human_message_event_id TEXT NOT NULL REFERENCES support_message_events(id) ON DELETE RESTRICT,
  thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  input_revision INTEGER NOT NULL CHECK (input_revision >= 1),
  shadow_result_id TEXT REFERENCES shadow_answer_results(id) ON DELETE SET NULL,
  match_reason TEXT NOT NULL CHECK (match_reason IN ('direct','split_family')),
  match_confidence REAL NOT NULL CHECK (match_confidence >= 0 AND match_confidence <= 1),
  created_at TEXT NOT NULL,
  UNIQUE(human_message_event_id,thread_id,input_revision)
);
CREATE INDEX IF NOT EXISTS shadow_human_answer_links_thread_idx
  ON shadow_human_answer_links(thread_id,input_revision,created_at,id);
CREATE INDEX IF NOT EXISTS shadow_human_answer_links_observation_idx
  ON shadow_human_answer_links(observation_id,created_at,id);

CREATE TABLE IF NOT EXISTS shadow_learning_reports (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('scheduled','manual')),
  due_at TEXT NOT NULL,
  cutoff_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
  claim_token TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  sample_count INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  summary_json TEXT,
  rendered_markdown TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shadow_learning_reports_due_idx
  ON shadow_learning_reports(status,due_at,id);

CREATE TABLE IF NOT EXISTS shadow_comparisons (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES shadow_learning_reports(id) ON DELETE CASCADE,
  shadow_result_id TEXT REFERENCES shadow_answer_results(id) ON DELETE SET NULL,
  thread_id TEXT REFERENCES support_threads(id) ON DELETE SET NULL,
  input_revision INTEGER NOT NULL CHECK (input_revision >= 1),
  question_snapshot TEXT NOT NULL,
  shadow_answer_snapshot TEXT NOT NULL,
  human_answers_json TEXT NOT NULL DEFAULT '[]',
  human_message_event_ids_json TEXT NOT NULL DEFAULT '[]',
  comparison_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(report_id,shadow_result_id)
);
CREATE INDEX IF NOT EXISTS shadow_comparisons_report_idx
  ON shadow_comparisons(report_id,created_at,id);

INSERT INTO shadow_learning_reports(
  id,trigger_type,due_at,cutoff_at,status,claim_token,attempt_count,sample_count,
  summary_json,rendered_markdown,error_message,started_at,completed_at,created_at,updated_at
) SELECT
  '00000000-0000-4000-8000-000000000029','scheduled',
  '2026-08-20T15:00:00.000Z','2026-08-20T15:00:00.000Z','pending',NULL,0,0,
  NULL,NULL,NULL,NULL,NULL,'2026-08-19T00:00:00.000Z','2026-08-19T00:00:00.000Z'
WHERE NOT EXISTS (
  SELECT 1 FROM shadow_learning_reports
  WHERE trigger_type='scheduled' AND due_at='2026-08-20T15:00:00.000Z'
    AND cutoff_at='2026-08-20T15:00:00.000Z'
);
`

const schema = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  default_knowledge_scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_repositories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  local_path TEXT NOT NULL,
  remote_url TEXT NOT NULL,
  branch TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS project_services (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  service_key TEXT NOT NULL,
  name TEXT NOT NULL,
  region TEXT NOT NULL,
  timezone TEXT NOT NULL,
  repository_id TEXT REFERENCES project_repositories(id) ON DELETE SET NULL,
  branch TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, service_key)
);

CREATE TABLE IF NOT EXISTS project_service_repositories (
  service_id TEXT NOT NULL REFERENCES project_services(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES project_repositories(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('backend','frontend')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(service_id, role),
  UNIQUE(service_id, repository_id)
);
CREATE INDEX IF NOT EXISTS project_service_repositories_repository_idx
  ON project_service_repositories(repository_id, service_id);

${adminAccessSchema}
${adminAccessSeedSql}

CREATE TABLE IF NOT EXISTS project_servers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  service_id TEXT NOT NULL REFERENCES project_services(id) ON DELETE RESTRICT,
  alias TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  username TEXT NOT NULL,
  private_key TEXT NOT NULL,
  workdir TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, alias)
);

CREATE TABLE IF NOT EXISTS project_databases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  service_id TEXT NOT NULL REFERENCES project_services(id) ON DELETE RESTRICT,
  alias TEXT NOT NULL,
  engine TEXT NOT NULL CHECK (engine='mysql'),
  host TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  database_name TEXT NOT NULL,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  timezone TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, alias)
);
CREATE INDEX IF NOT EXISTS project_services_lookup_idx ON project_services(enabled, service_key, name);
CREATE INDEX IF NOT EXISTS project_servers_service_idx ON project_servers(service_id, enabled);
CREATE INDEX IF NOT EXISTS project_databases_service_idx ON project_databases(service_id, enabled);

CREATE TABLE IF NOT EXISTS telegram_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('bot', 'user')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('not_tested', 'ready', 'error', 'login_required')),
  status_message TEXT NOT NULL,
  credentials TEXT NOT NULL,
  bot_username TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_groups (
  id TEXT PRIMARY KEY,
  group_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  telegram_chat_id TEXT UNIQUE,
  account_id TEXT REFERENCES telegram_accounts(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  service_id TEXT REFERENCES project_services(id) ON DELETE RESTRICT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  access_mode TEXT NOT NULL CHECK (access_mode IN ('bot', 'user')),
  trigger_mode TEXT NOT NULL CHECK (trigger_mode IN ('all', 'command')),
  platform TEXT NOT NULL,
  repositories TEXT NOT NULL,
  branch TEXT,
  server_alias TEXT,
  database_alias TEXT NOT NULL,
  knowledge_scope TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('support', 'technical_alert')),
  ai_model_instance_id TEXT REFERENCES model_instances(id) ON DELETE RESTRICT,
  reply_style TEXT NOT NULL DEFAULT 'unrestricted' CHECK (reply_style IN ('human','unrestricted')),
  operation_mode TEXT NOT NULL DEFAULT 'live' CHECK(operation_mode IN ('live','learning')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_roles (
  id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL UNIQUE,
  username TEXT,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('operator', 'technical', 'reviewer', 'ignored')),
  can_correct INTEGER NOT NULL CHECK (can_correct IN (0, 1)),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  learning_source_enabled INTEGER NOT NULL DEFAULT 0 CHECK (learning_source_enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

${learningSourceObservationsSchema}

${operatorStyleSchema}

CREATE TABLE IF NOT EXISTS directives (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  scope TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('system', 'human')),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 100),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  disabled_at TEXT
);
CREATE INDEX IF NOT EXISTS directives_scope_idx ON directives(enabled, scope, priority DESC);

CREATE TABLE IF NOT EXISTS memory_facts (
  id TEXT PRIMARY KEY,
  topic_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  current_version_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('human_rule','correction','question','reply','code','document','magicbook','attachment','ai_observation','retraction')),
  source_ref TEXT,
  fact_id TEXT REFERENCES memory_facts(id) ON DELETE CASCADE,
  reply_record_id TEXT,
  content TEXT NOT NULL,
  scope TEXT NOT NULL,
  region TEXT,
  branch TEXT,
  code_revision TEXT,
  risk TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  actor TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_events_scope_idx ON memory_events(scope, occurred_at DESC);
CREATE INDEX IF NOT EXISTS memory_events_fact_idx ON memory_events(fact_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS memory_events_type_idx ON memory_events(type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS memory_versions (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  scope TEXT NOT NULL,
  region TEXT,
  branch TEXT,
  source TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  status TEXT NOT NULL CHECK (status IN ('active','candidate','conflict','superseded','disabled')),
  conflict_reason TEXT,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  created_by_event_id TEXT NOT NULL REFERENCES memory_events(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(fact_id, version_number)
);
CREATE INDEX IF NOT EXISTS memory_versions_status_idx ON memory_versions(status, scope, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_versions_fact_idx ON memory_versions(fact_id, version_number DESC);
CREATE UNIQUE INDEX IF NOT EXISTS memory_one_active_version_idx ON memory_versions(fact_id) WHERE status='active';

CREATE TABLE IF NOT EXISTS memory_version_evidence (
  memory_version_id TEXT NOT NULL REFERENCES memory_versions(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES memory_events(id) ON DELETE RESTRICT,
  PRIMARY KEY (memory_version_id, event_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  title,
  content,
  scope,
  content='memory_versions',
  content_rowid='rowid',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory_versions BEGIN
  INSERT INTO memory_fts(rowid, title, content, scope) VALUES (new.rowid, new.title, new.content, new.scope);
END;
CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON memory_versions BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, content, scope)
  VALUES ('delete', old.rowid, old.title, old.content, old.scope);
END;
CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE OF title,content,scope ON memory_versions BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, content, scope)
  VALUES ('delete', old.rowid, old.title, old.content, old.scope);
  INSERT INTO memory_fts(rowid, title, content, scope) VALUES (new.rowid, new.title, new.content, new.scope);
END;

${supportThreadSchema}
${supportThreadLinkSchema}
${adminChatSchema}
${adminChatConversationExtensionSchema}

CREATE TABLE IF NOT EXISTS support_replies (
  id TEXT PRIMARY KEY,
  thread_id TEXT REFERENCES support_threads(id) ON DELETE SET NULL,
  input_revision INTEGER CHECK (input_revision IS NULL OR input_revision >= 1),
  group_id TEXT REFERENCES telegram_groups(id) ON DELETE SET NULL,
  account_id TEXT REFERENCES telegram_accounts(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  service_id TEXT REFERENCES project_services(id) ON DELETE RESTRICT,
  telegram_message_id TEXT,
  telegram_reply_message_id TEXT,
  sender_user_id TEXT,
  sender_username TEXT,
  sender_display_name TEXT,
  sender_role TEXT CHECK (sender_role IS NULL OR sender_role IN ('operator','technical','reviewer','ignored')),
  service TEXT NOT NULL,
  service_source TEXT CHECK (service_source IS NULL OR service_source IN ('group_binding','technical_command')),
  decision TEXT NOT NULL CHECK (decision IN ('pending','reply','ignore','escalate')),
  status TEXT NOT NULL CHECK (status IN ('pending','queued','generating','sending','replied','ignored','escalated','failed','correcting','corrected','superseded')),
  code_revision TEXT,
  code_snapshot_id TEXT REFERENCES service_code_snapshots(id) ON DELETE SET NULL,
  code_sync_batch_id TEXT REFERENCES service_code_sync_batches(id) ON DELETE SET NULL,
  technical_alert_status TEXT CHECK (technical_alert_status IS NULL OR technical_alert_status IN ('sending','sent','not_configured','failed','uncertain')),
  operator_delivery_status TEXT CHECK (operator_delivery_status IS NULL OR operator_delivery_status IN ('sending','sent','failed','uncertain')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  generation_started_at TEXT,
  heartbeat_at TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  error_code TEXT,
  decision_reason TEXT,
  decision_confidence REAL CHECK (decision_confidence IS NULL OR (decision_confidence >= 0 AND decision_confidence <= 1)),
  corrected_at TEXT
);

CREATE TABLE IF NOT EXISTS support_reply_alert_deliveries (
  reply_id TEXT NOT NULL REFERENCES support_replies(id) ON DELETE CASCADE,
  alert_kind TEXT NOT NULL CHECK (alert_kind IN (
    'legacy_code_sync','code_sync_fallback','code_sync_message_evidence','support_delivery_failure',
    'escalation','code_sync_unavailable','investigation_runtime_failure'
  )),
  status TEXT NOT NULL CHECK (status IN ('sending','sent','not_configured','failed','uncertain')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (reply_id, alert_kind)
);
CREATE INDEX IF NOT EXISTS support_reply_alert_deliveries_status_idx
  ON support_reply_alert_deliveries(status, updated_at, reply_id);

CREATE TABLE IF NOT EXISTS support_reply_payloads (
  reply_id TEXT PRIMARY KEY REFERENCES support_replies(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  quote_text TEXT,
  has_attachment INTEGER NOT NULL DEFAULT 0 CHECK (has_attachment IN (0, 1))
);

CREATE TABLE IF NOT EXISTS shadow_answer_results (
  id TEXT PRIMARY KEY,
  reply_id TEXT NOT NULL UNIQUE REFERENCES support_replies(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  input_revision INTEGER NOT NULL CHECK (input_revision >= 1),
  outcome_status TEXT NOT NULL CHECK (outcome_status IN ('completed','failed')),
  decision TEXT CHECK (decision IS NULL OR decision IN ('reply','ignore','escalate')),
  answer TEXT NOT NULL DEFAULT '',
  quote_text TEXT,
  reason TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  code_revision TEXT,
  memory_version_refs_json TEXT NOT NULL DEFAULT '[]',
  simulated_action TEXT NOT NULL,
  output_redacted INTEGER NOT NULL DEFAULT 0 CHECK (output_redacted IN (0,1)),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(thread_id,input_revision)
);
CREATE INDEX IF NOT EXISTS shadow_answer_results_status_idx
  ON shadow_answer_results(outcome_status,created_at,id);
CREATE INDEX IF NOT EXISTS shadow_answer_results_thread_idx
  ON shadow_answer_results(thread_id,input_revision);

CREATE TABLE IF NOT EXISTS shadow_human_answer_links (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL REFERENCES learning_source_observations(id) ON DELETE RESTRICT,
  human_message_event_id TEXT NOT NULL REFERENCES support_message_events(id) ON DELETE RESTRICT,
  thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  input_revision INTEGER NOT NULL CHECK (input_revision >= 1),
  shadow_result_id TEXT REFERENCES shadow_answer_results(id) ON DELETE SET NULL,
  match_reason TEXT NOT NULL CHECK (match_reason IN ('direct','split_family')),
  match_confidence REAL NOT NULL CHECK (match_confidence >= 0 AND match_confidence <= 1),
  created_at TEXT NOT NULL,
  UNIQUE(human_message_event_id,thread_id,input_revision)
);
CREATE INDEX IF NOT EXISTS shadow_human_answer_links_thread_idx
  ON shadow_human_answer_links(thread_id,input_revision,created_at,id);
CREATE INDEX IF NOT EXISTS shadow_human_answer_links_observation_idx
  ON shadow_human_answer_links(observation_id,created_at,id);

CREATE TABLE IF NOT EXISTS shadow_learning_reports (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('scheduled','manual')),
  due_at TEXT NOT NULL,
  cutoff_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
  claim_token TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  sample_count INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  summary_json TEXT,
  rendered_markdown TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shadow_learning_reports_due_idx
  ON shadow_learning_reports(status,due_at,id);

CREATE TABLE IF NOT EXISTS shadow_comparisons (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES shadow_learning_reports(id) ON DELETE CASCADE,
  shadow_result_id TEXT REFERENCES shadow_answer_results(id) ON DELETE SET NULL,
  thread_id TEXT REFERENCES support_threads(id) ON DELETE SET NULL,
  input_revision INTEGER NOT NULL CHECK (input_revision >= 1),
  question_snapshot TEXT NOT NULL,
  shadow_answer_snapshot TEXT NOT NULL,
  human_answers_json TEXT NOT NULL DEFAULT '[]',
  human_message_event_ids_json TEXT NOT NULL DEFAULT '[]',
  comparison_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(report_id,shadow_result_id)
);
CREATE INDEX IF NOT EXISTS shadow_comparisons_report_idx
  ON shadow_comparisons(report_id,created_at,id);

INSERT INTO shadow_learning_reports(
  id,trigger_type,due_at,cutoff_at,status,claim_token,attempt_count,sample_count,
  summary_json,rendered_markdown,error_message,started_at,completed_at,created_at,updated_at
) SELECT
  '00000000-0000-4000-8000-000000000029','scheduled',
  '2026-08-20T15:00:00.000Z','2026-08-20T15:00:00.000Z','pending',NULL,0,0,
  NULL,NULL,NULL,NULL,NULL,'2026-08-19T00:00:00.000Z','2026-08-19T00:00:00.000Z'
WHERE NOT EXISTS (
  SELECT 1 FROM shadow_learning_reports
  WHERE trigger_type='scheduled' AND due_at='2026-08-20T15:00:00.000Z'
    AND cutoff_at='2026-08-20T15:00:00.000Z'
);

CREATE TABLE IF NOT EXISTS support_attachments (
  id TEXT PRIMARY KEY,
  reply_id TEXT NOT NULL REFERENCES support_replies(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK (file_size >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('text','image','video','archive','pdf','other')),
  storage_path TEXT NOT NULL,
  extracted_text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS support_attachments_reply_idx ON support_attachments(reply_id, created_at);
CREATE INDEX IF NOT EXISTS support_attachments_retention_idx
  ON support_attachments(created_at,id) WHERE storage_path<>'';
CREATE INDEX IF NOT EXISTS support_replies_work_idx ON support_replies(status, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS support_replies_status_recent_idx ON support_replies(status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS support_replies_project_idx ON support_replies(project_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS support_replies_project_recent_idx ON support_replies(project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS support_replies_group_idx ON support_replies(group_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS support_replies_group_recent_idx ON support_replies(group_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS support_replies_service_idx ON support_replies(service_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS support_replies_service_recent_idx ON support_replies(service_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS support_replies_recent_idx ON support_replies(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS support_replies_sender_recent_idx ON support_replies(sender_user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS support_replies_role_recent_idx ON support_replies(sender_role, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS support_replies_thread_idx ON support_replies(thread_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS support_replies_thread_revision_idx ON support_replies(thread_id, input_revision DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS support_replies_thread_status_idx ON support_replies(thread_id, status);
CREATE INDEX IF NOT EXISTS support_replies_group_message_idx
  ON support_replies(group_id, telegram_reply_message_id, created_at DESC, id DESC)
  WHERE telegram_reply_message_id IS NOT NULL;

${supportSenderFocusSchema}

${telegramOutputOwnershipSchema}

CREATE VIRTUAL TABLE IF NOT EXISTS support_reply_fts USING fts5(
  reply_id UNINDEXED,
  question,
  answer,
  service,
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS support_reply_fts_insert AFTER INSERT ON support_reply_payloads BEGIN
  INSERT INTO support_reply_fts(reply_id,question,answer,service)
    SELECT new.reply_id,new.question,new.answer,service FROM support_replies WHERE id=new.reply_id;
END;
CREATE TRIGGER IF NOT EXISTS support_reply_fts_update AFTER UPDATE OF question,answer ON support_reply_payloads BEGIN
  DELETE FROM support_reply_fts WHERE reply_id=old.reply_id;
  INSERT INTO support_reply_fts(reply_id,question,answer,service)
    SELECT new.reply_id,new.question,new.answer,service FROM support_replies WHERE id=new.reply_id;
END;
CREATE TRIGGER IF NOT EXISTS support_reply_fts_delete AFTER DELETE ON support_reply_payloads BEGIN
  DELETE FROM support_reply_fts WHERE reply_id=old.reply_id;
END;

CREATE TABLE IF NOT EXISTS reply_memory_refs (
  reply_id TEXT NOT NULL REFERENCES support_replies(id) ON DELETE CASCADE,
  memory_version_id TEXT NOT NULL REFERENCES memory_versions(id) ON DELETE RESTRICT,
  PRIMARY KEY (reply_id, memory_version_id)
);

CREATE TABLE IF NOT EXISTS memory_maintenance_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  scanned_events INTEGER NOT NULL DEFAULT 0,
  created_versions INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

${referenceLearningResultsSchema}

CREATE TABLE IF NOT EXISTS model_instances (
  id TEXT PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (provider IN ('openai','deepseek','anthropic','glm')),
  transport TEXT NOT NULL CHECK (transport IN ('codex_cli','direct_api')),
  model_id TEXT NOT NULL,
  reasoning_effort TEXT CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('none','minimal','low','medium','high','xhigh','max','ultra')),
  service_tier TEXT CHECK (service_tier IS NULL OR service_tier IN ('standard','fast','priority')),
  parameters_json TEXT NOT NULL DEFAULT '{}',
  credentials TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  health_status TEXT NOT NULL CHECK (health_status IN ('not_tested','ready','error')),
  health_message TEXT NOT NULL,
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_catalog_entries (
  provider TEXT NOT NULL CHECK (provider IN ('openai','deepseek','anthropic','glm')),
  transport TEXT NOT NULL CHECK (transport IN ('codex_cli','direct_api')),
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  hidden INTEGER NOT NULL CHECK (hidden IN (0, 1)),
  deprecated INTEGER NOT NULL CHECK (deprecated IN (0, 1)),
  upgrade_model_id TEXT,
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY(provider,transport,model_id)
);

CREATE TABLE IF NOT EXISTS runtime_model_bindings (
  purpose TEXT PRIMARY KEY CHECK (purpose IN ('answer','memory')),
  model_instance_id TEXT NOT NULL REFERENCES model_instances(id) ON DELETE RESTRICT,
  timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds BETWEEN 30 AND 3600),
  max_concurrency INTEGER NOT NULL CHECK (max_concurrency BETWEEN 1 AND 8),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_settings (
  id INTEGER PRIMARY KEY CHECK (id=1),
  telegram_enabled INTEGER NOT NULL CHECK (telegram_enabled IN (0, 1)),
  code_sync_enabled INTEGER NOT NULL CHECK (code_sync_enabled IN (0, 1)),
  auto_learning_enabled INTEGER NOT NULL CHECK (auto_learning_enabled IN (0, 1)),
  learning_interval_seconds INTEGER NOT NULL CHECK (learning_interval_seconds BETWEEN 30 AND 86400),
  learning_batch_size INTEGER NOT NULL CHECK (learning_batch_size BETWEEN 2 AND 50),
  message_debounce_ms INTEGER NOT NULL CHECK (message_debounce_ms BETWEEN 0 AND 300000),
  progress_notification_seconds INTEGER NOT NULL CHECK (progress_notification_seconds BETWEEN 30 AND 3600),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_group_shutdown_schedule (
  id INTEGER PRIMARY KEY CHECK (id=1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  local_time TEXT NOT NULL CHECK (
    local_time GLOB '[0-2][0-9]:[0-5][0-9]'
    AND CAST(substr(local_time,1,2) AS INTEGER) BETWEEN 0 AND 23
  ),
  timezone TEXT NOT NULL CHECK (timezone='Asia/Shanghai'),
  last_run_local_date TEXT,
  last_run_at TEXT,
  last_disabled_count INTEGER NOT NULL DEFAULT 0 CHECK (last_disabled_count>=0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS code_sync_runs (
  id TEXT PRIMARY KEY,
  batch_id TEXT REFERENCES service_code_sync_batches(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  service_id TEXT REFERENCES project_services(id) ON DELETE SET NULL,
  repository_id TEXT REFERENCES project_repositories(id) ON DELETE SET NULL,
  repository_role TEXT CHECK (repository_role IS NULL OR repository_role IN ('backend','frontend')),
  branch TEXT NOT NULL,
  commit_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  error_code TEXT,
  stage TEXT,
  error_type TEXT,
  safe_summary TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS code_sync_runs_service_idx ON code_sync_runs(service_id, started_at DESC);

CREATE TABLE IF NOT EXISTS service_code_sync_batches (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  service_id TEXT REFERENCES project_services(id) ON DELETE SET NULL,
  trigger_source TEXT NOT NULL CHECK (trigger_source IN ('answer','hourly','manual','learning')),
  branch TEXT NOT NULL,
  repository_pair_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','published','fallback','failed','interrupted')),
  snapshot_id TEXT REFERENCES service_code_snapshots(id) ON DELETE SET NULL,
  fallback_snapshot_id TEXT REFERENCES service_code_snapshots(id) ON DELETE SET NULL,
  error_repository_role TEXT CHECK (error_repository_role IS NULL OR error_repository_role IN ('backend','frontend')),
  error_repository_name TEXT,
  error_stage TEXT,
  error_type TEXT,
  exit_code INTEGER,
  safe_summary TEXT,
  alert_status TEXT CHECK (alert_status IS NULL OR alert_status IN ('sent','not_configured','failed','uncertain','suppressed')),
  alert_error_type TEXT,
  alert_summary TEXT,
  alert_fingerprint TEXT,
  alerted_at TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0)
);
CREATE INDEX IF NOT EXISTS service_code_sync_batches_service_idx
  ON service_code_sync_batches(service_id, started_at DESC);

CREATE TABLE IF NOT EXISTS service_code_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  service_id TEXT REFERENCES project_services(id) ON DELETE SET NULL,
  branch TEXT NOT NULL,
  repository_pair_fingerprint TEXT NOT NULL,
  commit_pair_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('published','deleting')),
  created_at TEXT NOT NULL,
  published_at TEXT NOT NULL,
  UNIQUE(service_id, branch, repository_pair_fingerprint, commit_pair_fingerprint)
);
CREATE INDEX IF NOT EXISTS service_code_snapshots_service_idx
  ON service_code_snapshots(service_id, branch, repository_pair_fingerprint, published_at DESC);

CREATE TABLE IF NOT EXISTS service_code_snapshot_items (
  snapshot_id TEXT NOT NULL REFERENCES service_code_snapshots(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('backend','frontend')),
  repository_id TEXT REFERENCES project_repositories(id) ON DELETE SET NULL,
  repository_name TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, role)
);

CREATE TABLE IF NOT EXISTS service_code_sync_schedule (
  service_id TEXT PRIMARY KEY REFERENCES project_services(id) ON DELETE CASCADE,
  next_hourly_sync_at TEXT NOT NULL,
  health_status TEXT NOT NULL CHECK (health_status IN ('healthy','failed','never')),
  last_success_at TEXT,
  last_failure_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_alert_fingerprint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS service_code_sync_schedule_due_idx
  ON service_code_sync_schedule(next_hourly_sync_at, service_id);

CREATE TABLE IF NOT EXISTS memory_learning_queue (
  reply_id TEXT PRIMARY KEY REFERENCES support_replies(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL,
  locked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_learning_queue_work_idx ON memory_learning_queue(status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS telegram_offsets (
  account_id TEXT PRIMARY KEY REFERENCES telegram_accounts(id) ON DELETE CASCADE,
  last_update_id INTEGER NOT NULL CHECK (last_update_id >= 0),
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO model_instances(
  id,alias,provider,transport,model_id,reasoning_effort,service_tier,parameters_json,credentials,
  enabled,health_status,health_message,last_checked_at,created_at,updated_at
) VALUES
  ('00000000-0000-4000-8000-000000000001','默认回答模型','openai','codex_cli','gpt-5.6-terra','medium','standard','{}',NULL,1,'not_tested','尚未检测',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000002','默认记忆模型','openai','codex_cli','gpt-5.6-luna','low','standard','{}',NULL,1,'not_tested','尚未检测',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR IGNORE INTO runtime_model_bindings(
  purpose,model_instance_id,timeout_seconds,max_concurrency,enabled,updated_at
) VALUES
  ('answer','00000000-0000-4000-8000-000000000001',3600,2,1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('memory','00000000-0000-4000-8000-000000000002',120,1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR IGNORE INTO runtime_settings(
  id,telegram_enabled,code_sync_enabled,auto_learning_enabled,
  learning_interval_seconds,learning_batch_size,message_debounce_ms,progress_notification_seconds,updated_at
) VALUES (1,1,1,1,60,10,30000,180,strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR IGNORE INTO daily_group_shutdown_schedule(
  id,enabled,local_time,timezone,last_run_local_date,last_run_at,last_disabled_count,updated_at
) VALUES (1,0,'23:00','Asia/Shanghai',NULL,NULL,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  scope TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_document_fts USING fts5(
  id UNINDEXED,
  title,
  content,
  scope,
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS memory_events_no_update BEFORE UPDATE ON memory_events
WHEN COALESCE((SELECT value FROM metadata WHERE key='allow_maintenance_delete'), '0') != '1'
BEGIN SELECT RAISE(ABORT, 'memory events are append only'); END;

CREATE TRIGGER IF NOT EXISTS memory_events_no_delete BEFORE DELETE ON memory_events
WHEN COALESCE((SELECT value FROM metadata WHERE key='allow_maintenance_delete'), '0') != '1'
BEGIN SELECT RAISE(ABORT, 'memory events are append only'); END;

CREATE TRIGGER IF NOT EXISTS memory_version_content_immutable BEFORE UPDATE OF title,content,content_hash,scope,region,branch,source,risk,confidence,created_by_event_id,created_at ON memory_versions
WHEN COALESCE((SELECT value FROM metadata WHERE key='allow_maintenance_delete'), '0') != '1'
BEGIN SELECT RAISE(ABORT, 'memory version content is immutable'); END;

CREATE TRIGGER IF NOT EXISTS system_directives_no_update BEFORE UPDATE ON directives
WHEN old.source='system' AND COALESCE((SELECT value FROM metadata WHERE key='allow_maintenance_delete'), '0') != '1'
BEGIN SELECT RAISE(ABORT, 'system directives are immutable'); END;

CREATE TRIGGER IF NOT EXISTS system_directives_no_delete BEFORE DELETE ON directives
WHEN old.source='system' AND COALESCE((SELECT value FROM metadata WHERE key='allow_maintenance_delete'), '0') != '1'
BEGIN SELECT RAISE(ABORT, 'system directives are immutable'); END;

INSERT OR IGNORE INTO metadata(key, value) VALUES ('schema_version', '${DATABASE_SCHEMA_VERSION}');
INSERT INTO metadata(key, value) VALUES ('memory_generation', '0') ON CONFLICT(key) DO NOTHING;
INSERT INTO metadata(key, value) VALUES ('allow_maintenance_delete', '0') ON CONFLICT(key) DO NOTHING;
INSERT INTO metadata(key, value) VALUES ('allow_support_history_import', '0')
  ON CONFLICT(key) DO UPDATE SET value='0';
INSERT INTO metadata(key, value) VALUES ('support_reply_fts_ready', '0') ON CONFLICT(key) DO NOTHING;
`

function migrateV2ToV3(connection: DatabaseSync): void {
  connection.exec("PRAGMA foreign_keys=OFF")
  try {
    connection.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, project_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)), default_knowledge_scope TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE project_repositories (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        name TEXT NOT NULL, local_path TEXT NOT NULL, remote_url TEXT NOT NULL, branch TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(project_id, name)
      );
      CREATE TABLE project_services (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        service_key TEXT NOT NULL, name TEXT NOT NULL, region TEXT NOT NULL, timezone TEXT NOT NULL,
        repository_id TEXT REFERENCES project_repositories(id) ON DELETE SET NULL, branch TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(project_id, service_key)
      );
      CREATE TABLE project_servers (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        service_id TEXT NOT NULL REFERENCES project_services(id) ON DELETE RESTRICT, alias TEXT NOT NULL,
        host TEXT NOT NULL, port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535), username TEXT NOT NULL,
        private_key TEXT NOT NULL, workdir TEXT NOT NULL, enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, alias)
      );
      CREATE TABLE project_databases (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        service_id TEXT NOT NULL REFERENCES project_services(id) ON DELETE RESTRICT, alias TEXT NOT NULL,
        engine TEXT NOT NULL CHECK (engine='mysql'), host TEXT NOT NULL,
        port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535), database_name TEXT NOT NULL,
        username TEXT NOT NULL, password TEXT NOT NULL, timezone TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(project_id, alias)
      );
      ALTER TABLE telegram_groups ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT;
      ALTER TABLE telegram_groups ADD COLUMN service_id TEXT REFERENCES project_services(id) ON DELETE RESTRICT;

      ALTER TABLE reply_memory_refs RENAME TO reply_memory_refs_v2;
      ALTER TABLE support_replies RENAME TO support_replies_v2;
      CREATE TABLE support_replies (
        id TEXT PRIMARY KEY,
        group_id TEXT REFERENCES telegram_groups(id) ON DELETE SET NULL,
        account_id TEXT REFERENCES telegram_accounts(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
        service_id TEXT REFERENCES project_services(id) ON DELETE RESTRICT,
        telegram_message_id TEXT, telegram_reply_message_id TEXT, service TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('pending','reply','ignore','escalate')),
        status TEXT NOT NULL CHECK (status IN ('pending','queued','generating','sending','replied','ignored','escalated','failed','correcting','corrected')),
        code_revision TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        generation_started_at TEXT, heartbeat_at TEXT,
        duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0), error_code TEXT, corrected_at TEXT
      );
      CREATE TABLE support_reply_payloads (
        reply_id TEXT PRIMARY KEY REFERENCES support_replies(id) ON DELETE CASCADE,
        question TEXT NOT NULL, answer TEXT NOT NULL, quote_text TEXT,
        has_attachment INTEGER NOT NULL DEFAULT 0 CHECK (has_attachment IN (0, 1))
      );
      INSERT INTO support_replies(
        id,group_id,account_id,telegram_message_id,telegram_reply_message_id,service,decision,status,
        code_revision,created_at,updated_at,corrected_at
      ) SELECT id,group_id,account_id,telegram_message_id,telegram_reply_message_id,service,decision,status,
        code_revision,created_at,created_at,corrected_at FROM support_replies_v2;
      INSERT INTO support_reply_payloads(reply_id,question,answer,quote_text)
        SELECT id,question,answer,quote_text FROM support_replies_v2;
      CREATE TABLE reply_memory_refs (
        reply_id TEXT NOT NULL REFERENCES support_replies(id) ON DELETE CASCADE,
        memory_version_id TEXT NOT NULL REFERENCES memory_versions(id) ON DELETE RESTRICT,
        PRIMARY KEY (reply_id, memory_version_id)
      );
      INSERT INTO reply_memory_refs(reply_id,memory_version_id)
        SELECT reply_id,memory_version_id FROM reply_memory_refs_v2;
      DROP TABLE reply_memory_refs_v2;
      DROP TABLE support_replies_v2;

      CREATE INDEX project_services_lookup_idx ON project_services(enabled, service_key, name);
      CREATE INDEX project_servers_service_idx ON project_servers(service_id, enabled);
      CREATE INDEX project_databases_service_idx ON project_databases(service_id, enabled);
      CREATE INDEX support_replies_work_idx ON support_replies(status, updated_at DESC, id DESC);
      CREATE INDEX support_replies_status_recent_idx ON support_replies(status, created_at DESC, id DESC);
      CREATE INDEX support_replies_project_idx ON support_replies(project_id, status, created_at DESC, id DESC);
      CREATE INDEX support_replies_project_recent_idx ON support_replies(project_id, created_at DESC, id DESC);
      CREATE INDEX support_replies_group_idx ON support_replies(group_id, status, created_at DESC, id DESC);
      CREATE INDEX support_replies_group_recent_idx ON support_replies(group_id, created_at DESC, id DESC);
      CREATE INDEX support_replies_service_idx ON support_replies(service_id, status, created_at DESC, id DESC);
      CREATE INDEX support_replies_service_recent_idx ON support_replies(service_id, created_at DESC, id DESC);
      CREATE INDEX support_replies_recent_idx ON support_replies(created_at DESC, id DESC);
      UPDATE metadata SET value='3' WHERE key='schema_version';
      COMMIT;
    `)
  } catch (error) {
    try { connection.exec("ROLLBACK") } catch { /* 事务已结束时无需处理。 */ }
    throw error
  } finally {
    connection.exec("PRAGMA foreign_keys=ON")
  }
}

function migrateV3ToV4(connection: DatabaseSync): void {
  connection.prepare("UPDATE metadata SET value='4' WHERE key='schema_version'").run()
}

function migrateV4ToV5(connection: DatabaseSync): void {
  connection.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE support_replies ADD COLUMN sender_user_id TEXT;
    ALTER TABLE support_replies ADD COLUMN sender_username TEXT;
    ALTER TABLE support_replies ADD COLUMN sender_display_name TEXT;
    ALTER TABLE support_replies ADD COLUMN sender_role TEXT CHECK (sender_role IS NULL OR sender_role IN ('operator','technical','reviewer','ignored'));
    ALTER TABLE support_replies ADD COLUMN service_source TEXT CHECK (service_source IS NULL OR service_source IN ('group_binding','technical_command'));
    ALTER TABLE support_replies ADD COLUMN decision_reason TEXT;
    ALTER TABLE support_replies ADD COLUMN decision_confidence REAL CHECK (decision_confidence IS NULL OR (decision_confidence >= 0 AND decision_confidence <= 1));
    CREATE INDEX support_replies_sender_recent_idx ON support_replies(sender_user_id, created_at DESC, id DESC);
    CREATE INDEX support_replies_role_recent_idx ON support_replies(sender_role, created_at DESC, id DESC);
    UPDATE metadata SET value='5' WHERE key='schema_version';
    COMMIT;
  `)
}

function migrateV5ToV6(connection: DatabaseSync): void {
  connection.exec("PRAGMA foreign_keys=OFF")
  try {
    connection.exec(`
      BEGIN IMMEDIATE;
      DROP TRIGGER IF EXISTS support_reply_fts_insert;
      DROP TRIGGER IF EXISTS support_reply_fts_update;
      DROP TRIGGER IF EXISTS support_reply_fts_delete;

      ALTER TABLE support_reply_payloads RENAME TO support_reply_payloads_v5;
      ALTER TABLE support_attachments RENAME TO support_attachments_v5;
      ALTER TABLE reply_memory_refs RENAME TO reply_memory_refs_v5;
      ALTER TABLE memory_learning_queue RENAME TO memory_learning_queue_v5;
      ALTER TABLE support_replies RENAME TO support_replies_v5;

      DROP INDEX IF EXISTS support_attachments_reply_idx;
      DROP INDEX IF EXISTS support_replies_work_idx;
      DROP INDEX IF EXISTS support_replies_status_recent_idx;
      DROP INDEX IF EXISTS support_replies_project_idx;
      DROP INDEX IF EXISTS support_replies_project_recent_idx;
      DROP INDEX IF EXISTS support_replies_group_idx;
      DROP INDEX IF EXISTS support_replies_group_recent_idx;
      DROP INDEX IF EXISTS support_replies_service_idx;
      DROP INDEX IF EXISTS support_replies_service_recent_idx;
      DROP INDEX IF EXISTS support_replies_recent_idx;
      DROP INDEX IF EXISTS support_replies_sender_recent_idx;
      DROP INDEX IF EXISTS support_replies_role_recent_idx;
      DROP INDEX IF EXISTS memory_learning_queue_work_idx;

      ${supportThreadSchema}

      CREATE TABLE support_replies (
        id TEXT PRIMARY KEY,
        thread_id TEXT REFERENCES support_threads(id) ON DELETE SET NULL,
        input_revision INTEGER CHECK (input_revision IS NULL OR input_revision >= 1),
        group_id TEXT REFERENCES telegram_groups(id) ON DELETE SET NULL,
        account_id TEXT REFERENCES telegram_accounts(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
        service_id TEXT REFERENCES project_services(id) ON DELETE RESTRICT,
        telegram_message_id TEXT,
        telegram_reply_message_id TEXT,
        sender_user_id TEXT,
        sender_username TEXT,
        sender_display_name TEXT,
        sender_role TEXT CHECK (sender_role IS NULL OR sender_role IN ('operator','technical','reviewer','ignored')),
        service TEXT NOT NULL,
        service_source TEXT CHECK (service_source IS NULL OR service_source IN ('group_binding','technical_command')),
        decision TEXT NOT NULL CHECK (decision IN ('pending','reply','ignore','escalate')),
        status TEXT NOT NULL CHECK (status IN ('pending','queued','generating','sending','replied','ignored','escalated','failed','correcting','corrected','superseded')),
        code_revision TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        generation_started_at TEXT,
        heartbeat_at TEXT,
        duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
        error_code TEXT,
        decision_reason TEXT,
        decision_confidence REAL CHECK (decision_confidence IS NULL OR (decision_confidence >= 0 AND decision_confidence <= 1)),
        corrected_at TEXT
      );
      CREATE TABLE support_reply_payloads (
        reply_id TEXT PRIMARY KEY REFERENCES support_replies(id) ON DELETE CASCADE,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        quote_text TEXT,
        has_attachment INTEGER NOT NULL DEFAULT 0 CHECK (has_attachment IN (0, 1))
      );
      CREATE TABLE support_attachments (
        id TEXT PRIMARY KEY,
        reply_id TEXT NOT NULL REFERENCES support_replies(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size INTEGER NOT NULL CHECK (file_size >= 0),
        kind TEXT NOT NULL CHECK (kind IN ('text','image','video','archive','pdf','other')),
        storage_path TEXT NOT NULL,
        extracted_text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE reply_memory_refs (
        reply_id TEXT NOT NULL REFERENCES support_replies(id) ON DELETE CASCADE,
        memory_version_id TEXT NOT NULL REFERENCES memory_versions(id) ON DELETE RESTRICT,
        PRIMARY KEY (reply_id, memory_version_id)
      );
      CREATE TABLE memory_learning_queue (
        reply_id TEXT PRIMARY KEY REFERENCES support_replies(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TEXT NOT NULL,
        locked_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO support_replies(
        id,thread_id,input_revision,group_id,account_id,project_id,service_id,telegram_message_id,
        telegram_reply_message_id,sender_user_id,sender_username,sender_display_name,sender_role,service,
        service_source,decision,status,code_revision,created_at,updated_at,generation_started_at,heartbeat_at,
        duration_ms,error_code,decision_reason,decision_confidence,corrected_at
      ) SELECT
        id,NULL,NULL,group_id,account_id,project_id,service_id,telegram_message_id,
        telegram_reply_message_id,sender_user_id,sender_username,sender_display_name,sender_role,service,
        service_source,decision,status,code_revision,created_at,updated_at,generation_started_at,heartbeat_at,
        duration_ms,error_code,decision_reason,decision_confidence,corrected_at
      FROM support_replies_v5;
      INSERT INTO support_reply_payloads SELECT * FROM support_reply_payloads_v5;
      INSERT INTO support_attachments SELECT * FROM support_attachments_v5;
      INSERT INTO reply_memory_refs SELECT * FROM reply_memory_refs_v5;
      INSERT INTO memory_learning_queue SELECT * FROM memory_learning_queue_v5;

      DROP TABLE support_reply_payloads_v5;
      DROP TABLE support_attachments_v5;
      DROP TABLE reply_memory_refs_v5;
      DROP TABLE memory_learning_queue_v5;
      DROP TABLE support_replies_v5;

      CREATE INDEX support_attachments_reply_idx ON support_attachments(reply_id, created_at);
      CREATE INDEX support_replies_work_idx ON support_replies(status, updated_at DESC, id DESC);
      CREATE INDEX support_replies_status_recent_idx ON support_replies(status, created_at DESC, id DESC);
      CREATE INDEX support_replies_project_idx ON support_replies(project_id, status, created_at DESC, id DESC);
      CREATE INDEX support_replies_project_recent_idx ON support_replies(project_id, created_at DESC, id DESC);
      CREATE INDEX support_replies_group_idx ON support_replies(group_id, status, created_at DESC, id DESC);
      CREATE INDEX support_replies_group_recent_idx ON support_replies(group_id, created_at DESC, id DESC);
      CREATE INDEX support_replies_service_idx ON support_replies(service_id, status, created_at DESC, id DESC);
      CREATE INDEX support_replies_service_recent_idx ON support_replies(service_id, created_at DESC, id DESC);
      CREATE INDEX support_replies_recent_idx ON support_replies(created_at DESC, id DESC);
      CREATE INDEX support_replies_sender_recent_idx ON support_replies(sender_user_id, created_at DESC, id DESC);
      CREATE INDEX support_replies_role_recent_idx ON support_replies(sender_role, created_at DESC, id DESC);
      CREATE INDEX support_replies_thread_idx ON support_replies(thread_id, created_at DESC, id DESC);
      CREATE INDEX memory_learning_queue_work_idx ON memory_learning_queue(status, next_attempt_at, created_at);

      CREATE TRIGGER support_reply_fts_insert AFTER INSERT ON support_reply_payloads BEGIN
        INSERT INTO support_reply_fts(reply_id,question,answer,service)
          SELECT new.reply_id,new.question,new.answer,service FROM support_replies WHERE id=new.reply_id;
      END;
      CREATE TRIGGER support_reply_fts_update AFTER UPDATE OF question,answer ON support_reply_payloads BEGIN
        DELETE FROM support_reply_fts WHERE reply_id=old.reply_id;
        INSERT INTO support_reply_fts(reply_id,question,answer,service)
          SELECT new.reply_id,new.question,new.answer,service FROM support_replies WHERE id=new.reply_id;
      END;
      CREATE TRIGGER support_reply_fts_delete AFTER DELETE ON support_reply_payloads BEGIN
        DELETE FROM support_reply_fts WHERE reply_id=old.reply_id;
      END;

      UPDATE metadata SET value='6' WHERE key='schema_version';
      COMMIT;
    `)
  } catch (error) {
    try { connection.exec("ROLLBACK") } catch { /* 事务已结束时无需处理。 */ }
    throw error
  } finally {
    connection.exec("PRAGMA foreign_keys=ON")
  }
}

function migrateV6ToV7(connection: DatabaseSync): void {
  connection.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE support_threads ADD COLUMN generation_started_at TEXT;
    ALTER TABLE support_threads ADD COLUMN progress_due_at TEXT;
    ALTER TABLE support_threads ADD COLUMN hard_deadline_at TEXT;
    ALTER TABLE support_threads ADD COLUMN closed_at TEXT;
    ALTER TABLE support_threads ADD COLUMN closed_by TEXT;
    ALTER TABLE support_threads ADD COLUMN closed_reason TEXT;
    CREATE INDEX support_threads_progress_due_idx ON support_threads(status,progress_due_at);
    CREATE INDEX support_threads_hard_deadline_idx ON support_threads(status,hard_deadline_at);
    CREATE TABLE support_thread_notifications (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
      input_revision INTEGER NOT NULL CHECK(input_revision >= 1),
      kind TEXT NOT NULL CHECK(kind IN ('progress','timeout_operator','timeout_alert')),
      status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','unknown')),
      due_at TEXT NOT NULL,
      telegram_message_id TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(thread_id,input_revision,kind)
    );
    CREATE INDEX support_thread_notifications_due_idx ON support_thread_notifications(status,due_at,id);
    UPDATE metadata SET value='7' WHERE key='schema_version';
    COMMIT;
  `)
}

function migrateV7ToV8(connection: DatabaseSync): void {
  connection.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE model_profiles RENAME TO model_profiles_v7;
    CREATE TABLE model_profiles (
      purpose TEXT PRIMARY KEY CHECK (purpose IN ('answer','memory')),
      model TEXT NOT NULL,
      reasoning_effort TEXT NOT NULL CHECK (reasoning_effort IN ('minimal','low','medium','high','xhigh')),
      timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds BETWEEN 30 AND 3600),
      max_concurrency INTEGER NOT NULL CHECK (max_concurrency BETWEEN 1 AND 8),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      updated_at TEXT NOT NULL
    );
    INSERT INTO model_profiles(purpose,model,reasoning_effort,timeout_seconds,max_concurrency,enabled,updated_at)
      SELECT purpose,model,reasoning_effort,
        CASE WHEN purpose='answer' THEN 3600 ELSE timeout_seconds END,
        max_concurrency,enabled,strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM model_profiles_v7;
    DROP TABLE model_profiles_v7;
    UPDATE metadata SET value='8' WHERE key='schema_version';
    COMMIT;
  `)
}

function migrateV8ToV9(connection: DatabaseSync): void {
  connection.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE runtime_settings ADD COLUMN progress_notification_seconds INTEGER NOT NULL DEFAULT 180
      CHECK (progress_notification_seconds BETWEEN 30 AND 3600);
    UPDATE metadata SET value='9' WHERE key='schema_version';
    COMMIT;
  `)
}

function migrateV9ToV10(connection: DatabaseSync): void {
  connection.exec("BEGIN IMMEDIATE")
  try {
    const eventColumns = connection.prepare("PRAGMA table_info(support_message_events)").all() as SqlRow[]
    if (!eventColumns.some((column) => column.name === "ingest_batch_id")) {
      connection.exec("ALTER TABLE support_message_events ADD COLUMN ingest_batch_id TEXT")
    }
    const threadColumns = connection.prepare("PRAGMA table_info(support_threads)").all() as SqlRow[]
    if (!threadColumns.some((column) => column.name === "origin_batch_id")) {
      connection.exec("ALTER TABLE support_threads ADD COLUMN origin_batch_id TEXT")
    }
    connection.exec(`
      ALTER TABLE runtime_settings RENAME TO runtime_settings_v9;
      CREATE TABLE runtime_settings (
        id INTEGER PRIMARY KEY CHECK (id=1),
        telegram_enabled INTEGER NOT NULL CHECK (telegram_enabled IN (0, 1)),
        code_sync_enabled INTEGER NOT NULL CHECK (code_sync_enabled IN (0, 1)),
        auto_learning_enabled INTEGER NOT NULL CHECK (auto_learning_enabled IN (0, 1)),
        learning_interval_seconds INTEGER NOT NULL CHECK (learning_interval_seconds BETWEEN 30 AND 86400),
        learning_batch_size INTEGER NOT NULL CHECK (learning_batch_size BETWEEN 2 AND 50),
        message_debounce_ms INTEGER NOT NULL CHECK (message_debounce_ms BETWEEN 0 AND 300000),
        progress_notification_seconds INTEGER NOT NULL CHECK (progress_notification_seconds BETWEEN 30 AND 3600),
        updated_at TEXT NOT NULL
      );
      INSERT INTO runtime_settings(
        id,telegram_enabled,code_sync_enabled,auto_learning_enabled,learning_interval_seconds,
        learning_batch_size,message_debounce_ms,progress_notification_seconds,updated_at
      ) SELECT id,telegram_enabled,code_sync_enabled,auto_learning_enabled,learning_interval_seconds,
        learning_batch_size,30000,progress_notification_seconds,updated_at FROM runtime_settings_v9;
      DROP TABLE runtime_settings_v9;
      CREATE INDEX IF NOT EXISTS support_message_events_batch_idx ON support_message_events(ingest_batch_id)
        WHERE ingest_batch_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS support_threads_origin_batch_unique_idx
        ON support_threads(origin_batch_id) WHERE origin_batch_id IS NOT NULL;
      ${supportThreadMessageInvariantSchema}
      UPDATE metadata SET value='10' WHERE key='schema_version';
      COMMIT;
    `)
  } catch (error) {
    try { connection.exec("ROLLBACK") } catch { /* 事务已结束时无需处理。 */ }
    throw error
  }
}

function migrateV10ToV11(connection: DatabaseSync): void {
  connection.exec("PRAGMA foreign_keys=OFF")
  try {
    connection.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE project_service_repositories (
        service_id TEXT NOT NULL REFERENCES project_services(id) ON DELETE CASCADE,
        repository_id TEXT NOT NULL REFERENCES project_repositories(id) ON DELETE RESTRICT,
        role TEXT NOT NULL CHECK (role IN ('backend','frontend')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(service_id, role),
        UNIQUE(service_id, repository_id)
      );
      CREATE INDEX project_service_repositories_repository_idx
        ON project_service_repositories(repository_id, service_id);

      CREATE TABLE service_code_sync_batches (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        service_id TEXT REFERENCES project_services(id) ON DELETE SET NULL,
        trigger_source TEXT NOT NULL CHECK (trigger_source IN ('answer','hourly','manual','learning')),
        branch TEXT NOT NULL,
        repository_pair_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running','published','fallback','failed','interrupted')),
        snapshot_id TEXT REFERENCES service_code_snapshots(id) ON DELETE SET NULL,
        fallback_snapshot_id TEXT REFERENCES service_code_snapshots(id) ON DELETE SET NULL,
        error_repository_role TEXT CHECK (error_repository_role IS NULL OR error_repository_role IN ('backend','frontend')),
        error_repository_name TEXT,
        error_stage TEXT,
        error_type TEXT,
        exit_code INTEGER,
        safe_summary TEXT,
        alert_status TEXT CHECK (alert_status IS NULL OR alert_status IN ('sent','not_configured','failed','uncertain','suppressed')),
        alert_error_type TEXT,
        alert_summary TEXT,
        alert_fingerprint TEXT,
        alerted_at TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0)
      );
      CREATE INDEX service_code_sync_batches_service_idx
        ON service_code_sync_batches(service_id, started_at DESC);

      CREATE TABLE service_code_snapshots (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        service_id TEXT REFERENCES project_services(id) ON DELETE SET NULL,
        branch TEXT NOT NULL,
        repository_pair_fingerprint TEXT NOT NULL,
        commit_pair_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('published','deleting')),
        created_at TEXT NOT NULL,
        published_at TEXT NOT NULL,
        UNIQUE(service_id, branch, repository_pair_fingerprint, commit_pair_fingerprint)
      );
      CREATE INDEX service_code_snapshots_service_idx
        ON service_code_snapshots(service_id, branch, repository_pair_fingerprint, published_at DESC);

      CREATE TABLE service_code_snapshot_items (
        snapshot_id TEXT NOT NULL REFERENCES service_code_snapshots(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('backend','frontend')),
        repository_id TEXT REFERENCES project_repositories(id) ON DELETE SET NULL,
        repository_name TEXT NOT NULL,
        commit_hash TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        PRIMARY KEY(snapshot_id, role)
      );

      CREATE TABLE service_code_sync_schedule (
        service_id TEXT PRIMARY KEY REFERENCES project_services(id) ON DELETE CASCADE,
        next_hourly_sync_at TEXT NOT NULL,
        health_status TEXT NOT NULL CHECK (health_status IN ('healthy','failed','never')),
        last_success_at TEXT,
        last_failure_at TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
        last_alert_fingerprint TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX service_code_sync_schedule_due_idx
        ON service_code_sync_schedule(next_hourly_sync_at, service_id);

      ALTER TABLE code_sync_runs ADD COLUMN batch_id TEXT REFERENCES service_code_sync_batches(id) ON DELETE CASCADE;
      ALTER TABLE code_sync_runs ADD COLUMN repository_role TEXT CHECK (repository_role IS NULL OR repository_role IN ('backend','frontend'));
      ALTER TABLE code_sync_runs ADD COLUMN stage TEXT;
      ALTER TABLE code_sync_runs ADD COLUMN error_type TEXT;
      ALTER TABLE code_sync_runs ADD COLUMN safe_summary TEXT;
      ALTER TABLE support_replies ADD COLUMN code_snapshot_id TEXT REFERENCES service_code_snapshots(id) ON DELETE SET NULL;
      ALTER TABLE support_replies ADD COLUMN code_sync_batch_id TEXT REFERENCES service_code_sync_batches(id) ON DELETE SET NULL;

      INSERT INTO project_service_repositories(service_id,repository_id,role,created_at,updated_at)
      SELECT service.id,repository.id,'backend',service.created_at,service.updated_at
      FROM project_services service
      JOIN project_repositories repository ON repository.project_id=service.project_id AND repository.name='java-project'
      WHERE (SELECT COUNT(*) FROM project_repositories candidate
        WHERE candidate.project_id=service.project_id AND candidate.name='java-project')=1;
      INSERT INTO project_service_repositories(service_id,repository_id,role,created_at,updated_at)
      SELECT service.id,repository.id,'frontend',service.created_at,service.updated_at
      FROM project_services service
      JOIN project_repositories repository ON repository.project_id=service.project_id AND repository.name='sfzf-web'
      WHERE (SELECT COUNT(*) FROM project_repositories candidate
        WHERE candidate.project_id=service.project_id AND candidate.name='sfzf-web')=1;
      INSERT INTO service_code_sync_schedule(
        service_id,next_hourly_sync_at,health_status,last_success_at,last_failure_at,failure_count,last_alert_fingerprint,created_at,updated_at
      ) SELECT id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'never',NULL,NULL,0,NULL,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM project_services;
      UPDATE metadata SET value='11' WHERE key='schema_version';
      COMMIT;
    `)
  } catch (error) {
    try { connection.exec("ROLLBACK") } catch { /* 事务已结束时无需处理。 */ }
    throw error
  } finally {
    connection.exec("PRAGMA foreign_keys=ON")
  }
}

function migrateV11ToV12(connection: DatabaseSync): void {
  connection.exec("BEGIN IMMEDIATE")
  try {
    connection.exec(`${adminChatSchema}
      UPDATE metadata SET value='12' WHERE key='schema_version';
      COMMIT;`)
  } catch (error) {
    try { connection.exec("ROLLBACK") } catch { /* 事务已结束时无需处理。 */ }
    throw error
  }
}

const defaultAnswerModelInstanceId = "00000000-0000-4000-8000-000000000001"
const defaultMemoryModelInstanceId = "00000000-0000-4000-8000-000000000002"

function tableExists(connection: DatabaseSync, table: string): boolean {
  return Boolean(connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
}

function tableColumns(connection: DatabaseSync, table: string): Set<string> {
  return new Set((connection.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[]).map((column) => String(column.name)))
}

type ColumnInvariant = {
  name: string
  type: string
  notNull: 0 | 1
  primaryKey: 0 | 1
  defaultValue?: string | null
}

type IndexColumnInvariant = { name: string; descending: number; collation: string }

function compactSchemaSql(value: unknown): string {
  const sql = String(value ?? "").trim()
  let compact = ""
  let quote: "'" | '"' | "`" | null = null
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index] ?? ""
    if (quote) {
      compact += character
      if (character === quote) {
        if (sql[index + 1] === quote) {
          compact += quote
          index += 1
        } else {
          quote = null
        }
      }
      continue
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character
      compact += character
    } else if (!/\s/u.test(character)) {
      compact += character.toLocaleLowerCase("en-US")
    }
  }
  return compact.replace(/;+$/u, "")
}

function exactColumnsMatch(connection: DatabaseSync, table: string, expected: readonly ColumnInvariant[]): boolean {
  const actual = connection.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[]
  return actual.length === expected.length && !actual.some((column, index) => {
    const invariant = expected[index]
    return !invariant || String(column.name) !== invariant.name
      || String(column.type).toLocaleUpperCase("en-US") !== invariant.type
      || Number(column.notnull) !== invariant.notNull
      || Number(column.pk) !== invariant.primaryKey
      || column.dflt_value !== (invariant.defaultValue ?? null)
  })
}

function assertExactColumns(connection: DatabaseSync, table: string, expected: readonly ColumnInvariant[], message: string): void {
  if (!exactColumnsMatch(connection, table, expected)) throw new Error(message)
}

function schemaIndexColumns(connection: DatabaseSync, name: string): IndexColumnInvariant[] {
  const escapedName = name.replaceAll('"', '""')
  return (connection.prepare(`PRAGMA index_xinfo("${escapedName}")`).all() as SqlRow[])
    .filter((column) => Number(column.key) === 1 && column.name !== null)
    .map((column) => ({
      name: String(column.name),
      descending: Number(column.desc),
      collation: String(column.coll).toLocaleUpperCase("en-US"),
    }))
}

function schemaIndexMatches(
  connection: DatabaseSync,
  index: SqlRow,
  expected: { unique: number; origin: string; columns: IndexColumnInvariant[] },
): boolean {
  return Number(index.unique) === expected.unique
    && Number(index.partial) === 0
    && String(index.origin) === expected.origin
    && JSON.stringify(schemaIndexColumns(connection, String(index.name))) === JSON.stringify(expected.columns)
}

function appendOnlyTerminalTriggerSql(operation: "update" | "delete"): string {
  return compactSchemaSql(`CREATE TRIGGER reference_learning_results_no_${operation}
    BEFORE ${operation.toLocaleUpperCase("en-US")} ON reference_learning_results
    WHEN COALESCE((SELECT value FROM metadata WHERE key='allow_maintenance_delete'), '0') != '1'
    BEGIN SELECT RAISE(ABORT, 'reference learning results are append only'); END`)
}

function appendOnlyObservationTriggerSql(operation: "update" | "delete"): string {
  if (operation === "update") {
    return compactSchemaSql(`CREATE TRIGGER learning_source_observations_no_evidence_update
      BEFORE UPDATE OF ${learningSourceObservationEvidenceColumns} ON learning_source_observations
      WHEN COALESCE((SELECT value FROM metadata WHERE key='allow_maintenance_delete'), '0') != '1'
      BEGIN SELECT RAISE(ABORT, 'learning source observations are append only'); END`)
  }
  return compactSchemaSql(`CREATE TRIGGER learning_source_observations_no_delete
    BEFORE DELETE ON learning_source_observations
    WHEN COALESCE((SELECT value FROM metadata WHERE key='allow_maintenance_delete'), '0') != '1'
    BEGIN SELECT RAISE(ABORT, 'learning source observations are append only'); END`)
}

function assertLearningSourceObservationStructure(connection: DatabaseSync): void {
  const message = "人工参考学习终态审计结构不完整"
  const columnsBeforeCurrent: ColumnInvariant[] = [
    { name: "id", type: "TEXT", notNull: 0, primaryKey: 1 },
    { name: "message_event_id", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "source_telegram_user_id", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "source_role", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "thread_id", type: "TEXT", notNull: 0, primaryKey: 0 },
    { name: "service_id", type: "TEXT", notNull: 0, primaryKey: 0 },
    { name: "association_reason", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "association_confidence", type: "REAL", notNull: 1, primaryKey: 0 },
    { name: "takeover_status", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "classification", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "risk", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "processing_status", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "attempt_count", type: "INTEGER", notNull: 1, primaryKey: 0, defaultValue: "0" },
    { name: "lock_token", type: "TEXT", notNull: 0, primaryKey: 0 },
    { name: "locked_at", type: "TEXT", notNull: 0, primaryKey: 0 },
  ]
  const currentRunColumn: ColumnInvariant = {
    name: "current_run_id", type: "TEXT", notNull: 0, primaryKey: 0,
  }
  const timestamps: ColumnInvariant[] = [
    { name: "created_at", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "updated_at", type: "TEXT", notNull: 1, primaryKey: 0 },
  ]
  const freshColumns = [...columnsBeforeCurrent, currentRunColumn, ...timestamps]
  const migratedColumns = [...columnsBeforeCurrent, ...timestamps, currentRunColumn]
  if (!exactColumnsMatch(connection, "learning_source_observations", freshColumns)
    && !exactColumnsMatch(connection, "learning_source_observations", migratedColumns)) {
    throw new Error(message)
  }
  const tableSql = compactSchemaSql((connection.prepare(`SELECT sql FROM sqlite_master
    WHERE type='table' AND name='learning_source_observations'`).get() as SqlRow | undefined)?.sql)
  const canonicalTableSql = new Set([
    compactSchemaSql(`CREATE TABLE learning_source_observations ${learningSourceObservationsTableDefinition}`),
    compactSchemaSql(`CREATE TABLE learning_source_observations ${migratedLearningSourceObservationsTableDefinition}`),
  ])
  if (!canonicalTableSql.has(tableSql)) throw new Error(message)

  const foreignKeys = connection.prepare("PRAGMA foreign_key_list(learning_source_observations)").all() as SqlRow[]
  const hasForeignKey = (from: string, table: string, onDelete: string): boolean => foreignKeys.some((row) => (
    String(row.from) === from && String(row.table) === table && String(row.to) === "id"
      && String(row.on_delete).toLocaleUpperCase("en-US") === onDelete
  ))
  if (foreignKeys.length !== 4
    || !hasForeignKey("message_event_id", "support_message_events", "CASCADE")
    || !hasForeignKey("thread_id", "support_threads", "SET NULL")
    || !hasForeignKey("service_id", "project_services", "SET NULL")
    || !hasForeignKey("current_run_id", "memory_maintenance_runs", "SET NULL")) {
    throw new Error(message)
  }

  const indexes = connection.prepare("PRAGMA index_list(learning_source_observations)").all() as SqlRow[]
  const matchesIndex = (
    name: string,
    columns: IndexColumnInvariant[],
    expectedSql: string,
  ): boolean => {
    const index = indexes.find((candidate) => String(candidate.name) === name)
    return Boolean(index && schemaIndexMatches(connection, index, { unique: 0, origin: "c", columns }))
      && compactSchemaSql((connection.prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name=?",
      ).get(name) as SqlRow | undefined)?.sql) === compactSchemaSql(expectedSql)
  }
  const hasPrimaryKey = indexes.some((index) => schemaIndexMatches(connection, index, {
    unique: 1,
    origin: "pk",
    columns: [{ name: "id", descending: 0, collation: "BINARY" }],
  }))
  const hasMessageUnique = indexes.some((index) => schemaIndexMatches(connection, index, {
    unique: 1,
    origin: "u",
    columns: [{ name: "message_event_id", descending: 0, collation: "BINARY" }],
  }))
  if (indexes.length !== 5 || !hasPrimaryKey || !hasMessageUnique
    || !matchesIndex("learning_source_observations_queue_idx", [
      { name: "processing_status", descending: 0, collation: "BINARY" },
      { name: "locked_at", descending: 0, collation: "BINARY" },
      { name: "id", descending: 0, collation: "BINARY" },
    ], `CREATE INDEX learning_source_observations_queue_idx
      ON learning_source_observations(processing_status,locked_at,id)`)
    || !matchesIndex("learning_source_observations_thread_idx", [
      { name: "thread_id", descending: 0, collation: "BINARY" },
      { name: "created_at", descending: 1, collation: "BINARY" },
    ], `CREATE INDEX learning_source_observations_thread_idx
      ON learning_source_observations(thread_id,created_at DESC)`)
    || !matchesIndex("learning_source_observations_user_idx", [
      { name: "source_telegram_user_id", descending: 0, collation: "BINARY" },
      { name: "created_at", descending: 1, collation: "BINARY" },
    ], `CREATE INDEX learning_source_observations_user_idx
      ON learning_source_observations(source_telegram_user_id,created_at DESC)`)) {
    throw new Error(message)
  }

  const triggers = new Map((connection.prepare(`SELECT name,sql FROM sqlite_master WHERE type='trigger'
    AND tbl_name='learning_source_observations'`).all() as SqlRow[]).map((row) => (
    [String(row.name), compactSchemaSql(row.sql)] as const
  )))
  if (triggers.size !== 2
    || triggers.get("learning_source_observations_no_evidence_update") !== appendOnlyObservationTriggerSql("update")
    || triggers.get("learning_source_observations_no_delete") !== appendOnlyObservationTriggerSql("delete")) {
    throw new Error(message)
  }
}

export function assertReferenceLearningAuditStructure(connection: DatabaseSync): void {
  if (!tableExists(connection, "learning_source_observations")
    || !tableExists(connection, "reference_learning_results")) {
    throw new Error("人工参考学习终态审计结构不完整")
  }
  assertLearningSourceObservationStructure(connection)
  assertExactColumns(connection, "reference_learning_results", [
    { name: "id", type: "TEXT", notNull: 0, primaryKey: 1 },
    { name: "run_id", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "observation_id", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "classification", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "action", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "risk", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "outcome", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "reason_code", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "memory_version_id", type: "TEXT", notNull: 0, primaryKey: 0 },
    { name: "operator_style_version_id", type: "TEXT", notNull: 0, primaryKey: 0 },
    { name: "created_at", type: "TEXT", notNull: 1, primaryKey: 0 },
  ], "人工参考学习终态审计结构不完整")
  const foreignKeys = connection.prepare("PRAGMA foreign_key_list(reference_learning_results)").all() as SqlRow[]
  const hasForeignKey = (from: string, table: string, onDelete: string): boolean => foreignKeys.some((row) => (
    String(row.from) === from && String(row.table) === table && String(row.to) === "id"
      && String(row.on_delete).toUpperCase() === onDelete
  ))
  if (foreignKeys.length !== 2
    || !hasForeignKey("run_id", "memory_maintenance_runs", "CASCADE")
    || !hasForeignKey("observation_id", "learning_source_observations", "CASCADE")) {
    throw new Error("人工参考学习终态审计结构不完整")
  }
  const indexes = connection.prepare("PRAGMA index_list(reference_learning_results)").all() as SqlRow[]
  const hasPrimaryKeyIndex = indexes.some((index) => schemaIndexMatches(connection, index, {
    unique: 1,
    origin: "pk",
    columns: [{ name: "id", descending: 0, collation: "BINARY" }],
  }))
  const hasRunObservationUnique = indexes.some((index) => schemaIndexMatches(connection, index, {
    unique: 1,
    origin: "u",
    columns: [
      { name: "run_id", descending: 0, collation: "BINARY" },
      { name: "observation_id", descending: 0, collation: "BINARY" },
    ],
  }))
  const observationIndex = indexes.find((index) => String(index.name) === "reference_learning_results_observation_idx")
  const hasExactObservationIndex = Boolean(observationIndex && schemaIndexMatches(connection, observationIndex, {
    unique: 0,
    origin: "c",
    columns: [
      { name: "observation_id", descending: 0, collation: "BINARY" },
      { name: "created_at", descending: 1, collation: "BINARY" },
      { name: "id", descending: 1, collation: "BINARY" },
    ],
  })) && compactSchemaSql((connection.prepare(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name='reference_learning_results_observation_idx'",
  ).get() as SqlRow | undefined)?.sql) === compactSchemaSql(`CREATE INDEX reference_learning_results_observation_idx
    ON reference_learning_results(observation_id,created_at DESC,id DESC)`)
  const tableSql = compactSchemaSql((connection.prepare(`SELECT sql FROM sqlite_master
    WHERE type='table' AND name='reference_learning_results'`).get() as SqlRow | undefined)?.sql)
  const expectedTableSql = compactSchemaSql(`CREATE TABLE reference_learning_results ${referenceLearningResultsTableDefinition}`)
  const triggers = new Map((connection.prepare(`SELECT name,sql FROM sqlite_master WHERE type='trigger'
    AND tbl_name='reference_learning_results'`).all() as SqlRow[]).map((row) => (
    [String(row.name), compactSchemaSql(row.sql)] as const
  )))
  const updateTrigger = triggers.get("reference_learning_results_no_update") ?? ""
  const deleteTrigger = triggers.get("reference_learning_results_no_delete") ?? ""
  if (indexes.length !== 3 || !hasPrimaryKeyIndex || !hasRunObservationUnique || !hasExactObservationIndex
    || tableSql !== expectedTableSql
    || triggers.size !== 2
    || updateTrigger !== appendOnlyTerminalTriggerSql("update")
    || deleteTrigger !== appendOnlyTerminalTriggerSql("delete")) {
    throw new Error("人工参考学习终态审计结构不完整")
  }
}

function assertPortableReferenceLearningGroupTopology(connection: DatabaseSync): void {
  const invalid = connection.prepare(`SELECT 1 FROM telegram_groups
    WHERE purpose='technical_alert' AND (project_id IS NOT NULL OR service_id IS NOT NULL)
    LIMIT 1`).get()
  if (invalid) throw new Error("迁移数据库技术告警群不能绑定业务项目或服务")
}

export function assertTelegramOutputOwnershipStructure(connection: DatabaseSync): void {
  if (!tableExists(connection, "telegram_output_ownership")) {
    throw new Error("Telegram 输出所有权结构不完整")
  }
  assertExactColumns(connection, "telegram_output_ownership", [
    { name: "id", type: "TEXT", notNull: 0, primaryKey: 1 },
    { name: "account_id", type: "TEXT", notNull: 0, primaryKey: 0 },
    { name: "delivery_group_id", type: "TEXT", notNull: 0, primaryKey: 0 },
    { name: "telegram_chat_id", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "telegram_message_id", type: "TEXT", notNull: 0, primaryKey: 0 },
    { name: "thread_id", type: "TEXT", notNull: 0, primaryKey: 0 },
    { name: "service_id", type: "TEXT", notNull: 0, primaryKey: 0 },
    { name: "reply_id", type: "TEXT", notNull: 0, primaryKey: 0 },
    { name: "notification_id", type: "TEXT", notNull: 0, primaryKey: 0 },
    { name: "output_kind", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "delivery_status", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "request_key", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "content_sha256", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "reply_to_message_id", type: "TEXT", notNull: 0, primaryKey: 0 },
    { name: "created_at", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "updated_at", type: "TEXT", notNull: 1, primaryKey: 0 },
  ], "Telegram 输出所有权结构不完整")
  const indexRows = connection.prepare("PRAGMA index_list(telegram_output_ownership)").all() as SqlRow[]
  const indexColumns = (name: string): string[] => (
    connection.prepare(`PRAGMA index_xinfo("${name}")`).all() as SqlRow[]
  ).filter((column) => Number(column.key) === 1 && column.name !== null)
    .map((column) => String(column.name))
  const normalizeSql = (value: unknown): string => String(value ?? "").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US")
  const requiredIndexes = [
    {
      name: "telegram_output_ownership_message_unique_idx",
      unique: 1,
      partial: 1,
      columns: ["account_id", "telegram_chat_id", "telegram_message_id"],
      sql: `CREATE UNIQUE INDEX telegram_output_ownership_message_unique_idx
        ON telegram_output_ownership(account_id,telegram_chat_id,telegram_message_id)
        WHERE telegram_message_id IS NOT NULL`,
    },
    {
      name: "telegram_output_ownership_group_message_unique_idx",
      unique: 1,
      partial: 1,
      columns: ["delivery_group_id", "telegram_message_id"],
      sql: `CREATE UNIQUE INDEX telegram_output_ownership_group_message_unique_idx
        ON telegram_output_ownership(delivery_group_id,telegram_message_id)
        WHERE delivery_group_id IS NOT NULL AND telegram_message_id IS NOT NULL`,
    },
    {
      name: "telegram_output_ownership_pending_idx",
      unique: 0,
      partial: 1,
      columns: ["account_id", "telegram_chat_id", "delivery_status", "content_sha256", "reply_to_message_id", "created_at", "id"],
      sql: `CREATE INDEX telegram_output_ownership_pending_idx
        ON telegram_output_ownership(account_id,telegram_chat_id,delivery_status,content_sha256,reply_to_message_id,created_at,id)
        WHERE telegram_message_id IS NULL AND delivery_status IN ('sending','unknown')`,
    },
    {
      name: "telegram_output_ownership_thread_status_idx",
      unique: 0,
      partial: 1,
      columns: ["thread_id", "delivery_status", "updated_at", "id"],
      sql: `CREATE INDEX telegram_output_ownership_thread_status_idx
        ON telegram_output_ownership(thread_id,delivery_status,updated_at,id)
        WHERE thread_id IS NOT NULL`,
    },
    {
      name: "telegram_output_ownership_retention_idx",
      unique: 0,
      partial: 0,
      columns: ["created_at", "id"],
      sql: `CREATE INDEX telegram_output_ownership_retention_idx
        ON telegram_output_ownership(created_at,id)`,
    },
  ] as const
  const explicitOwnershipIndexes = new Set((connection.prepare(`SELECT name FROM sqlite_master
    WHERE type='index' AND tbl_name='telegram_output_ownership' AND sql IS NOT NULL`).all() as SqlRow[])
    .map((index) => String(index.name)))
  if (explicitOwnershipIndexes.size !== requiredIndexes.length
    || requiredIndexes.some((index) => !explicitOwnershipIndexes.has(index.name))) {
    throw new Error("Telegram 输出所有权结构不完整")
  }
  for (const expected of requiredIndexes) {
    const row = indexRows.find((index) => String(index.name) === expected.name)
    if (!row || Number(row.unique) !== expected.unique || Number(row.partial) !== expected.partial
      || indexColumns(expected.name).join("\u0000") !== expected.columns.join("\u0000")) {
      throw new Error("Telegram 输出所有权结构不完整")
    }
    const sql = compactSchemaSql((connection.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name=?",
    ).get(expected.name) as SqlRow | undefined)?.sql)
    if (sql !== compactSchemaSql(expected.sql)) {
      throw new Error("Telegram 输出所有权结构不完整")
    }
  }
  const requestKeyUnique = indexRows.some((index) => (
    Number(index.unique) === 1 && Number(index.partial) === 0
      && indexColumns(String(index.name)).join("\u0000") === "request_key"
      && !normalizeSql((connection.prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name=?",
      ).get(String(index.name)) as SqlRow | undefined)?.sql).includes(" where ")
  ))
  if (!requestKeyUnique) throw new Error("Telegram 输出所有权结构不完整")
  const expectedForeignKeys = new Map<string, readonly [string, string, string]>([
    ["account_id", ["telegram_accounts", "id", "SET NULL"]],
    ["delivery_group_id", ["telegram_groups", "id", "CASCADE"]],
    ["thread_id", ["support_threads", "id", "CASCADE"]],
    ["service_id", ["project_services", "id", "SET NULL"]],
    ["reply_id", ["support_replies", "id", "CASCADE"]],
    ["notification_id", ["support_thread_notifications", "id", "CASCADE"]],
  ] as const)
  const foreignKeys = connection.prepare("PRAGMA foreign_key_list(telegram_output_ownership)").all() as SqlRow[]
  if (foreignKeys.length !== expectedForeignKeys.size || foreignKeys.some((foreignKey) => {
    const expected = expectedForeignKeys.get(String(foreignKey.from))
    return !expected || String(foreignKey.table) !== expected[0] || String(foreignKey.to) !== expected[1]
      || String(foreignKey.on_delete).toLocaleUpperCase("en-US") !== expected[2]
  })) throw new Error("Telegram 输出所有权结构不完整")
  const tableSql = compactSchemaSql((connection.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='telegram_output_ownership'",
  ).get() as SqlRow | undefined)?.sql)
  const expectedTableSql = compactSchemaSql(telegramOutputOwnershipTableSchema.replace(
    "CREATE TABLE IF NOT EXISTS",
    "CREATE TABLE",
  ))
  if (tableSql !== expectedTableSql) {
    throw new Error("Telegram 输出所有权结构不完整")
  }
  if (!tableExists(connection, "telegram_outgoing_candidates")) {
    throw new Error("Telegram 输出所有权结构不完整")
  }
  assertExactColumns(connection, "telegram_outgoing_candidates", [
    { name: "id", type: "TEXT", notNull: 0, primaryKey: 1 },
    { name: "ownership_id", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "telegram_message_id", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "resolution_status", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "created_at", type: "TEXT", notNull: 1, primaryKey: 0 },
    { name: "updated_at", type: "TEXT", notNull: 1, primaryKey: 0 },
  ], "Telegram 输出所有权结构不完整")
  const candidateIndexes = connection.prepare("PRAGMA index_list(telegram_outgoing_candidates)").all() as SqlRow[]
  const candidateIndexColumns = (name: string): string[] => (
    connection.prepare(`PRAGMA index_xinfo("${name}")`).all() as SqlRow[]
  ).filter((column) => Number(column.key) === 1 && column.name !== null).map((column) => String(column.name))
  const expectedCandidateIndexes = [
    {
      name: "telegram_outgoing_candidates_owner_message_unique_idx",
      unique: 1,
      columns: ["ownership_id", "telegram_message_id"],
      sql: `CREATE UNIQUE INDEX telegram_outgoing_candidates_owner_message_unique_idx
        ON telegram_outgoing_candidates(ownership_id,telegram_message_id)`,
    },
    {
      name: "telegram_outgoing_candidates_resolution_idx",
      unique: 0,
      columns: ["resolution_status", "updated_at", "id"],
      sql: `CREATE INDEX telegram_outgoing_candidates_resolution_idx
        ON telegram_outgoing_candidates(resolution_status,updated_at,id)`,
    },
  ] as const
  const explicitCandidateIndexes = new Set((connection.prepare(`SELECT name FROM sqlite_master
    WHERE type='index' AND tbl_name='telegram_outgoing_candidates' AND sql IS NOT NULL`).all() as SqlRow[])
    .map((index) => String(index.name)))
  if (explicitCandidateIndexes.size !== expectedCandidateIndexes.length
    || expectedCandidateIndexes.some((index) => !explicitCandidateIndexes.has(index.name))) {
    throw new Error("Telegram 输出所有权结构不完整")
  }
  if (expectedCandidateIndexes.some((expected) => {
    const row = candidateIndexes.find((index) => String(index.name) === expected.name)
    return !row || Number(row.unique) !== expected.unique || Number(row.partial) !== 0
      || candidateIndexColumns(expected.name).join("\u0000") !== expected.columns.join("\u0000")
      || compactSchemaSql((connection.prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name=?",
      ).get(expected.name) as SqlRow | undefined)?.sql) !== compactSchemaSql(expected.sql)
  })) throw new Error("Telegram 输出所有权结构不完整")
  const candidateForeignKeys = connection.prepare("PRAGMA foreign_key_list(telegram_outgoing_candidates)").all() as SqlRow[]
  if (candidateForeignKeys.length !== 1
    || String(candidateForeignKeys[0]?.from) !== "ownership_id"
    || String(candidateForeignKeys[0]?.table) !== "telegram_output_ownership"
    || String(candidateForeignKeys[0]?.to) !== "id"
    || String(candidateForeignKeys[0]?.on_delete).toLocaleUpperCase("en-US") !== "CASCADE") {
    throw new Error("Telegram 输出所有权结构不完整")
  }
  const candidateTableSql = compactSchemaSql((connection.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='telegram_outgoing_candidates'",
  ).get() as SqlRow | undefined)?.sql)
  const expectedCandidateTableSql = compactSchemaSql(telegramOutgoingCandidatesTableSchema.replace(
    "CREATE TABLE IF NOT EXISTS",
    "CREATE TABLE",
  ))
  if (candidateTableSql !== expectedCandidateTableSql) {
    throw new Error("Telegram 输出所有权结构不完整")
  }
}

export function assertTelegramOutputOwnershipRows(connection: DatabaseSync): void {
  assertTelegramOutputOwnershipStructure(connection)
  let lastOwnershipRowId = 0
  while (true) {
    const rows = connection.prepare(`SELECT rowid AS row_id,* FROM telegram_output_ownership
      WHERE rowid>? ORDER BY rowid LIMIT 2000`).all(lastOwnershipRowId) as Array<Record<string, unknown> & { row_id: number }>
    try {
      rows.forEach((row) => telegramOutputOwnershipRowSchema.parse({
        id: row.id,
        accountId: row.account_id,
        deliveryGroupId: row.delivery_group_id,
        telegramChatId: row.telegram_chat_id,
        telegramMessageId: row.telegram_message_id,
        threadId: row.thread_id,
        serviceId: row.service_id,
        replyId: row.reply_id,
        notificationId: row.notification_id,
        outputKind: row.output_kind,
        deliveryStatus: row.delivery_status,
        requestKey: row.request_key,
        contentSha256: row.content_sha256,
        replyToMessageId: row.reply_to_message_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))
    } catch {
      throw new Error("Telegram 输出所有权行格式错误")
    }
    if (rows.length === 0) break
    lastOwnershipRowId = Number(rows.at(-1)?.row_id ?? lastOwnershipRowId)
  }

  let lastCandidateRowId = 0
  while (true) {
    const rows = connection.prepare(`SELECT rowid AS row_id,* FROM telegram_outgoing_candidates
      WHERE rowid>? ORDER BY rowid LIMIT 2000`).all(lastCandidateRowId) as Array<Record<string, unknown> & { row_id: number }>
    try {
      rows.forEach((row) => telegramOutgoingCandidateRowSchema.parse({
        id: row.id,
        ownershipId: row.ownership_id,
        telegramMessageId: row.telegram_message_id,
        resolutionStatus: row.resolution_status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))
    } catch {
      throw new Error("Telegram 输出所有权行格式错误")
    }
    if (rows.length === 0) break
    lastCandidateRowId = Number(rows.at(-1)?.row_id ?? lastCandidateRowId)
  }

  const invalidCandidate = connection.prepare(`SELECT 1
    FROM telegram_outgoing_candidates candidate
    LEFT JOIN telegram_output_ownership ownership ON ownership.id=candidate.ownership_id
    WHERE ownership.id IS NULL
      OR julianday(candidate.created_at)<julianday(ownership.created_at)
      OR (candidate.resolution_status='pending' AND NOT (
        ownership.delivery_status IN ('sending','unknown') AND ownership.telegram_message_id IS NULL
      ))
      OR (candidate.resolution_status='application' AND NOT EXISTS (
        SELECT 1 FROM telegram_outgoing_candidates sibling
        JOIN telegram_output_ownership sibling_ownership ON sibling_ownership.id=sibling.ownership_id
        WHERE sibling.telegram_message_id=candidate.telegram_message_id
          AND sibling_ownership.account_id IS ownership.account_id
          AND sibling_ownership.telegram_chat_id=ownership.telegram_chat_id
          AND sibling_ownership.delivery_status='sent'
          AND sibling_ownership.telegram_message_id=candidate.telegram_message_id
      ))
      OR (candidate.resolution_status='manual' AND NOT (
        ownership.delivery_status IN ('sent','failed')
        AND ownership.telegram_message_id IS NOT candidate.telegram_message_id
      ))
      OR (candidate.resolution_status='unknown' AND NOT EXISTS (
        SELECT 1 FROM telegram_outgoing_candidates sibling
        JOIN telegram_output_ownership sibling_ownership ON sibling_ownership.id=sibling.ownership_id
        WHERE sibling.telegram_message_id=candidate.telegram_message_id
          AND sibling_ownership.account_id IS ownership.account_id
          AND sibling_ownership.telegram_chat_id=ownership.telegram_chat_id
          AND sibling_ownership.delivery_status='unknown'
      ))
    LIMIT 1`).get()
  if (invalidCandidate) throw new Error("Telegram 输出所有权候选关系损坏")
}

function migrateToV16(connection: DatabaseSync): void {
  connection.exec("PRAGMA foreign_keys=OFF")
  try {
    connection.exec("BEGIN IMMEDIATE")
    if (tableExists(connection, "admin_chat_turns")) {
      const adminChatSql = String((connection.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='admin_chat_turns'",
      ).get() as SqlRow | undefined)?.sql ?? "")
      if (!adminChatSql.includes("'cancelled'")) {
        connection.exec(`CREATE TABLE admin_chat_turns_v16 (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES admin_chat_sessions(id) ON DELETE CASCADE,
          position INTEGER NOT NULL CHECK(position>=1),
          question TEXT NOT NULL,
          answer TEXT NOT NULL,
          decision TEXT CHECK(decision IS NULL OR decision IN ('reply','ignore','escalate')),
          status TEXT NOT NULL CHECK(status IN ('pending','generating','completed','failed','cancelled')),
          investigation_json TEXT NOT NULL,
          decision_reason TEXT,
          decision_confidence REAL CHECK(decision_confidence IS NULL OR decision_confidence BETWEEN 0 AND 1),
          code_revision TEXT,
          code_snapshot_id TEXT REFERENCES service_code_snapshots(id) ON DELETE SET NULL,
          code_sync_batch_id TEXT REFERENCES service_code_sync_batches(id) ON DELETE SET NULL,
          memory_version_refs_json TEXT NOT NULL,
          error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          generation_started_at TEXT,
          completed_at TEXT,
          UNIQUE(session_id,position)
        );
        INSERT INTO admin_chat_turns_v16(
          id,session_id,position,question,answer,decision,status,investigation_json,decision_reason,decision_confidence,
          code_revision,code_snapshot_id,code_sync_batch_id,memory_version_refs_json,error_code,created_at,updated_at,
          generation_started_at,completed_at
        ) SELECT id,session_id,position,question,answer,decision,status,investigation_json,decision_reason,decision_confidence,
          code_revision,code_snapshot_id,code_sync_batch_id,memory_version_refs_json,error_code,created_at,updated_at,
          generation_started_at,completed_at FROM admin_chat_turns;
        DROP TABLE admin_chat_turns;
        ALTER TABLE admin_chat_turns_v16 RENAME TO admin_chat_turns;
        CREATE INDEX admin_chat_turns_work_idx ON admin_chat_turns(status,created_at,id);
        CREATE UNIQUE INDEX admin_chat_turns_one_active_idx
          ON admin_chat_turns(session_id) WHERE status IN ('pending','generating');`)
      }
    }

    if (tableExists(connection, "telegram_roles") && !tableColumns(connection, "telegram_roles").has("learning_source_enabled")) {
      connection.exec(`ALTER TABLE telegram_roles
        ADD COLUMN learning_source_enabled INTEGER NOT NULL DEFAULT 0 CHECK (learning_source_enabled IN (0, 1))`)
    }
    connection.exec(learningSourceObservationsV22Schema)

    if (tableExists(connection, "support_replies")) {
      let replyColumns = tableColumns(connection, "support_replies")
      if (!replyColumns.has("technical_alert_status")) {
        connection.exec(`ALTER TABLE support_replies ADD COLUMN technical_alert_status TEXT
          CHECK (technical_alert_status IS NULL OR technical_alert_status IN ('sending','sent','not_configured','failed','uncertain'))`)
      }
      if (!replyColumns.has("operator_delivery_status")) {
        connection.exec(`ALTER TABLE support_replies ADD COLUMN operator_delivery_status TEXT
          CHECK (operator_delivery_status IS NULL OR operator_delivery_status IN ('sending','sent','failed','uncertain'))`)
      }
      replyColumns = tableColumns(connection, "support_replies")
      connection.exec(`CREATE INDEX IF NOT EXISTS support_replies_group_message_idx
        ON support_replies(group_id, telegram_reply_message_id, created_at DESC, id DESC)
        WHERE telegram_reply_message_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS support_reply_alert_deliveries (
          reply_id TEXT NOT NULL REFERENCES support_replies(id) ON DELETE CASCADE,
          alert_kind TEXT NOT NULL CHECK (alert_kind IN (
            'legacy_code_sync','code_sync_fallback','code_sync_message_evidence','support_delivery_failure',
            'escalation','code_sync_unavailable','investigation_runtime_failure'
          )),
          status TEXT NOT NULL CHECK (status IN ('sending','sent','not_configured','failed','uncertain')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (reply_id, alert_kind)
        );
        CREATE INDEX IF NOT EXISTS support_reply_alert_deliveries_status_idx
          ON support_reply_alert_deliveries(status, updated_at, reply_id);`)
      if (replyColumns.has("technical_alert_status")) {
        connection.exec(`INSERT OR IGNORE INTO support_reply_alert_deliveries(
          reply_id,alert_kind,status,created_at,updated_at
        ) SELECT id,'legacy_code_sync',technical_alert_status,created_at,updated_at
          FROM support_replies WHERE technical_alert_status IS NOT NULL;
          UPDATE support_replies SET technical_alert_status=NULL WHERE technical_alert_status IS NOT NULL;`)
      }
    }
    connection.prepare("UPDATE metadata SET value='16' WHERE key='schema_version'").run()
    connection.exec("COMMIT")
  } catch (error) {
    try { connection.exec("ROLLBACK") } catch { /* 事务已结束时无需处理。 */ }
    throw error
  } finally {
    connection.exec("PRAGMA foreign_keys=ON")
  }
}

function migrateV16ToV17(connection: DatabaseSync): void {
  connection.exec("BEGIN IMMEDIATE")
  try {
    connection.exec(`${operatorStyleV17Schema}
      UPDATE metadata SET value='17' WHERE key='schema_version';
      COMMIT;`)
  } catch (error) {
    try { connection.exec("ROLLBACK") } catch { /* 事务已结束时无需处理。 */ }
    throw error
  }
}

function migrateV17ToV18(connection: DatabaseSync): void {
  connection.exec("PRAGMA foreign_keys=OFF")
  try {
    connection.exec(`BEGIN IMMEDIATE;
      CREATE TABLE operator_style_version_evidence_v18 (
        id TEXT PRIMARY KEY CHECK(length(id)>0),
        operator_style_version_id TEXT NOT NULL REFERENCES operator_style_versions(id) ON DELETE CASCADE,
        observation_id TEXT REFERENCES learning_source_observations(id) ON DELETE SET NULL,
        source_telegram_user_id TEXT NOT NULL
          CHECK(length(source_telegram_user_id)>0 AND source_telegram_user_id NOT GLOB '*[^0-9]*'),
        thread_id TEXT NOT NULL CHECK(length(thread_id)>0)
      );`)
    const evidence = connection.prepare(`SELECT evidence.operator_style_version_id,evidence.observation_id,
      observation.source_telegram_user_id,observation.thread_id
      FROM operator_style_version_evidence evidence
      JOIN learning_source_observations observation ON observation.id=evidence.observation_id
      ORDER BY evidence.operator_style_version_id,evidence.observation_id`).all() as Array<{
      operator_style_version_id: string
      observation_id: string
      source_telegram_user_id: string
      thread_id: string | null
    }>
    const insert = connection.prepare(`INSERT INTO operator_style_version_evidence_v18(
      id,operator_style_version_id,observation_id,source_telegram_user_id,thread_id
    ) VALUES (?,?,?,?,?)`)
    evidence.forEach((row) => insert.run(
      randomUUID(), row.operator_style_version_id, row.observation_id, row.source_telegram_user_id, row.thread_id,
    ))
    const sourceCount = Number((connection.prepare(
      "SELECT COUNT(*) AS count FROM operator_style_version_evidence",
    ).get() as { count: number }).count)
    const migratedCount = Number((connection.prepare(
      "SELECT COUNT(*) AS count FROM operator_style_version_evidence_v18",
    ).get() as { count: number }).count)
    if (sourceCount !== migratedCount) throw new Error("v17 风格证据无法完整迁移")
    connection.exec(`DROP TABLE operator_style_version_evidence;
      ALTER TABLE operator_style_version_evidence_v18 RENAME TO operator_style_version_evidence;
      CREATE UNIQUE INDEX operator_style_version_evidence_live_observation_unique_idx
        ON operator_style_version_evidence(operator_style_version_id,observation_id) WHERE observation_id IS NOT NULL;
      CREATE INDEX operator_style_version_evidence_observation_idx
        ON operator_style_version_evidence(observation_id,operator_style_version_id);
      UPDATE metadata SET value='18' WHERE key='schema_version';
      COMMIT;`)
  } catch (error) {
    try { connection.exec("ROLLBACK") } catch { /* 事务已结束时无需处理。 */ }
    throw error
  } finally {
    connection.exec("PRAGMA foreign_keys=ON")
  }
}

function migrateV18ToV19(connection: DatabaseSync): void {
  connection.exec("BEGIN IMMEDIATE")
  try {
    if (tableExists(connection, "support_threads")) {
      const columns = tableColumns(connection, "support_threads")
      if (!columns.has("operator_style_version_id")) {
        connection.exec("ALTER TABLE support_threads ADD COLUMN operator_style_version_id TEXT REFERENCES operator_style_versions(id) ON DELETE SET NULL")
      }
      if (!columns.has("operator_style_profile_json")) {
        connection.exec(`ALTER TABLE support_threads ADD COLUMN operator_style_profile_json TEXT NOT NULL
          DEFAULT '${baselineOperatorStyleProfileJson}'`)
      }
    }
    connection.prepare("UPDATE metadata SET value='19' WHERE key='schema_version'").run()
    connection.exec("COMMIT")
  } catch (error) {
    try { connection.exec("ROLLBACK") } catch { /* 事务已结束时无需处理。 */ }
    throw error
  }
}

const modelConfigurationTables = ["model_instances", "model_catalog_entries", "runtime_model_bindings"] as const

function normalizedTableDefinition(connection: DatabaseSync, table: string): string {
  return String((connection.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as SqlRow | undefined)?.sql ?? "")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, "")
}

function hasUniqueIndex(connection: DatabaseSync, table: string, expectedColumns: string[]): boolean {
  const indexes = connection.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>
  return indexes.some((index) => {
    if (Number(index.unique) !== 1 || !/^[A-Za-z0-9_]+$/u.test(index.name)) return false
    const columns = (connection.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>)
      .map((column) => column.name)
    return columns.length === expectedColumns.length && columns.every((column, offset) => column === expectedColumns[offset])
  })
}

function assertModelConfigurationStructure(connection: DatabaseSync): void {
  const requiredColumns: Record<(typeof modelConfigurationTables)[number], string[]> = {
    model_instances: [
      "id", "alias", "provider", "transport", "model_id", "reasoning_effort", "service_tier", "parameters_json",
      "credentials", "enabled", "health_status", "health_message", "last_checked_at", "created_at", "updated_at",
    ],
    model_catalog_entries: [
      "provider", "transport", "model_id", "display_name", "capabilities_json", "hidden", "deprecated",
      "upgrade_model_id", "refreshed_at",
    ],
    runtime_model_bindings: [
      "purpose", "model_instance_id", "timeout_seconds", "max_concurrency", "enabled", "updated_at",
    ],
  }
  for (const table of modelConfigurationTables) {
    const columns = tableColumns(connection, table)
    if (requiredColumns[table].some((column) => !columns.has(column))) {
      throw new Error("模型配置结构不完整，无法升级运行数据库")
    }
  }
  const definitions = {
    instances: normalizedTableDefinition(connection, "model_instances"),
    catalog: normalizedTableDefinition(connection, "model_catalog_entries"),
    bindings: normalizedTableDefinition(connection, "runtime_model_bindings"),
  }
  const instanceCapabilities = [
    "aliastextnotnullunique",
    "providertextnotnullcheck(providerin('openai','deepseek','anthropic','glm'))",
    "transporttextnotnullcheck(transportin('codex_cli','direct_api'))",
    "reasoning_efforttextcheck(reasoning_effortisnullorreasoning_effortin('none','minimal','low','medium','high','xhigh','max','ultra'))",
    "service_tiertextcheck(service_tierisnullorservice_tierin('standard','fast','priority'))",
    "enabledintegernotnullcheck(enabledin(0,1))",
    "health_statustextnotnullcheck(health_statusin('not_tested','ready','error'))",
  ]
  const catalogCapabilities = [
    "providertextnotnullcheck(providerin('openai','deepseek','anthropic','glm'))",
    "transporttextnotnullcheck(transportin('codex_cli','direct_api'))",
    "hiddenintegernotnullcheck(hiddenin(0,1))",
    "deprecatedintegernotnullcheck(deprecatedin(0,1))",
    "primarykey(provider,transport,model_id)",
  ]
  const bindingCapabilities = [
    "purposetextprimarykeycheck(purposein('answer','memory'))",
    "model_instance_idtextnotnullreferencesmodel_instances(id)ondeleterestrict",
    "timeout_secondsintegernotnullcheck(timeout_secondsbetween30and3600)",
    "max_concurrencyintegernotnullcheck(max_concurrencybetween1and8)",
    "enabledintegernotnullcheck(enabledin(0,1))",
  ]
  const interactionBindingCapabilities = [
    "purposetextprimarykeycheck(purposein('answer','interaction','memory'))",
    "model_instance_idtextreferencesmodel_instances(id)ondeleterestrict",
    "timeout_secondsintegernotnullcheck((purpose='interaction'andtimeout_secondsbetween3and60)or(purposein('answer','memory')andtimeout_secondsbetween30and3600))",
    "max_concurrencyintegernotnullcheck(max_concurrencybetween1and8)",
    "enabledintegernotnullcheck(enabledin(0,1))",
    "check(model_instance_idisnotnullorenabled=0)",
  ]
  const bindingDefinitionSupported = bindingCapabilities.every((capability) => definitions.bindings.includes(capability))
    || interactionBindingCapabilities.every((capability) => definitions.bindings.includes(capability))
  if (instanceCapabilities.some((capability) => !definitions.instances.includes(capability))
    || catalogCapabilities.some((capability) => !definitions.catalog.includes(capability))
    || !bindingDefinitionSupported
    || !hasUniqueIndex(connection, "model_instances", ["alias"])
    || !hasUniqueIndex(connection, "model_catalog_entries", ["provider", "transport", "model_id"])
    || !hasUniqueIndex(connection, "runtime_model_bindings", ["purpose"])) {
    throw new Error("模型配置结构不完整，无法升级运行数据库")
  }
}

function assertGroupModelPolicyStructure(connection: DatabaseSync): void {
  if (!tableExists(connection, "telegram_groups")) return
  const columns = tableColumns(connection, "telegram_groups")
  if (!columns.has("ai_model_instance_id") || !columns.has("reply_style")) {
    throw new Error("群模型策略结构不完整，无法升级运行数据库")
  }
  const definition = normalizedTableDefinition(connection, "telegram_groups")
  const replyStyleDefinitionSupported = ["human", "unrestricted"].some((defaultStyle) => definition.includes(
    `reply_styletextnotnulldefault'${defaultStyle}'check(reply_stylein('human','unrestricted'))`,
  ))
  if (!definition.includes("ai_model_instance_idtextreferencesmodel_instances(id)ondeleterestrict")
    || !replyStyleDefinitionSupported) {
    throw new Error("群模型策略结构不完整，无法升级运行数据库")
  }
}

function removeRedundantLegacyModelProfiles(connection: DatabaseSync): void {
  if (!tableExists(connection, "model_profiles")) return
  const profiles = connection.prepare(`SELECT profiles.purpose,profiles.model,profiles.reasoning_effort,
    profiles.enabled,instances.model_id,instances.reasoning_effort AS instance_reasoning_effort,
    bindings.enabled AS binding_enabled
    FROM model_profiles profiles
    LEFT JOIN runtime_model_bindings bindings ON bindings.purpose=profiles.purpose
    LEFT JOIN model_instances instances ON instances.id=bindings.model_instance_id
    ORDER BY profiles.purpose`).all() as Array<{
      purpose: string
      model: string
      reasoning_effort: string
      enabled: number
      model_id: string | null
      instance_reasoning_effort: string | null
      binding_enabled: number | null
    }>
  const expectedPurposes = ["answer", "memory"]
  const profilesMatch = profiles.length === expectedPurposes.length && profiles.every((profile, index) => (
    profile.purpose === expectedPurposes[index]
    && profile.model === profile.model_id
    && profile.reasoning_effort === profile.instance_reasoning_effort
    && profile.enabled === profile.binding_enabled
  ))
  if (!profilesMatch) throw new Error("模型配置谱系冲突，无法升级运行数据库")
  connection.exec("DROP TABLE model_profiles")
}

function assertThreadAnswerPolicyStructure(connection: DatabaseSync): void {
  if (!tableExists(connection, "support_threads")) return
  const columns = tableColumns(connection, "support_threads")
  const requiredColumns = [
    "answer_model_instance_id", "answer_reply_style", "answer_timeout_seconds", "answer_max_concurrency",
    "answer_binding_enabled", "answer_include_ai_memory", "answer_include_interface_docs", "answer_include_magic_book",
  ]
  const definition = normalizedTableDefinition(connection, "support_threads")
  const requiredCapabilities = [
    "answer_model_instance_idtextnotnulldefault'00000000-0000-4000-8000-000000000001'",
    "answer_reply_styletextnotnulldefault'unrestricted'check(answer_reply_stylein('human','unrestricted'))",
    "answer_timeout_secondsintegernotnulldefault3600check(answer_timeout_secondsbetween30and3600)",
    "answer_max_concurrencyintegernotnulldefault2check(answer_max_concurrencybetween1and8)",
    "answer_binding_enabledintegernotnulldefault1check(answer_binding_enabledin(0,1))",
    "answer_include_ai_memoryintegernotnulldefault1check(answer_include_ai_memoryin(0,1))",
    "answer_include_interface_docsintegernotnulldefault1check(answer_include_interface_docsin(0,1))",
    "answer_include_magic_bookintegernotnulldefault1check(answer_include_magic_bookin(0,1))",
  ]
  if (requiredColumns.some((column) => !columns.has(column))
    || requiredCapabilities.some((capability) => !definition.includes(capability))) {
    throw new Error("线程回答策略结构不完整，无法打开运行数据库")
  }
}

function migrateToV20(connection: DatabaseSync): void {
  connection.exec("PRAGMA foreign_keys=OFF")
  try {
    connection.exec("BEGIN IMMEDIATE")
    const modelTableCount = modelConfigurationTables.filter((table) => tableExists(connection, table)).length
    if (modelTableCount !== 0 && modelTableCount !== modelConfigurationTables.length) {
      throw new Error("模型配置结构不完整，无法升级运行数据库")
    }
    const hasGroupTable = tableExists(connection, "telegram_groups")
    const groupColumns = hasGroupTable ? tableColumns(connection, "telegram_groups") : new Set<string>()
    const hasGroupModel = groupColumns.has("ai_model_instance_id")
    const hasReplyStyle = groupColumns.has("reply_style")
    if (hasGroupModel !== hasReplyStyle) throw new Error("群模型策略结构不完整，无法升级运行数据库")

    if (modelTableCount === 0) {
      const hasLegacyProfiles = tableExists(connection, "model_profiles")
      if (!hasLegacyProfiles && hasGroupTable) throw new Error("旧模型配置缺失，无法升级运行数据库")
      const now = new Date().toISOString()
      const profiles = hasLegacyProfiles
        ? connection.prepare(`SELECT purpose,model,reasoning_effort,timeout_seconds,max_concurrency,enabled,updated_at
          FROM model_profiles ORDER BY purpose`).all() as SqlRow[]
        : [
          { purpose: "answer", model: "gpt-5.6-terra", reasoning_effort: "medium", timeout_seconds: 3600, max_concurrency: 2, enabled: 1, updated_at: now },
          { purpose: "memory", model: "gpt-5.6-luna", reasoning_effort: "low", timeout_seconds: 120, max_concurrency: 1, enabled: 1, updated_at: now },
        ]
      const answer = profiles.find((row) => row.purpose === "answer")
      const memory = profiles.find((row) => row.purpose === "memory")
      if (!answer || !memory || profiles.length !== 2) throw new Error("旧模型配置不完整，无法升级运行数据库")
      connection.exec(`
        CREATE TABLE model_instances (
          id TEXT PRIMARY KEY,
          alias TEXT NOT NULL UNIQUE,
          provider TEXT NOT NULL CHECK (provider IN ('openai','deepseek','anthropic','glm')),
          transport TEXT NOT NULL CHECK (transport IN ('codex_cli','direct_api')),
          model_id TEXT NOT NULL,
          reasoning_effort TEXT CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('none','minimal','low','medium','high','xhigh','max','ultra')),
          service_tier TEXT CHECK (service_tier IS NULL OR service_tier IN ('standard','fast','priority')),
          parameters_json TEXT NOT NULL DEFAULT '{}',
          credentials TEXT,
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          health_status TEXT NOT NULL CHECK (health_status IN ('not_tested','ready','error')),
          health_message TEXT NOT NULL,
          last_checked_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE model_catalog_entries (
          provider TEXT NOT NULL CHECK (provider IN ('openai','deepseek','anthropic','glm')),
          transport TEXT NOT NULL CHECK (transport IN ('codex_cli','direct_api')),
          model_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          capabilities_json TEXT NOT NULL,
          hidden INTEGER NOT NULL CHECK (hidden IN (0, 1)),
          deprecated INTEGER NOT NULL CHECK (deprecated IN (0, 1)),
          upgrade_model_id TEXT,
          refreshed_at TEXT NOT NULL,
          PRIMARY KEY(provider,transport,model_id)
        );
        CREATE TABLE runtime_model_bindings (
          purpose TEXT PRIMARY KEY CHECK (purpose IN ('answer','memory')),
          model_instance_id TEXT NOT NULL REFERENCES model_instances(id) ON DELETE RESTRICT,
          timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds BETWEEN 30 AND 3600),
          max_concurrency INTEGER NOT NULL CHECK (max_concurrency BETWEEN 1 AND 8),
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          updated_at TEXT NOT NULL
        );
      `)
      if (hasGroupTable && !hasGroupModel) {
        connection.exec(`ALTER TABLE telegram_groups ADD COLUMN ai_model_instance_id TEXT REFERENCES model_instances(id) ON DELETE RESTRICT;
          ALTER TABLE telegram_groups ADD COLUMN reply_style TEXT NOT NULL DEFAULT 'unrestricted'
            CHECK (reply_style IN ('human','unrestricted'));`)
      }
      const insertInstance = connection.prepare(`INSERT INTO model_instances(
        id,alias,provider,transport,model_id,reasoning_effort,service_tier,parameters_json,credentials,
        enabled,health_status,health_message,last_checked_at,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,'standard','{}',NULL,?,'not_tested','尚未检测',NULL,?,?)`)
      insertInstance.run(defaultAnswerModelInstanceId, "默认回答模型", "openai", "codex_cli", String(answer.model),
        String(answer.reasoning_effort), Number(answer.enabled), String(answer.updated_at), String(answer.updated_at))
      insertInstance.run(defaultMemoryModelInstanceId, "默认记忆模型", "openai", "codex_cli", String(memory.model),
        String(memory.reasoning_effort), Number(memory.enabled), String(memory.updated_at), String(memory.updated_at))
      const insertBinding = connection.prepare(`INSERT INTO runtime_model_bindings(
        purpose,model_instance_id,timeout_seconds,max_concurrency,enabled,updated_at
      ) VALUES (?,?,?,?,?,?)`)
      insertBinding.run("answer", defaultAnswerModelInstanceId, Number(answer.timeout_seconds), Number(answer.max_concurrency), Number(answer.enabled), String(answer.updated_at))
      insertBinding.run("memory", defaultMemoryModelInstanceId, Number(memory.timeout_seconds), Number(memory.max_concurrency), Number(memory.enabled), String(memory.updated_at))
      if (hasGroupTable) connection.prepare("UPDATE telegram_groups SET ai_model_instance_id=? WHERE purpose='technical_alert'").run(defaultAnswerModelInstanceId)
      if (hasLegacyProfiles) connection.exec("DROP TABLE model_profiles")
    } else {
      assertModelConfigurationStructure(connection)
      const bindings = connection.prepare(`SELECT purpose,model_instance_id FROM runtime_model_bindings
        ORDER BY purpose`).all() as Array<{ purpose: string; model_instance_id: string | null }>
      if (bindings.length !== 2 || bindings[0]?.purpose !== "answer" || !bindings[0].model_instance_id
        || bindings[1]?.purpose !== "memory" || !bindings[1].model_instance_id) {
        throw new Error("运行模型绑定不完整，无法升级运行数据库")
      }
      removeRedundantLegacyModelProfiles(connection)
      if (hasGroupTable && !hasGroupModel) {
        connection.exec(`ALTER TABLE telegram_groups ADD COLUMN ai_model_instance_id TEXT REFERENCES model_instances(id) ON DELETE RESTRICT;
          ALTER TABLE telegram_groups ADD COLUMN reply_style TEXT NOT NULL DEFAULT 'unrestricted'
            CHECK (reply_style IN ('human','unrestricted'));`)
        connection.prepare("UPDATE telegram_groups SET ai_model_instance_id=? WHERE purpose='technical_alert'").run(
          bindings.find((binding) => binding.purpose === "answer")?.model_instance_id ?? null,
        )
      }
    }
    assertModelConfigurationStructure(connection)
    assertGroupModelPolicyStructure(connection)
    if ((connection.prepare("PRAGMA foreign_key_check").all() as unknown[]).length > 0) {
      throw new Error("模型配置外键关系损坏，无法升级运行数据库")
    }
    connection.prepare("UPDATE metadata SET value='20' WHERE key='schema_version'").run()
    connection.exec("COMMIT")
  } catch (error) {
    try { connection.exec("ROLLBACK") } catch { /* 事务已结束时无需处理。 */ }
    throw error
  } finally {
    connection.exec("PRAGMA foreign_keys=ON")
  }
}

function migrateV20ToV21(connection: DatabaseSync): void {
  connection.exec("BEGIN IMMEDIATE")
  try {
    if (tableExists(connection, "support_threads")) {
      const columns = tableColumns(connection, "support_threads")
      if (!columns.has("answer_model_instance_id")) {
        connection.exec(`ALTER TABLE support_threads ADD COLUMN answer_model_instance_id TEXT NOT NULL
          DEFAULT '00000000-0000-4000-8000-000000000001'`)
      }
      if (!columns.has("answer_reply_style")) {
        connection.exec(`ALTER TABLE support_threads ADD COLUMN answer_reply_style TEXT NOT NULL DEFAULT 'unrestricted'
          CHECK (answer_reply_style IN ('human','unrestricted'))`)
      }
      if (!columns.has("answer_timeout_seconds")) {
        connection.exec(`ALTER TABLE support_threads ADD COLUMN answer_timeout_seconds INTEGER NOT NULL DEFAULT 3600
          CHECK (answer_timeout_seconds BETWEEN 30 AND 3600)`)
      }
      if (!columns.has("answer_max_concurrency")) {
        connection.exec(`ALTER TABLE support_threads ADD COLUMN answer_max_concurrency INTEGER NOT NULL DEFAULT 2
          CHECK (answer_max_concurrency BETWEEN 1 AND 8)`)
      }
      if (!columns.has("answer_binding_enabled")) {
        connection.exec(`ALTER TABLE support_threads ADD COLUMN answer_binding_enabled INTEGER NOT NULL DEFAULT 1
          CHECK (answer_binding_enabled IN (0,1))`)
      }
      if (!columns.has("answer_include_ai_memory")) {
        connection.exec(`ALTER TABLE support_threads ADD COLUMN answer_include_ai_memory INTEGER NOT NULL DEFAULT 1
          CHECK (answer_include_ai_memory IN (0,1))`)
      }
      if (!columns.has("answer_include_interface_docs")) {
        connection.exec(`ALTER TABLE support_threads ADD COLUMN answer_include_interface_docs INTEGER NOT NULL DEFAULT 1
          CHECK (answer_include_interface_docs IN (0,1))`)
      }
      if (!columns.has("answer_include_magic_book")) {
        connection.exec(`ALTER TABLE support_threads ADD COLUMN answer_include_magic_book INTEGER NOT NULL DEFAULT 1
          CHECK (answer_include_magic_book IN (0,1))`)
      }
      if (tableExists(connection, "telegram_groups") && tableExists(connection, "runtime_model_bindings")) {
        connection.exec(`UPDATE support_threads SET
          answer_model_instance_id=COALESCE(
            (SELECT CASE WHEN groups.purpose='technical_alert' THEN groups.ai_model_instance_id ELSE NULL END
              FROM telegram_groups groups WHERE groups.id=support_threads.group_id),
            (SELECT model_instance_id FROM runtime_model_bindings WHERE purpose='answer'),
            answer_model_instance_id
          ),
          answer_reply_style=COALESCE(
            (SELECT groups.reply_style FROM telegram_groups groups WHERE groups.id=support_threads.group_id),
            answer_reply_style
          ),
          answer_timeout_seconds=COALESCE(
            (SELECT timeout_seconds FROM runtime_model_bindings WHERE purpose='answer'),
            answer_timeout_seconds
          ),
          answer_max_concurrency=COALESCE(
            (SELECT max_concurrency FROM runtime_model_bindings WHERE purpose='answer'),
            answer_max_concurrency
          ),
          answer_binding_enabled=COALESCE(
            (SELECT enabled FROM runtime_model_bindings WHERE purpose='answer'),
            answer_binding_enabled
          ),
          answer_include_ai_memory=CASE
            WHEN (SELECT groups.purpose FROM telegram_groups groups WHERE groups.id=support_threads.group_id)='technical_alert'
              THEN 0 ELSE 1 END,
          answer_include_interface_docs=1,
          answer_include_magic_book=1`)
      }
      assertThreadAnswerPolicyStructure(connection)
    }
    connection.prepare("UPDATE metadata SET value='21' WHERE key='schema_version'").run()
    connection.exec("COMMIT")
  } catch (error) {
    try { connection.exec("ROLLBACK") } catch { /* 事务已结束时无需处理。 */ }
    throw error
  }
}

function migrateV21ToV22(connection: DatabaseSync): void {
  connection.exec("BEGIN IMMEDIATE")
  try {
    connection.exec(telegramOutputOwnershipSchema)
    assertTelegramOutputOwnershipStructure(connection)
    connection.prepare("UPDATE metadata SET value='22' WHERE key='schema_version'").run()
    connection.exec("COMMIT")
  } catch (error) {
    try { connection.exec("ROLLBACK") } catch { /* 事务已结束时无需处理。 */ }
    throw error
  }
}

function migrateV22ToV23(connection: DatabaseSync): void {
  assertTelegramOutputOwnershipRows(connection)
  connection.exec("BEGIN IMMEDIATE")
  try {
    connection.exec(`CREATE TABLE IF NOT EXISTS memory_maintenance_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
      scanned_events INTEGER NOT NULL DEFAULT 0,
      created_versions INTEGER NOT NULL DEFAULT 0,
      conflict_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT
    )`)
    if (!tableColumns(connection, "learning_source_observations").has("current_run_id")) {
      connection.exec(`ALTER TABLE learning_source_observations ADD COLUMN current_run_id TEXT
        REFERENCES memory_maintenance_runs(id) ON DELETE SET NULL`)
    }
    connection.exec(referenceLearningResultsSchema)
    const interruptedAt = new Date().toISOString()
    connection.prepare(`UPDATE memory_maintenance_runs SET status='failed',
      summary='旧版人工参考学习在 v23 迁移时中断',finished_at=? WHERE status='running'`).run(interruptedAt)
    connection.prepare(`UPDATE learning_source_observations
      SET processing_status='pending',lock_token=NULL,locked_at=NULL,current_run_id=NULL
      WHERE processing_status='running'`).run()
    assertReferenceLearningAuditStructure(connection)
    connection.prepare("UPDATE metadata SET value='23' WHERE key='schema_version'").run()
    connection.exec("COMMIT")
  } catch (error) {
    try { connection.exec("ROLLBACK") } catch { /* 事务已结束时无需处理。 */ }
    throw error
  }
}

function migrateV23ToV24(connection: DatabaseSync): void {
  connection.exec("BEGIN IMMEDIATE")
  try {
    connection.exec(`
      DROP TRIGGER IF EXISTS support_thread_messages_single_thread_insert;
      DROP TRIGGER IF EXISTS support_thread_messages_single_thread_update;
      DROP TRIGGER IF EXISTS support_message_events_batch_link_update;
    `)
    const eventColumns = connection.prepare("PRAGMA table_info(support_message_events)").all() as SqlRow[]
    if (eventColumns.length > 0) {
      if (!eventColumns.some((column) => column.name === "media_group_id")) {
        connection.exec("ALTER TABLE support_message_events ADD COLUMN media_group_id TEXT")
      }
      connection.exec(`CREATE INDEX IF NOT EXISTS support_message_events_media_group_idx
        ON support_message_events(group_id,media_group_id) WHERE media_group_id IS NOT NULL`)
    }
    connection.exec(supportThreadLinkSchema)
    connection.prepare("UPDATE metadata SET value='24' WHERE key='schema_version'").run()
    connection.exec("COMMIT")
  } catch (error) {
    try { connection.exec("ROLLBACK") } catch { /* 事务已结束时无需处理。 */ }
    throw error
  }
}

function assertMultiIssueThreadStructure(connection: DatabaseSync): void {
  const obsoleteTriggers = connection.prepare(`SELECT name FROM sqlite_master
    WHERE type='trigger' AND name IN (
      'support_thread_messages_single_thread_insert',
      'support_thread_messages_single_thread_update',
      'support_message_events_batch_link_update'
    ) LIMIT 1`).get() as SqlRow | undefined
  if (obsoleteTriggers) throw new Error("客服消息仍被旧版单线程约束限制")
  const columns = connection.prepare("PRAGMA table_info(support_thread_links)").all() as SqlRow[]
  if (columns.map((column) => String(column.name)).join(",")
    !== "source_thread_id,target_thread_id,relation,reason,created_at") {
    throw new Error("客服问题线程关联结构不完整")
  }
  const eventColumns = connection.prepare("PRAGMA table_info(support_message_events)").all() as SqlRow[]
  if (!eventColumns.some((column) => column.name === "media_group_id")) {
    throw new Error("客服附件组关联结构不完整")
  }
}

function assertSupportSenderFocusStructure(connection: DatabaseSync): void {
  const required = new Map<string, string[]>([
    ["support_sender_focus", [
      "group_id", "service_id", "sender_user_id", "thread_id", "source", "last_operator_message_id",
      "last_bot_message_id", "focused_at", "expires_at", "created_at", "updated_at",
    ]],
    ["support_route_clarifications", [
      "id", "group_id", "service_id", "sender_user_id", "message_event_id", "candidate_thread_ids_json",
      "candidate_labels_json", "status", "prompt_reply_id", "selected_thread_id", "created_at", "expires_at",
      "resolved_at", "updated_at",
    ]],
  ])
  for (const [table, columns] of required) {
    if (!tableExists(connection, table) || columns.some((column) => !tableColumns(connection, table).has(column))) {
      throw new Error("发送人会话焦点结构不完整，无法升级运行数据库")
    }
  }
}

function migrateV24ToV25(connection: DatabaseSync): void {
  assertTelegramOutputOwnershipRows(connection)
  assertReferenceLearningAuditStructure(connection)
  connection.exec("BEGIN IMMEDIATE")
  try {
    connection.exec(`
      DROP TRIGGER IF EXISTS support_thread_messages_single_thread_insert;
      DROP TRIGGER IF EXISTS support_thread_messages_single_thread_update;
      DROP TRIGGER IF EXISTS support_message_events_batch_link_update;
    `)
    const eventColumns = tableColumns(connection, "support_message_events")
    if (eventColumns.size > 0 && !eventColumns.has("media_group_id")) {
      connection.exec("ALTER TABLE support_message_events ADD COLUMN media_group_id TEXT")
    }
    if (eventColumns.size > 0) {
      connection.exec(`CREATE INDEX IF NOT EXISTS support_message_events_media_group_idx
        ON support_message_events(group_id,media_group_id) WHERE media_group_id IS NOT NULL`)
    }
    connection.exec(supportThreadLinkSchema)
    connection.exec(supportSenderFocusSchema)
    if (eventColumns.size > 0) assertMultiIssueThreadStructure(connection)
    assertSupportSenderFocusStructure(connection)
    connection.prepare("UPDATE metadata SET value='25' WHERE key='schema_version'").run()
    connection.exec("COMMIT")
  } catch (error) {
    try { connection.exec("ROLLBACK") } catch { /* 事务已结束时无需处理。 */ }
    throw error
  }
}

function migrateV25ToV26(connection: DatabaseSync): void {
  connection.exec("BEGIN IMMEDIATE")
  try {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS daily_group_shutdown_schedule (
        id INTEGER PRIMARY KEY CHECK (id=1),
        enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
        local_time TEXT NOT NULL CHECK (
          local_time GLOB '[0-2][0-9]:[0-5][0-9]'
          AND CAST(substr(local_time,1,2) AS INTEGER) BETWEEN 0 AND 23
        ),
        timezone TEXT NOT NULL CHECK (timezone='Asia/Shanghai'),
        last_run_local_date TEXT,
        last_run_at TEXT,
        last_disabled_count INTEGER NOT NULL DEFAULT 0 CHECK (last_disabled_count>=0),
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO daily_group_shutdown_schedule(
        id,enabled,local_time,timezone,last_run_local_date,last_run_at,last_disabled_count,updated_at
      ) VALUES (1,0,'23:00','Asia/Shanghai',NULL,NULL,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      UPDATE metadata SET value='26' WHERE key='schema_version';
    `)
    connection.exec("COMMIT")
  } catch (error) {
    try { connection.exec("ROLLBACK") } catch { /* 事务已结束时无需处理。 */ }
    throw error
  }
}

function migrateV26ToV27(connection: DatabaseSync): void {
  connection.exec("BEGIN IMMEDIATE")
  try {
    if (tableExists(connection, "support_threads")) {
      const columns = tableColumns(connection, "support_threads")
      if (!columns.has("human_priority_state")) {
        connection.exec(`ALTER TABLE support_threads ADD COLUMN human_priority_state TEXT NOT NULL DEFAULT 'none'
          CHECK(human_priority_state IN ('none','waiting','sending','claimed','answered'))`)
      }
      if (!columns.has("human_priority_user_ids_json")) {
        connection.exec("ALTER TABLE support_threads ADD COLUMN human_priority_user_ids_json TEXT NOT NULL DEFAULT '[]'")
      }
      if (!columns.has("human_priority_due_at")) {
        connection.exec("ALTER TABLE support_threads ADD COLUMN human_priority_due_at TEXT")
      }
      if (!columns.has("human_priority_source_event_id")) {
        connection.exec("ALTER TABLE support_threads ADD COLUMN human_priority_source_event_id TEXT")
      }
      if (!columns.has("human_priority_progress_message_id")) {
        connection.exec("ALTER TABLE support_threads ADD COLUMN human_priority_progress_message_id TEXT")
      }
      if (!columns.has("human_priority_error")) {
        connection.exec("ALTER TABLE support_threads ADD COLUMN human_priority_error TEXT")
      }
      connection.exec(`CREATE INDEX IF NOT EXISTS support_threads_human_priority_due_idx
        ON support_threads(human_priority_state,human_priority_due_at,id)`)
    }
    if (tableExists(connection, "support_message_events")) {
      const columns = tableColumns(connection, "support_message_events")
      if (!columns.has("human_priority_user_ids_json")) {
        connection.exec("ALTER TABLE support_message_events ADD COLUMN human_priority_user_ids_json TEXT NOT NULL DEFAULT '[]'")
      }
      if (!columns.has("human_priority_due_at")) {
        connection.exec("ALTER TABLE support_message_events ADD COLUMN human_priority_due_at TEXT")
      }
    }
    connection.exec("UPDATE metadata SET value='27' WHERE key='schema_version'")
    connection.exec("COMMIT")
  } catch (error) {
    try { connection.exec("ROLLBACK") } catch { /* 事务已结束时无需处理。 */ }
    throw error
  }
}

function migrateV27ToV28(connection: DatabaseSync): void {
  connection.exec("BEGIN IMMEDIATE")
  try {
    if (tableExists(connection, "telegram_groups") && !tableColumns(connection, "telegram_groups").has("operation_mode")) {
      connection.exec("ALTER TABLE telegram_groups ADD COLUMN operation_mode TEXT NOT NULL DEFAULT 'live' CHECK(operation_mode IN ('live','learning'))")
    }
    if (tableExists(connection, "support_threads") && !tableColumns(connection, "support_threads").has("answer_operation_mode")) {
      connection.exec("ALTER TABLE support_threads ADD COLUMN answer_operation_mode TEXT NOT NULL DEFAULT 'live' CHECK(answer_operation_mode IN ('live','learning'))")
    }
    connection.exec("UPDATE metadata SET value='28' WHERE key='schema_version'")
    connection.exec("COMMIT")
  } catch (error) {
    try { connection.exec("ROLLBACK") } catch { /* 事务已结束时无需处理。 */ }
    throw error
  }
}

const shadowLearningRequiredColumns: Record<string, string[]> = {
  shadow_answer_results: [
    "id", "reply_id", "thread_id", "input_revision", "outcome_status", "decision", "answer", "quote_text",
    "reason", "confidence", "code_revision", "memory_version_refs_json", "simulated_action", "output_redacted",
    "error_code", "created_at", "updated_at",
  ],
  shadow_human_answer_links: [
    "id", "observation_id", "human_message_event_id", "thread_id", "input_revision", "shadow_result_id",
    "match_reason", "match_confidence", "created_at",
  ],
  shadow_learning_reports: [
    "id", "trigger_type", "due_at", "cutoff_at", "status", "claim_token", "attempt_count", "sample_count",
    "summary_json", "rendered_markdown", "error_message", "started_at", "completed_at", "created_at", "updated_at",
  ],
  shadow_comparisons: [
    "id", "report_id", "shadow_result_id", "thread_id", "input_revision", "question_snapshot",
    "shadow_answer_snapshot", "human_answers_json", "human_message_event_ids_json", "comparison_json", "created_at",
  ],
}

const shadowLearningRequiredForeignKeys: Record<string, Array<[string, string, string]>> = {
  shadow_answer_results: [
    ["reply_id", "support_replies", "CASCADE"], ["thread_id", "support_threads", "CASCADE"],
  ],
  shadow_human_answer_links: [
    ["observation_id", "learning_source_observations", "RESTRICT"],
    ["human_message_event_id", "support_message_events", "RESTRICT"],
    ["thread_id", "support_threads", "CASCADE"], ["shadow_result_id", "shadow_answer_results", "SET NULL"],
  ],
  shadow_learning_reports: [],
  shadow_comparisons: [
    ["report_id", "shadow_learning_reports", "CASCADE"], ["shadow_result_id", "shadow_answer_results", "SET NULL"],
    ["thread_id", "support_threads", "SET NULL"],
  ],
}

const shadowLearningRequiredSql = new Map<string, string[]>([
  ["shadow_answer_results", ["check(outcome_statusin('completed','failed'))", "unique(thread_id,input_revision)"]],
  ["shadow_human_answer_links", ["check(match_reasonin('direct','split_family'))", "unique(human_message_event_id,thread_id,input_revision)"]],
  ["shadow_learning_reports", ["check(statusin('pending','running','completed','failed'))"]],
  ["shadow_comparisons", ["unique(report_id,shadow_result_id)"]],
])

function assertShadowLearningStructure(connection: DatabaseSync, existingOnly = false): void {
  const tables = Object.keys(shadowLearningRequiredColumns)
  const present = tables.filter((table) => tableExists(connection, table))
  if (!existingOnly && present.length !== tables.length) throw new Error("影子学习结构不完整")
  for (const table of present) {
    const columns = tableColumns(connection, table)
    if (shadowLearningRequiredColumns[table]!.some((column) => !columns.has(column))) {
      throw new Error(`影子学习结构不兼容：${table} 缺少必需列`)
    }
    const foreignKeys = connection.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      from: string
      table: string
      on_delete: string
    }>
    if (shadowLearningRequiredForeignKeys[table]!.some(([from, target, onDelete]) => !foreignKeys.some((key) => (
      key.from === from && key.table === target && key.on_delete.toUpperCase() === onDelete
    )))) throw new Error(`影子学习结构不兼容：${table} 外键约束不完整`)
    const row = connection.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as
      | { sql: string }
      | undefined
    const normalized = row?.sql.toLowerCase().replace(/\s+/gu, "") ?? ""
    if (shadowLearningRequiredSql.get(table)!.some((fragment) => !normalized.includes(fragment))) {
      throw new Error(`影子学习结构不兼容：${table} CHECK 或唯一约束不完整`)
    }
  }
}

function migrateV28ToV29(connection: DatabaseSync): void {
  connection.exec("BEGIN IMMEDIATE")
  try {
    assertShadowLearningStructure(connection, true)
    connection.exec(shadowLearningSchema)
    assertShadowLearningStructure(connection)
    if (tableExists(connection, "support_thread_notifications") && tableExists(connection, "support_threads")
      && tableColumns(connection, "support_threads").has("answer_operation_mode")) {
      connection.exec(`UPDATE support_thread_notifications AS notification
        SET status='failed',error_message='升级到 v29 时阻止学习模式历史通知出站',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE status IN ('pending','sending') AND EXISTS (
          SELECT 1 FROM support_threads thread
          WHERE thread.id=notification.thread_id AND thread.answer_operation_mode='learning'
        )`)
    }
    connection.exec("UPDATE metadata SET value='29' WHERE key='schema_version'")
    connection.exec("COMMIT")
  } catch (error) {
    try { connection.exec("ROLLBACK") } catch { /* 事务已结束时无需处理。 */ }
    throw error
  }
}

function migrateV29ToV30(connection: DatabaseSync): void {
  connection.exec("BEGIN IMMEDIATE")
  try {
    connection.exec(adminAccessSchema)
    connection.exec(adminAccessSeedSql)
    if (tableExists(connection, "admin_chat_sessions")) {
      const columns = tableColumns(connection, "admin_chat_sessions")
      if (!columns.has("created_by_user_id")) {
        connection.exec("ALTER TABLE admin_chat_sessions ADD COLUMN created_by_user_id TEXT REFERENCES admin_users(id) ON DELETE RESTRICT")
      }
      connection.exec(`CREATE INDEX IF NOT EXISTS admin_chat_sessions_owner_recent_idx
        ON admin_chat_sessions(created_by_user_id,updated_at DESC,id DESC)`)
    }
    connection.exec("UPDATE metadata SET value='30' WHERE key='schema_version'")
    connection.exec("COMMIT")
  } catch (error) {
    try { connection.exec("ROLLBACK") } catch { /* 事务已结束时无需处理。 */ }
    throw error
  }
}

function migrateV30ToV31(connection: DatabaseSync): void {
  connection.exec("BEGIN IMMEDIATE")
  try {
    connection.exec(`
      DROP INDEX IF EXISTS admin_role_menus_menu_idx;
      ALTER TABLE admin_role_menus RENAME TO admin_role_menus_v30;
      CREATE TABLE admin_role_menus (
        role_id TEXT NOT NULL REFERENCES admin_roles(id) ON DELETE CASCADE,
        menu_key TEXT NOT NULL CHECK(menu_key IN (
          'overview','projects','connections','replies','chat','memories','docs','models','runtime','transfer','settings','access'
        )),
        created_at TEXT NOT NULL,
        PRIMARY KEY(role_id,menu_key)
      );
      INSERT INTO admin_role_menus(role_id,menu_key,created_at)
      SELECT role_id,menu_key,created_at FROM admin_role_menus_v30;
      DROP TABLE admin_role_menus_v30;
      CREATE INDEX admin_role_menus_menu_idx ON admin_role_menus(menu_key,role_id);
      INSERT OR IGNORE INTO admin_role_menus(role_id,menu_key,created_at)
      VALUES('00000000-0000-4000-8000-000000000100','access',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      UPDATE metadata SET value='31' WHERE key='schema_version';
    `)
    connection.exec("COMMIT")
  } catch (error) {
    try { connection.exec("ROLLBACK") } catch { /* 事务已结束时无需处理。 */ }
    throw error
  }
}

function ensureAdminChatConversationExtensions(connection: DatabaseSync): void {
  connection.exec("DROP INDEX IF EXISTS admin_chat_turns_one_active_idx")
  connection.exec(adminChatConversationExtensionSchema)
}

function bool(value: unknown): boolean {
  return Number(value) === 1
}

function ensureV3Columns(connection: DatabaseSync): void {
  const serviceColumns = connection.prepare("PRAGMA table_info(project_services)").all() as SqlRow[]
  if (!serviceColumns.some((column) => column.name === "branch")) {
    connection.exec("ALTER TABLE project_services ADD COLUMN branch TEXT NOT NULL DEFAULT ''")
    connection.exec(`UPDATE project_services SET branch=COALESCE(
      (SELECT branch FROM project_repositories WHERE project_repositories.id=project_services.repository_id),
      'main'
    ) WHERE branch=''`)
  }
}

function ensureV3ReplySearch(connection: DatabaseSync): void {
  const ready = (connection.prepare("SELECT value FROM metadata WHERE key='support_reply_fts_ready'").get() as SqlRow | undefined)?.value
  if (ready === "1") return
  connection.exec("BEGIN IMMEDIATE")
  try {
    connection.exec("DELETE FROM support_reply_fts")
    connection.exec(`INSERT INTO support_reply_fts(reply_id,question,answer,service)
      SELECT p.reply_id,p.question,p.answer,r.service
      FROM support_reply_payloads p JOIN support_replies r ON r.id=p.reply_id`)
    connection.prepare("UPDATE metadata SET value='1' WHERE key='support_reply_fts_ready'").run()
    connection.exec("COMMIT")
  } catch (error) {
    connection.exec("ROLLBACK")
    throw error
  }
}

function jsonArray(value: unknown): string[] {
  const parsed = JSON.parse(String(value)) as unknown
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error("SQLite 数组字段格式错误")
  return parsed
}

export class RuntimeDatabase {
  private transactionSavepointSequence = 0

  private constructor(
    readonly filePath: string,
    readonly connection: DatabaseSync,
  ) {}

  static async open(filePath: string, seedGroups: RuntimeGroup[] = []): Promise<RuntimeDatabase> {
    const resolved = path.resolve(filePath)
    await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 })
    await chmod(path.dirname(resolved), 0o700)
    const connection = new DatabaseSync(resolved)
    const metadataExists = Boolean(connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'").get())
    const existingApplicationTable = Boolean(connection.prepare(`SELECT 1 FROM sqlite_master WHERE type='table'
      AND name IN ('telegram_accounts','telegram_groups','directives','memory_events','memory_versions','support_replies') LIMIT 1`).get())
    if (!metadataExists && existingApplicationTable) {
      connection.close()
      throw new Error("运行数据库版本不兼容")
    }
    if (metadataExists) {
      let current = Number((connection.prepare("SELECT value FROM metadata WHERE key='schema_version'").get() as SqlRow | undefined)?.value ?? 0)
      const openedVersion = current
      if (current === 2) { migrateV2ToV3(connection); current = 3 }
      if (current === 3) { migrateV3ToV4(connection); current = 4 }
      if (current === 4) { migrateV4ToV5(connection); current = 5 }
      if (current === 5) { migrateV5ToV6(connection); current = 6 }
      if (current === 6) { migrateV6ToV7(connection); current = 7 }
      if (current === 7) { migrateV7ToV8(connection); current = 8 }
      if (current === 8) { migrateV8ToV9(connection); current = 9 }
      if (current === 9) { migrateV9ToV10(connection); current = 10 }
      if (current === 10) { migrateV10ToV11(connection); current = 11 }
      if (current === 11) { migrateV11ToV12(connection); current = 12 }
      if ([12, 13, 14, 15, 16].includes(current)) { migrateToV16(connection); current = 16 }
      if (current === 16) { migrateV16ToV17(connection); current = 17 }
      if (current === 17) { migrateV17ToV18(connection); current = 18 }
      if (current === 18) { migrateV18ToV19(connection); current = 19 }
      if (current === 19) { migrateToV20(connection); current = 20 }
      if (current === 20) { migrateV20ToV21(connection); current = 21 }
      if (current === 21) { migrateV21ToV22(connection); current = 22 }
      if (current === 22) { migrateV22ToV23(connection); current = 23 }
      if (current === 23) { migrateV23ToV24(connection); current = 24 }
      if (current === 24) { migrateV24ToV25(connection); current = 25 }
      if (current === 25) { migrateV25ToV26(connection); current = 26 }
      if (current === 26) { migrateV26ToV27(connection); current = 27 }
      if (current === 27) { migrateV27ToV28(connection); current = 28 }
      if (current === 28) { migrateV28ToV29(connection); current = 29 }
      if (current === 29) { migrateV29ToV30(connection); current = 30 }
      if (current === 30) { migrateV30ToV31(connection); current = 31 }
      if (current !== DATABASE_SCHEMA_VERSION) {
        connection.close()
        throw new Error("运行数据库版本不兼容")
      }
      if (openedVersion >= 23) {
        try {
          assertTelegramOutputOwnershipRows(connection)
          assertReferenceLearningAuditStructure(connection)
        } catch (error) {
          connection.close()
          throw error
        }
      }
    }
    connection.exec(schema)
    ensureAdminChatConversationExtensions(connection)
    try {
      assertThreadAnswerPolicyStructure(connection)
      assertTelegramOutputOwnershipRows(connection)
      assertReferenceLearningAuditStructure(connection)
      assertMultiIssueThreadStructure(connection)
      assertSupportSenderFocusStructure(connection)
      assertShadowLearningStructure(connection)
    } catch (error) {
      connection.close()
      throw error
    }
    ensureV3Columns(connection)
    ensureV3ReplySearch(connection)
    connection.prepare(`UPDATE service_code_sync_batches SET status='interrupted',finished_at=?,
      duration_ms=MAX(0,CAST((julianday(?) - julianday(started_at))*86400000 AS INTEGER)),
      error_stage='prepare_repository',error_type='process_interrupted',safe_summary='同步进程中断'
      WHERE status='running'`).run(new Date().toISOString(), new Date().toISOString())
    await chmod(resolved, 0o600)
    await Promise.all([`${resolved}-wal`, `${resolved}-shm`].map(async (sidecar) => {
      try { await chmod(sidecar, 0o600) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }))
    const runtime = new RuntimeDatabase(resolved, connection)
    const count = Number((connection.prepare("SELECT COUNT(*) AS count FROM telegram_groups").get() as SqlRow).count)
    if (count === 0 && seedGroups.length > 0) runtime.transaction(() => seedGroups.forEach((group) => runtime.insertGroup(group)))
    return runtime
  }

  static openPortable(filePath: string, readOnly = false): RuntimeDatabase {
    const resolved = path.resolve(filePath)
    const connection = new DatabaseSync(resolved, { readOnly })
    if (!readOnly) {
      let current = Number((connection.prepare("SELECT value FROM metadata WHERE key='schema_version'").get() as SqlRow | undefined)?.value ?? 0)
      const openedVersion = current
      if (current === 2) { migrateV2ToV3(connection); current = 3 }
      if (current === 3) { migrateV3ToV4(connection); current = 4 }
      if (current === 4) { migrateV4ToV5(connection); current = 5 }
      if (current === 5) { migrateV5ToV6(connection); current = 6 }
      if (current === 6) { migrateV6ToV7(connection); current = 7 }
      if (current === 7) { migrateV7ToV8(connection); current = 8 }
      if (current === 8) { migrateV8ToV9(connection); current = 9 }
      if (current === 9) { migrateV9ToV10(connection); current = 10 }
      if (current === 10) { migrateV10ToV11(connection); current = 11 }
      if (current === 11) { migrateV11ToV12(connection); current = 12 }
      if ([12, 13, 14, 15, 16].includes(current)) { migrateToV16(connection); current = 16 }
      if (current === 16) { migrateV16ToV17(connection); current = 17 }
      if (current === 17) { migrateV17ToV18(connection); current = 18 }
      if (current === 18) { migrateV18ToV19(connection); current = 19 }
      if (current === 19) { migrateToV20(connection); current = 20 }
      if (current === 20) { migrateV20ToV21(connection); current = 21 }
      if (current === 21) { migrateV21ToV22(connection); current = 22 }
      if (current === 22) { migrateV22ToV23(connection); current = 23 }
      if (current === 23) { migrateV23ToV24(connection); current = 24 }
      if (current === 24) { migrateV24ToV25(connection); current = 25 }
      if (current === 25) { migrateV25ToV26(connection); current = 26 }
      if (current === 26) { migrateV26ToV27(connection); current = 27 }
      if (current === 27) { migrateV27ToV28(connection); current = 28 }
      if (current === 28) { migrateV28ToV29(connection); current = 29 }
      if (current === 29) { migrateV29ToV30(connection); current = 30 }
      if (current === 30) { migrateV30ToV31(connection); current = 31 }
      if (current !== DATABASE_SCHEMA_VERSION) {
        connection.close()
        throw new Error("迁移数据库版本不兼容")
      }
      if (openedVersion >= 23) {
        try {
          assertTelegramOutputOwnershipRows(connection)
          assertReferenceLearningAuditStructure(connection)
        } catch (error) {
          connection.close()
          throw error
        }
      }
      connection.exec(schema)
      ensureAdminChatConversationExtensions(connection)
      try {
        assertThreadAnswerPolicyStructure(connection)
        assertTelegramOutputOwnershipRows(connection)
        assertReferenceLearningAuditStructure(connection)
        assertMultiIssueThreadStructure(connection)
        assertSupportSenderFocusStructure(connection)
        assertShadowLearningStructure(connection)
        assertPortableReferenceLearningGroupTopology(connection)
        ensureV3Columns(connection)
        ensureV3ReplySearch(connection)
      } catch (error) {
        connection.close()
        throw error
      }
    } else {
      try {
        const current = Number((connection.prepare(
          "SELECT value FROM metadata WHERE key='schema_version'",
        ).get() as SqlRow | undefined)?.value ?? 0)
        if (current >= 23) {
          assertReferenceLearningAuditStructure(connection)
          assertPortableReferenceLearningGroupTopology(connection)
        }
        if (current === 28 && Object.keys(shadowLearningRequiredColumns).some((table) => tableExists(connection, table))) {
          assertShadowLearningStructure(connection)
        }
        if (current >= DATABASE_SCHEMA_VERSION) {
          assertMultiIssueThreadStructure(connection)
          assertSupportSenderFocusStructure(connection)
          assertShadowLearningStructure(connection)
        }
      } catch (error) {
        connection.close()
        throw error
      }
    }
    return new RuntimeDatabase(resolved, connection)
  }

  close(): void {
    this.connection.close()
  }

  transaction<T>(operation: () => T): T {
    if (this.connection.isTransaction) {
      const savepoint = `runtime_nested_${this.transactionSavepointSequence += 1}`
      this.connection.exec(`SAVEPOINT ${savepoint}`)
      try {
        const result = operation()
        this.connection.exec(`RELEASE SAVEPOINT ${savepoint}`)
        return result
      } catch (error) {
        this.connection.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
        this.connection.exec(`RELEASE SAVEPOINT ${savepoint}`)
        throw error
      }
    }
    this.connection.exec("BEGIN IMMEDIATE")
    try {
      const result = operation()
      this.connection.exec("COMMIT")
      return result
    } catch (error) {
      this.connection.exec("ROLLBACK")
      throw error
    }
  }

  prepare(sql: string): StatementSync {
    return this.connection.prepare(sql)
  }

  suspendSupportThreadMessageInvariant(): void {
    this.prepare("UPDATE metadata SET value='1' WHERE key='allow_support_history_import'").run()
  }

  restoreSupportThreadMessageInvariant(): void {
    this.prepare("UPDATE metadata SET value='0' WHERE key='allow_support_history_import'").run()
  }

  schemaVersion(): number {
    return Number((this.prepare("SELECT value FROM metadata WHERE key='schema_version'").get() as SqlRow | undefined)?.value ?? 0)
  }

  memoryGeneration(): number {
    return Number((this.prepare("SELECT value FROM metadata WHERE key='memory_generation'").get() as SqlRow | undefined)?.value ?? 0)
  }

  bumpMemoryGeneration(): void {
    this.prepare("UPDATE metadata SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='memory_generation'").run()
  }

  readProjects(where = "", parameters: SqlParameter[] = []): ProjectRecord[] {
    return (this.prepare(`SELECT * FROM projects ${where}`).all(...parameters) as SqlRow[]).map((row) => projectRecordSchema.parse({
      id: row.id, key: row.project_key, name: row.name, description: row.description, enabled: bool(row.enabled),
      defaultKnowledgeScope: row.default_knowledge_scope, createdAt: row.created_at, updatedAt: row.updated_at,
    }))
  }

  readProjectRepositories(where = "", parameters: SqlParameter[] = []): ProjectRepositoryRecord[] {
    return (this.prepare(`SELECT * FROM project_repositories ${where}`).all(...parameters) as SqlRow[]).map((row) => projectRepositoryRecordSchema.parse({
      id: row.id, projectId: row.project_id, name: row.name, localPath: row.local_path, remoteUrl: row.remote_url,
      branch: row.branch, enabled: bool(row.enabled), createdAt: row.created_at, updatedAt: row.updated_at,
    }))
  }

  readProjectServiceRepositories(where = "", parameters: SqlParameter[] = []): ProjectServiceRepositoryBindingRecord[] {
    return (this.prepare(`SELECT * FROM project_service_repositories ${where}`).all(...parameters) as SqlRow[]).map((row) => (
      projectServiceRepositoryBindingRecordSchema.parse({
        serviceId: row.service_id, repositoryId: row.repository_id, role: row.role,
        createdAt: row.created_at, updatedAt: row.updated_at,
      })
    ))
  }

  readProjectServices(where = "", parameters: SqlParameter[] = []): ProjectServiceRecord[] {
    return (this.prepare(`SELECT * FROM project_services ${where}`).all(...parameters) as SqlRow[]).map((row) => projectServiceRecordSchema.parse({
      id: row.id, projectId: row.project_id, key: row.service_key, name: row.name, region: row.region,
      timezone: row.timezone, repositoryId: row.repository_id,
      branch: row.branch || (row.repository_id
        ? (this.prepare("SELECT branch FROM project_repositories WHERE id=?").get(row.repository_id as string) as SqlRow | undefined)?.branch
        : undefined) || "main",
      enabled: bool(row.enabled),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }))
  }

  readServerResources(where = "", parameters: SqlParameter[] = []): ServerResourceRecord[] {
    return (this.prepare(`SELECT * FROM project_servers ${where}`).all(...parameters) as SqlRow[]).map((row) => serverResourceRecordSchema.parse({
      id: row.id, projectId: row.project_id, serviceId: row.service_id, alias: row.alias, host: row.host,
      port: Number(row.port), username: row.username, privateKey: row.private_key, workdir: row.workdir,
      enabled: bool(row.enabled), createdAt: row.created_at, updatedAt: row.updated_at,
    }))
  }

  readDatabaseResources(where = "", parameters: SqlParameter[] = []): DatabaseResourceRecord[] {
    return (this.prepare(`SELECT * FROM project_databases ${where}`).all(...parameters) as SqlRow[]).map((row) => databaseResourceRecordSchema.parse({
      id: row.id, projectId: row.project_id, serviceId: row.service_id, alias: row.alias, engine: row.engine,
      host: row.host, port: Number(row.port), database: row.database_name, username: row.username,
      password: row.password, timezone: row.timezone, enabled: bool(row.enabled), createdAt: row.created_at, updatedAt: row.updated_at,
    }))
  }

  readAccounts(): TelegramAccount[] {
    return (this.prepare("SELECT * FROM telegram_accounts ORDER BY created_at").all() as SqlRow[]).map((row) => telegramAccountSchema.parse({
      id: row.id, name: row.name, type: row.type, enabled: bool(row.enabled), status: row.status,
      statusMessage: row.status_message, credentials: JSON.parse(String(row.credentials)), botUsername: row.bot_username,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }))
  }

  readGroups(): RuntimeGroup[] {
    return (this.prepare("SELECT * FROM telegram_groups ORDER BY purpose DESC, created_at").all() as SqlRow[]).map((row) => runtimeGroupSchema.parse({
      id: row.id, key: row.group_key, name: row.name, telegramChatId: row.telegram_chat_id, accountId: row.account_id,
      projectId: row.project_id, serviceId: row.service_id,
      enabled: bool(row.enabled), accessMode: row.access_mode, triggerMode: row.trigger_mode, platform: row.platform,
      repositories: jsonArray(row.repositories), branch: row.branch, serverAlias: row.server_alias,
      databaseAlias: row.database_alias, knowledgeScope: row.knowledge_scope, purpose: row.purpose,
      aiModelInstanceId: row.ai_model_instance_id, replyStyle: row.reply_style,
      operationMode: row.operation_mode,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }))
  }

  readRoles(): TelegramRole[] {
    return (this.prepare("SELECT * FROM telegram_roles ORDER BY created_at").all() as SqlRow[]).map((row) => telegramRoleSchema.parse({
      id: row.id, telegramUserId: row.telegram_user_id, username: row.username, displayName: row.display_name,
      role: row.role, canCorrect: bool(row.can_correct), enabled: bool(row.enabled), learningSourceEnabled: bool(row.learning_source_enabled), createdAt: row.created_at, updatedAt: row.updated_at,
    }))
  }

  readOperatorStyleVersions(where = "", parameters: SqlParameter[] = []): OperatorStyleVersion[] {
    return (this.prepare(`SELECT * FROM operator_style_versions ${where}`).all(...parameters) as SqlRow[]).map((row) => (
      operatorStyleVersionSchema.parse({
        id: row.id,
        version: Number(row.version_number),
        profile: JSON.parse(String(row.profile_json)),
        status: row.status,
        sampleCount: Number(row.sample_count),
        sourceUserCount: Number(row.source_user_count),
        threadCount: Number(row.thread_count),
        createdAt: row.created_at,
        activatedAt: row.activated_at,
        supersededAt: row.superseded_at,
      })
    ))
  }

  readActiveOperatorStyle(): { versionId: string | null; profile: typeof baselineOperatorStyleProfile } {
    try {
      const active = this.readOperatorStyleVersions("WHERE status='active' ORDER BY version_number DESC LIMIT 1")[0]
      return active
        ? { versionId: active.id, profile: active.profile }
        : { versionId: null, profile: baselineOperatorStyleProfile }
    } catch {
      return { versionId: null, profile: baselineOperatorStyleProfile }
    }
  }

  readDirectives(where = "", parameters: SqlParameter[] = []): Directive[] {
    return (this.prepare(`SELECT * FROM directives ${where}`).all(...parameters) as SqlRow[]).map((row) => directiveSchema.parse({
      id: row.id, title: row.title, content: row.content, scope: row.scope, source: row.source,
      priority: Number(row.priority), enabled: bool(row.enabled), createdAt: row.created_at, disabledAt: row.disabled_at,
    }))
  }

  readEvents(where = "", parameters: SqlParameter[] = []): MemoryEvent[] {
    return (this.prepare(`SELECT * FROM memory_events ${where}`).all(...parameters) as SqlRow[]).map((row) => memoryEventSchema.parse({
      id: row.id, type: row.type, sourceRef: row.source_ref, factId: row.fact_id, replyRecordId: row.reply_record_id,
      content: row.content, scope: row.scope, region: row.region, branch: row.branch, codeRevision: row.code_revision,
      risk: row.risk, confidence: Number(row.confidence), actor: row.actor, occurredAt: row.occurred_at,
    }))
  }

  readFacts(where = "", parameters: SqlParameter[] = []): MemoryFact[] {
    return (this.prepare(`SELECT * FROM memory_facts ${where}`).all(...parameters) as SqlRow[]).map((row) => memoryFactSchema.parse({
      id: row.id, topicKey: row.topic_key, title: row.title, currentVersionId: row.current_version_id, createdAt: row.created_at,
    }))
  }

  readVersions(where = "", parameters: SqlParameter[] = []): MemoryVersion[] {
    return (this.prepare(`SELECT * FROM memory_versions ${where}`).all(...parameters) as SqlRow[]).map((row) => memoryVersionSchema.parse({
      id: row.id, factId: row.fact_id, version: Number(row.version_number), title: row.title, content: row.content,
      scope: row.scope, region: row.region, branch: row.branch, source: row.source, risk: row.risk,
      confidence: Number(row.confidence), status: row.status, conflictReason: row.conflict_reason,
      validFrom: row.valid_from, validTo: row.valid_to, createdByEventId: row.created_by_event_id, createdAt: row.created_at,
    }))
  }

  readMemoryViews(where = "", parameters: SqlParameter[] = []): MemoryView[] {
    const rows = this.prepare(`SELECT v.*, f.topic_key, f.current_version_id,
      (SELECT COUNT(*) FROM memory_version_evidence e WHERE e.memory_version_id=v.id) AS evidence_count,
      v.version_number - 1 AS previous_version_count
      FROM memory_versions v JOIN memory_facts f ON f.id=v.fact_id ${where}`).all(...parameters) as SqlRow[]
    return rows.map((row) => memoryViewSchema.parse({
      id: row.id, versionId: row.id, factId: row.fact_id, version: Number(row.version_number), title: row.title, content: row.content,
      scope: row.scope, region: row.region, branch: row.branch, source: row.source, risk: row.risk,
      confidence: Number(row.confidence), status: row.status, conflictReason: row.conflict_reason,
      validFrom: row.valid_from, validTo: row.valid_to, createdByEventId: row.created_by_event_id, createdAt: row.created_at,
      topicKey: row.topic_key, currentVersionId: row.current_version_id, evidenceCount: Number(row.evidence_count),
      previousVersionCount: Number(row.previous_version_count),
    }))
  }

  readReplies(where = "", parameters: SqlParameter[] = []): ReplyRecord[] {
    const rows = this.prepare(`SELECT r.*, p.question, p.answer, p.quote_text
      FROM support_replies r JOIN support_reply_payloads p ON p.reply_id=r.id ${where}`).all(...parameters) as SqlRow[]
    const replyIds = rows.map((row) => String(row.id))
    const referenceRows = replyIds.length === 0 ? [] : this.prepare(
      `SELECT reply_id,memory_version_id FROM reply_memory_refs WHERE reply_id IN (${replyIds.map(() => "?").join(",")})`,
    ).all(...replyIds) as SqlRow[]
    const references = new Map<string, string[]>()
    referenceRows.forEach((row) => references.set(String(row.reply_id), [
      ...(references.get(String(row.reply_id)) ?? []), String(row.memory_version_id),
    ]))
    return rows.map((row) => replyRecordSchema.parse({
      id: row.id, threadId: row.thread_id, inputRevision: row.input_revision === null ? null : Number(row.input_revision),
      groupId: row.group_id, accountId: row.account_id, telegramMessageId: row.telegram_message_id,
      projectId: row.project_id, serviceId: row.service_id,
      telegramReplyMessageId: row.telegram_reply_message_id, senderUserId: row.sender_user_id,
      senderUsername: row.sender_username, senderDisplayName: row.sender_display_name, senderRole: row.sender_role,
      service: row.service, serviceSource: row.service_source, question: row.question,
      answer: row.answer, quote: row.quote_text, decision: row.decision, status: row.status,
      memoryVersionRefs: references.get(String(row.id)) ?? [], codeRevision: row.code_revision,
      codeSnapshotId: row.code_snapshot_id, codeSyncBatchId: row.code_sync_batch_id,
      operatorDeliveryStatus: row.operator_delivery_status,
      createdAt: row.created_at, updatedAt: row.updated_at, generationStartedAt: row.generation_started_at,
      heartbeatAt: row.heartbeat_at, durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      errorCode: row.error_code, decisionReason: row.decision_reason,
      decisionConfidence: row.decision_confidence === null ? null : Number(row.decision_confidence), correctedAt: row.corrected_at,
    }))
  }

  readMaintenanceRuns(where = "", parameters: SqlParameter[] = []): MaintenanceRun[] {
    return (this.prepare(`SELECT * FROM memory_maintenance_runs ${where}`).all(...parameters) as SqlRow[]).map((row) => maintenanceRunSchema.parse({
      id: row.id, status: row.status, scannedEvents: Number(row.scanned_events), createdVersions: Number(row.created_versions),
      conflictCount: Number(row.conflict_count), summary: row.summary, startedAt: row.started_at, finishedAt: row.finished_at,
    }))
  }

  insertProject(project: ProjectRecord): void {
    this.prepare(`INSERT INTO projects(id,project_key,name,description,enabled,default_knowledge_scope,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      project.id, project.key, project.name, project.description, Number(project.enabled), project.defaultKnowledgeScope,
      project.createdAt, project.updatedAt,
    )
  }

  insertProjectRepository(repository: ProjectRepositoryRecord): void {
    this.prepare(`INSERT INTO project_repositories(id,project_id,name,local_path,remote_url,branch,enabled,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      repository.id, repository.projectId, repository.name, repository.localPath, repository.remoteUrl, repository.branch,
      Number(repository.enabled), repository.createdAt, repository.updatedAt,
    )
  }

  insertProjectService(service: ProjectServiceRecord): void {
    this.prepare(`INSERT INTO project_services(id,project_id,service_key,name,region,timezone,repository_id,branch,enabled,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      service.id, service.projectId, service.key, service.name, service.region, service.timezone, service.repositoryId,
      service.branch, Number(service.enabled), service.createdAt, service.updatedAt,
    )
    this.prepare(`INSERT OR IGNORE INTO project_service_repositories(service_id,repository_id,role,created_at,updated_at)
      SELECT ?,id,'backend',?,? FROM project_repositories WHERE project_id=? AND name='java-project'
      AND (SELECT COUNT(*) FROM project_repositories WHERE project_id=? AND name='java-project')=1`).run(
      service.id, service.createdAt, service.updatedAt, service.projectId, service.projectId,
    )
    this.prepare(`INSERT OR IGNORE INTO project_service_repositories(service_id,repository_id,role,created_at,updated_at)
      SELECT ?,id,'frontend',?,? FROM project_repositories WHERE project_id=? AND name='sfzf-web'
      AND (SELECT COUNT(*) FROM project_repositories WHERE project_id=? AND name='sfzf-web')=1`).run(
      service.id, service.createdAt, service.updatedAt, service.projectId, service.projectId,
    )
    this.prepare(`INSERT OR IGNORE INTO service_code_sync_schedule(
      service_id,next_hourly_sync_at,health_status,last_success_at,last_failure_at,failure_count,last_alert_fingerprint,created_at,updated_at
    ) VALUES (?,?,'never',NULL,NULL,0,NULL,?,?)`).run(
      service.id, service.createdAt, service.createdAt, service.updatedAt,
    )
  }

  insertServerResource(server: ServerResourceRecord): void {
    this.prepare(`INSERT INTO project_servers(id,project_id,service_id,alias,host,port,username,private_key,workdir,enabled,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      server.id, server.projectId, server.serviceId, server.alias, server.host, server.port, server.username,
      server.privateKey, server.workdir, Number(server.enabled), server.createdAt, server.updatedAt,
    )
  }

  insertDatabaseResource(database: DatabaseResourceRecord): void {
    this.prepare(`INSERT INTO project_databases(id,project_id,service_id,alias,engine,host,port,database_name,username,password,timezone,enabled,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      database.id, database.projectId, database.serviceId, database.alias, database.engine, database.host, database.port,
      database.database, database.username, database.password, database.timezone, Number(database.enabled),
      database.createdAt, database.updatedAt,
    )
  }

  insertAccount(account: TelegramAccount): void {
    this.prepare(`INSERT INTO telegram_accounts
      (id,name,type,enabled,status,status_message,credentials,bot_username,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      account.id, account.name, account.type, Number(account.enabled), account.status, account.statusMessage,
      JSON.stringify(account.credentials), account.botUsername, account.createdAt, account.updatedAt,
    )
  }

  insertGroup(group: RuntimeGroup): void {
    this.prepare(`INSERT INTO telegram_groups
      (id,group_key,name,telegram_chat_id,account_id,project_id,service_id,enabled,access_mode,trigger_mode,platform,repositories,branch,server_alias,database_alias,knowledge_scope,purpose,ai_model_instance_id,reply_style,operation_mode,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      group.id, group.key, group.name, group.telegramChatId, group.accountId, group.projectId, group.serviceId, Number(group.enabled), group.accessMode,
      group.triggerMode, group.platform, JSON.stringify(group.repositories), group.branch, group.serverAlias,
      group.databaseAlias, group.knowledgeScope, group.purpose, group.aiModelInstanceId, group.replyStyle,
      group.operationMode ?? "live", group.createdAt, group.updatedAt,
    )
  }

  insertRole(role: TelegramRole): void {
    this.prepare(`INSERT INTO telegram_roles
      (id,telegram_user_id,username,display_name,role,can_correct,enabled,learning_source_enabled,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      role.id, role.telegramUserId, role.username, role.displayName, role.role, Number(role.canCorrect), Number(role.enabled), Number(role.learningSourceEnabled), role.createdAt, role.updatedAt,
    )
  }

  insertDirective(directive: Directive): void {
    this.prepare(`INSERT INTO directives(id,title,content,scope,source,priority,enabled,created_at,disabled_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      directive.id, directive.title, directive.content, directive.scope, directive.source, directive.priority,
      Number(directive.enabled), directive.createdAt, directive.disabledAt,
    )
  }

  insertOperatorStyleVersion(version: OperatorStyleVersion): void {
    const parsed = operatorStyleVersionSchema.parse(version)
    this.prepare(`INSERT INTO operator_style_versions(
      id,version_number,profile_json,status,sample_count,source_user_count,thread_count,created_at,activated_at,superseded_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      parsed.id, parsed.version, JSON.stringify(parsed.profile), parsed.status, parsed.sampleCount, parsed.sourceUserCount,
      parsed.threadCount, parsed.createdAt, parsed.activatedAt, parsed.supersededAt,
    )
  }

  replaceSystemDirectives(directives: Directive[]): void {
    this.prepare("UPDATE metadata SET value='1' WHERE key='allow_maintenance_delete'").run()
    try {
      this.prepare("DELETE FROM directives WHERE source='system'").run()
      directives.forEach((directive) => this.insertDirective(directive))
    } finally {
      this.prepare("UPDATE metadata SET value='0' WHERE key='allow_maintenance_delete'").run()
    }
  }

  insertFact(fact: MemoryFact): void {
    this.prepare("INSERT INTO memory_facts(id,topic_key,title,current_version_id,created_at) VALUES (?,?,?,?,?)").run(
      fact.id, fact.topicKey, fact.title, fact.currentVersionId, fact.createdAt,
    )
  }

  insertEvent(event: MemoryEvent): void {
    this.prepare(`INSERT INTO memory_events
      (id,type,source_ref,fact_id,reply_record_id,content,scope,region,branch,code_revision,risk,confidence,actor,occurred_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      event.id, event.type, event.sourceRef, event.factId, event.replyRecordId, event.content, event.scope,
      event.region, event.branch, event.codeRevision, event.risk, event.confidence, event.actor, event.occurredAt,
    )
  }

  insertVersion(version: MemoryVersion, contentHash: string): void {
    this.prepare(`INSERT INTO memory_versions
      (id,fact_id,version_number,title,content,content_hash,scope,region,branch,source,risk,confidence,status,conflict_reason,valid_from,valid_to,created_by_event_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      version.id, version.factId, version.version, version.title, version.content, contentHash, version.scope,
      version.region, version.branch, version.source, version.risk, version.confidence, version.status,
      version.conflictReason, version.validFrom, version.validTo, version.createdByEventId, version.createdAt,
    )
  }

  insertVersionEvidence(versionId: string, eventId: string): void {
    this.prepare("INSERT OR IGNORE INTO memory_version_evidence(memory_version_id,event_id) VALUES (?,?)").run(versionId, eventId)
  }

  setCurrentVersion(factId: string, versionId: string | null): void {
    this.prepare("UPDATE memory_facts SET current_version_id=? WHERE id=?").run(versionId, factId)
  }

  insertReply(record: ReplyRecord): void {
    this.prepare(`INSERT INTO support_replies
      (id,thread_id,input_revision,group_id,account_id,project_id,service_id,telegram_message_id,telegram_reply_message_id,service,decision,status,
       sender_user_id,sender_username,sender_display_name,sender_role,service_source,code_revision,code_snapshot_id,code_sync_batch_id,operator_delivery_status,created_at,updated_at,
       generation_started_at,heartbeat_at,duration_ms,error_code,decision_reason,decision_confidence,corrected_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      record.id, record.threadId, record.inputRevision, record.groupId, record.accountId, record.projectId, record.serviceId, record.telegramMessageId,
      record.telegramReplyMessageId, record.service, record.decision, record.status, record.senderUserId,
      record.senderUsername, record.senderDisplayName, record.senderRole, record.serviceSource, record.codeRevision,
      record.codeSnapshotId, record.codeSyncBatchId, record.operatorDeliveryStatus,
      record.createdAt, record.updatedAt, record.generationStartedAt, record.heartbeatAt, record.durationMs,
      record.errorCode, record.decisionReason, record.decisionConfidence, record.correctedAt,
    )
    this.prepare(`INSERT INTO support_reply_payloads(reply_id,question,answer,quote_text,has_attachment)
      VALUES (?,?,?,?,0)`).run(record.id, record.question, record.answer, record.quote)
    const insertReference = this.prepare("INSERT OR IGNORE INTO reply_memory_refs(reply_id,memory_version_id) VALUES (?,?)")
    record.memoryVersionRefs.forEach((versionId) => insertReference.run(record.id, versionId))
  }

  insertMaintenanceRun(run: MaintenanceRun): void {
    this.prepare(`INSERT INTO memory_maintenance_runs
      (id,status,scanned_events,created_versions,conflict_count,summary,started_at,finished_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      run.id, run.status, run.scannedEvents, run.createdVersions, run.conflictCount, run.summary, run.startedAt, run.finishedAt,
    )
  }

  clearPortableData(): void {
    this.prepare("UPDATE metadata SET value='1' WHERE key='allow_maintenance_delete'").run()
    try {
      this.connection.exec(`
        DELETE FROM shadow_comparisons;
        DELETE FROM shadow_human_answer_links;
        DELETE FROM shadow_answer_results;
        DELETE FROM shadow_learning_reports;
        DELETE FROM telegram_outgoing_candidates;
        DELETE FROM telegram_output_ownership;
        DELETE FROM telegram_offsets;
        DELETE FROM code_sync_runs;
        DELETE FROM service_code_snapshot_items;
        DELETE FROM service_code_sync_batches;
        DELETE FROM service_code_snapshots;
        DELETE FROM service_code_sync_schedule;
        DELETE FROM admin_chat_turns;
        DELETE FROM admin_chat_sessions;
        DELETE FROM reply_memory_refs;
        DELETE FROM support_replies;
        DELETE FROM operator_style_version_evidence;
        DELETE FROM operator_style_versions;
        DELETE FROM reference_learning_results;
        DELETE FROM learning_source_observations;
        DELETE FROM support_threads;
        DELETE FROM support_message_events;
        DELETE FROM memory_version_evidence;
        DELETE FROM memory_versions;
        DELETE FROM memory_events;
        DELETE FROM memory_facts;
        DELETE FROM directives;
        DELETE FROM telegram_roles;
        DELETE FROM telegram_groups;
        DELETE FROM project_databases;
        DELETE FROM project_servers;
        DELETE FROM project_service_repositories;
        DELETE FROM project_services;
        DELETE FROM project_repositories;
        DELETE FROM projects;
        DELETE FROM memory_maintenance_runs;
        DELETE FROM runtime_model_bindings;
        DELETE FROM model_catalog_entries;
        DELETE FROM model_instances;
        DELETE FROM runtime_settings;
        DELETE FROM daily_group_shutdown_schedule;
      `)
    } finally {
      this.prepare("UPDATE metadata SET value='0' WHERE key='allow_maintenance_delete'").run()
    }
  }
}
