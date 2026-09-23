import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/**
 * 数据合同版本。
 * v1：最小议案记录（仅标识与时间）。
 * v2：可审计的会议与表决记录，在 v1 的标识/时间语义上扩展，
 *     新增会议、治理参数表与全部议事轨迹集合。
 */
export const SCHEMA_VERSION = 2;

/** 治理参数表：全部按生效时间保存，解析时取覆盖目标时点的条目。 */
export const GOVERNANCE_TABLES = [
  'memberships',      // 成员资格
  'delegations',      // 授权代表
  'recusals',         // 回避关系（利益冲突披露）
  'materials',        // 材料版本
  'review_windows',   // 评议窗口
  'quorum_rules',     // 法定人数规则
  'thresholds',       // 表决门槛
  'officers',         // 职权（主席、安全官、升级受理方等）
  'agenda_scopes',    // 议题范围
];

/** 议事轨迹集合：只增不改，任何状态变更先落轨迹再改视图。 */
export const SESSION_TABLES = [
  'motions', 'ballots', 'minority_opinions', 'tallies', 'corrections',
  'decisions', 'actions', 'conditions', 'notices', 'audit',
];

/** 读取项目已经确认的数据合同；按 schema_version 分别校验。 */
export async function loadRecord(path) {
  const payload = JSON.parse(await readFile(path, 'utf8'));
  return Object.freeze(validateRecord(payload));
}

export function validateRecord(payload) {
  if (!payload || !Number.isInteger(payload.schema_version) || !payload.record_id) {
    throw new Error('数据合同缺少必要标识');
  }
  if (payload.schema_version === 1) return payload;
  if (payload.schema_version === 2) {
    validateSessionRecord(payload);
    return payload;
  }
  throw new Error(`不支持的数据合同版本: ${payload.schema_version}`);
}

function validateSessionRecord(payload) {
  if (!payload.meeting || typeof payload.meeting.meeting_id !== 'string') {
    throw new Error('v2 记录缺少会议标识');
  }
  if (!payload.governance || typeof payload.governance !== 'object') {
    throw new Error('v2 记录缺少治理参数表');
  }
  for (const key of GOVERNANCE_TABLES) {
    if (!Array.isArray(payload.governance[key])) {
      throw new Error(`治理参数表缺少 ${key}`);
    }
  }
  for (const key of SESSION_TABLES) {
    if (!Array.isArray(payload[key])) {
      throw new Error(`v2 记录缺少 ${key}`);
    }
  }
}

/** 创建空的 v2 会议会话骨架。 */
export function createSession({ record_id, occurred_at, source = null, meeting, domain = 'drug_council' }) {
  return {
    schema_version: SCHEMA_VERSION,
    record_id,
    domain,
    occurred_at,
    revision: 1,
    source,
    meeting,
    governance: Object.fromEntries(GOVERNANCE_TABLES.map((key) => [key, []])),
    ...Object.fromEntries(SESSION_TABLES.map((key) => [key, []])),
  };
}

/** 将 v2 记录装载为可操作的会话对象（深拷贝，冻结记录不被改写）。 */
export function loadSession(record) {
  validateRecord(record);
  if (record.schema_version !== SCHEMA_VERSION) {
    throw new Error('仅 v2 记录可装载为会议会话');
  }
  return structuredClone(record);
}

/** 导出会话为 v2 记录；revision 随审计轨迹长度递增，保持“修订号单调”的既有语义。 */
export function exportSession(session) {
  return { ...session, revision: session.audit.length + 1 };
}

/**
 * v1 → v2 迁移：保留 record_id / occurred_at / source 等既有标识与时间含义，
 * 议案内容包装为空会话骨架，治理参数由秘书处补录后生效。
 */
export function migrateV1(record) {
  if (!record || record.schema_version !== 1) {
    throw new Error('仅支持迁移 v1 记录');
  }
  return createSession({
    record_id: record.record_id,
    occurred_at: record.occurred_at,
    source: record.source,
    meeting: {
      meeting_id: `meeting-${record.record_id}`,
      title: '',
      convened_at: record.occurred_at,
    },
  });
}

/** 追加审计轨迹；seq 由日志长度决定，保证同一操作序列重放结果一致。 */
export function audit(session, at, kind, detail = {}) {
  session.audit.push({ seq: session.audit.length + 1, at, kind, detail });
}

/** 确定性序列化：对象键排序、数组保持顺序，同一值必得同一字符串。 */
export function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 内容摘要：sha256(确定性序列化)，用于材料摘要、结论摘要与密封承诺。 */
export function digest(value) {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

/**
 * 密封意见承诺：对（议案、章节、章节版本、授权、序列、选择、条件、盐）求摘要。
 * 开票前只能凭承诺确认是否收到，内容不可见；开票时须原样揭示。
 */
export function sealBallot({ motion_id, section_id, section_revision, authorization_id, seq, choice, conditions = [], salt }) {
  return digest({ motion_id, section_id, section_revision, authorization_id, seq, choice, conditions, salt });
}

// ---- 时间比较：全部使用带时区的 ISO 8601 字符串，与既有 occurred_at 语义一致 ----

export const atOrBefore = (a, b) => Date.parse(a) <= Date.parse(b);
export const atBefore = (a, b) => Date.parse(a) < Date.parse(b);
