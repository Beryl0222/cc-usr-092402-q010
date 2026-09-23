import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';

/**
 * 联合药研议事治理 —— 可审计会议与表决数据合同
 *
 * 全部治理对象（成员资格、授权代表、议题范围、回避关系、材料版本、
 * 评议窗口、法定人数规则、表决门槛）都是“带生效区间的事实”：
 * 同一条目不可变，变更 = 关闭旧区间 + 追加新区间，任何时点都可还原
 * 当时有效的规则与成员集合。
 */

export const SCHEMA_VERSION = 2;
export const SUPPORTED_VERSIONS = Object.freeze([1, 2]);

/** 读入并校验记录；v1 样例自动迁移为 v2，不改变既有标识与时间含义。 */
export async function loadRecord(path) {
  const payload = JSON.parse(await readFile(path, 'utf8'));
  if (!Number.isInteger(payload.schema_version) || !payload.record_id) {
    throw new Error('数据合同缺少必要标识');
  }
  if (!SUPPORTED_VERSIONS.includes(payload.schema_version)) {
    throw new Error(`不支持的数据合同版本: ${payload.schema_version}`);
  }
  const record = payload.schema_version === 1 ? migrateV1(payload) : payload;
  validateRecord(record);
  return Object.freeze(record);
}

/**
 * v1 → v2：v1 只有标识与时间，没有任何治理事实；迁移后这些字段原样保留
 * （record_id / domain / occurred_at / revision / source），议事数据为空，
 * 由秘书处按发生时间补录。revision 含义不变（议案自身修订号）。
 */
export function migrateV1(v1) {
  return {
    schema_version: 2,
    record_id: v1.record_id,
    domain: v1.domain ?? 'drug_council',
    occurred_at: v1.occurred_at,
    revision: v1.revision ?? 1,
    source: v1.source,
    migrated_from: 1,
    council: {
      committee_id: v1.record_id,
      name: v1.domain === 'drug_council' ? '联合药研委员会' : v1.domain,
      timeline: [],
      members: [],
      delegations: [],
      topic_scopes: [],
      recusals: [],
      materials: [],
      review_windows: [],
      quorum_rules: [],
      threshold_rules: [],
      motions: [],
      votes: [],
      announcements: [],
      corrections: [],
      escalations: [],
      emergency_actions: [],
      emergency_ratifications: [],
      notifications: [],
    },
  };
}

function requireObject(value, name, errors) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${name} 必须是对象`);
    return false;
  }
  return true;
}

function checkInterval(entry, errors, where) {
  if (typeof entry.effective_from !== 'string') errors.push(`${where} 缺少 effective_from`);
  if (
    entry.effective_to !== null &&
    entry.effective_to !== undefined &&
    typeof entry.effective_to !== 'string'
  ) {
    errors.push(`${where} 的 effective_to 只能是时间戳或 null`);
  }
  if (
    typeof entry.effective_from === 'string' &&
    typeof entry.effective_to === 'string' &&
    entry.effective_to < entry.effective_from
  ) {
    errors.push(`${where} 的生效区间倒置（effective_to 早于 effective_from）`);
  }
}

/** 结构校验：只验合同形状与基本不变量，业务判定在 engine.js。 */
export function validateRecord(record) {
  const errors = [];
  if (record.schema_version !== 2) errors.push('schema_version 必须为 2');
  if (!record.record_id) errors.push('缺少 record_id');
  const c = record.council;
  if (!requireObject(c, 'council', errors)) {
    throw new Error(`数据合同校验失败:\n- ${errors.join('\n- ')}`);
  }
  for (const key of [
    'timeline', 'members', 'delegations', 'topic_scopes', 'recusals',
    'materials', 'review_windows', 'quorum_rules', 'threshold_rules',
    'motions', 'votes', 'announcements', 'corrections',
    'escalations', 'emergency_actions', 'emergency_ratifications', 'notifications',
  ]) {
    if (!Array.isArray(c[key])) errors.push(`council.${key} 必须是数组`);
  }
  for (const m of c.members ?? []) checkInterval(m, errors, `成员 ${m.member_id ?? '?'}`);
  for (const d of c.delegations ?? []) checkInterval(d, errors, `授权 ${d.delegation_id ?? '?'}`);
  for (const r of c.recusals ?? []) checkInterval(r, errors, `回避 ${r.recusal_id ?? '?'}`);
  for (const q of c.quorum_rules ?? []) checkInterval(q, errors, `法定人数规则 ${q.rule_id ?? '?'}`);
  for (const t of c.threshold_rules ?? []) checkInterval(t, errors, `表决门槛 ${t.rule_id ?? '?'}`);
  for (const w of c.review_windows ?? []) {
    if (typeof w.opens_at !== 'string' || typeof w.closes_at !== 'string') {
      errors.push(`评议窗口 ${w.window_id ?? '?'} 缺少 opens_at/closes_at`);
    } else if (w.closes_at < w.opens_at) {
      errors.push(`评议窗口 ${w.window_id ?? '?'} 关闭早于开启`);
    }
  }
  if (errors.length) throw new Error(`数据合同校验失败:\n- ${errors.join('\n- ')}`);
  return true;
}

/**
 * 规范化 JSON 序列化：键排序、无多余空白。计票与纪要复算必须逐字节一致，
 * 全项目所有内容哈希都以此为输入。
 */
export function canonicalJSON(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((k) => [k, sortDeep(value[k])]),
    );
  }
  return value;
}

export function digest(value) {
  return crypto.createHash('sha256').update(canonicalJSON(value)).digest('hex');
}
