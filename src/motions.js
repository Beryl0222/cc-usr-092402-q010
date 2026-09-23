import { audit, digest } from './contracts.js';

/**
 * 议案按章节管理，修订只增不改：
 * - 每次修订记录 revision、受影响章节 changed_sections、理由与材料刷新清单；
 * - 章节内容以 content_digest 固定，旧章节版本保留（superseded_at 标记，不删除）；
 * - 表决批准只对“纳入本次计票的章节”生效；
 * - 修订后，仅自上次签署以来被改动过的章节需要重新签署（重签）；
 * - 少数意见独立追加，挂在其提出时的议案/章节/修订上，任何修订都不能覆盖或隐藏。
 */

export function createMotion(session, { motion_id, title, sections, introduced_at, sponsor_id }) {
  if (session.motions.some((m) => m.motion_id === motion_id)) {
    throw new Error(`议案已存在: ${motion_id}`);
  }
  const motion = {
    motion_id,
    title,
    sponsor_id,
    introduced_at,
    current_revision: 1,
    sections: sections.map((s) => ({
      section_id: s.section_id,
      topic: s.topic,
      title: s.title ?? s.section_id,
      revision: 1,
      content_digest: s.content_digest ?? digest(s.content ?? ''),
      material_refs: [...(s.material_refs ?? [])],
      introduced_at,
      last_signoff: null, // { revision, decision_id, at }
    })),
    revisions: [
      { revision: 1, at: introduced_at, changed_sections: sections.map((s) => s.section_id), rationale: '议案提出', editor_id: sponsor_id, materials_refreshed: {} },
    ],
  };
  session.motions.push(motion);
  audit(session, introduced_at, 'motion_created', { motion_id, sections: motion.sections.map((s) => s.section_id) });
  return motion;
}

export function getMotion(session, motionId) {
  const motion = session.motions.find((m) => m.motion_id === motionId);
  if (!motion) throw new Error(`议案不存在: ${motionId}`);
  return motion;
}

/**
 * 修订议案：旧章节内容快照进 section_history，新内容成为当前版本；
 * 未列入 changed_sections 的章节版本号与签署状态均不变。
 */
export function reviseMotion(session, motionId, { at, changed_sections, rationale, editor_id, section_updates = [], materials_refreshed = {} }) {
  const motion = getMotion(session, motionId);
  if (at <= motion.revisions[motion.revisions.length - 1].at) {
    throw new Error('议案修订时间必须晚于上一修订');
  }
  const next = motion.current_revision + 1;
  const updates = new Map(section_updates.map((u) => [u.section_id, u]));
  for (const sectionId of changed_sections) {
    const section = motion.sections.find((s) => s.section_id === sectionId);
    if (!section) throw new Error(`修订引用了不存在的章节: ${sectionId}`);
    const u = updates.get(sectionId) ?? {};
    motion.sections[motion.sections.indexOf(section)] = {
      ...section,
      topic: u.topic ?? section.topic,
      title: u.title ?? section.title,
      revision: next,
      content_digest: u.content_digest ?? (u.content !== undefined ? digest(u.content) : section.content_digest),
      material_refs: u.material_refs ? [...u.material_refs] : section.material_refs,
      introduced_at: at,
      // last_signoff 保留：它是“该章节在哪个修订被签署过”的历史事实；
      // 是否需要重签由 needsSignoff 按当前版本号判定。
    };
  }
  motion.revisions.push({
    revision: next,
    at,
    changed_sections: [...changed_sections],
    rationale,
    editor_id,
    materials_refreshed: { ...materials_refreshed },
  });
  motion.current_revision = next;
  audit(session, at, 'motion_revised', { motion_id: motion.motion_id, revision: next, changed_sections });
  return motion;
}

/** 章节在指定修订时的版本号（该修订及之前最后一次改动它的修订；未被改动则为 1）。 */
export function sectionRevisionAt(motion, sectionId, revision = motion.current_revision) {
  let r = 1;
  for (const rev of motion.revisions) {
    if (rev.revision > revision) break;
    if (rev.revision > 1 && rev.changed_sections.includes(sectionId)) r = rev.revision;
  }
  return r;
}

/** 该章节当前版本是否尚未获得批准签署。 */
export function needsSignoff(motion, sectionId) {
  const section = motion.sections.find((s) => s.section_id === sectionId);
  return !section.last_signoff || section.last_signoff.revision < section.revision;
}

/** 截至指定修订，需要重新签署的章节（自上次签署后被改动；从未签署且仍存在的章节同样列入）。 */
export function sectionsNeedingSignoff(motion, revision = motion.current_revision) {
  return motion.sections
    .filter((s) => {
      const r = sectionRevisionAt(motion, s.section_id, revision);
      return !s.last_signoff || s.last_signoff.revision < r;
    })
    .map((s) => s.section_id)
    .sort();
}

/** 宣布批准后，由计票模块回调：仅签署本次纳入且通过的章节，保留其当时版本号。 */
export function recordSignoffs(motion, sectionIds, { decision_id, at, revision }) {
  for (const sectionId of sectionIds) {
    const section = motion.sections.find((s) => s.section_id === sectionId);
    if (!section) continue;
    section.last_signoff = { revision: sectionRevisionAt(motion, sectionId, revision), decision_id, at };
  }
}

/**
 * 追加少数意见。没有修改或删除接口——
 * 已形成的少数意见是永久记录，议案修订与后续表决都不得覆盖。
 */
export function appendMinorityOpinion(session, { opinion_id, motion_id, section_id = null, ballot_id = null, author_holder_id, revision, at, text, text_digest = null }) {
  if (session.minority_opinions.some((o) => o.opinion_id === opinion_id)) {
    throw new Error(`少数意见已存在: ${opinion_id}`);
  }
  getMotion(session, motion_id);
  const entry = {
    opinion_id,
    motion_id,
    section_id,
    ballot_id,
    author_holder_id,
    revision,
    at,
    text_digest: text_digest ?? digest(text ?? ''),
    text: text ?? null,
  };
  session.minority_opinions.push(entry);
  audit(session, at, 'minority_opinion_filed', { opinion_id, motion_id, section_id, revision });
  return entry;
}

export function listMinorityOpinions(session, { motion_id = null, section_id = null } = {}) {
  return session.minority_opinions
    .filter((o) => (!motion_id || o.motion_id === motion_id) && (section_id === null || o.section_id === section_id))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.opinion_id.localeCompare(b.opinion_id));
}
