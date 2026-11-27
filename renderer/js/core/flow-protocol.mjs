export const FLOW_ACTION_TAG = 'PHANTOM_FLOW_ACTION';

function validId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(value);
}

export function validateRoadmapPlan(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new Error('The manager returned an invalid roadmap plan.');
  }
  if (!Array.isArray(action.goals) || !action.goals.length) {
    throw new Error('The manager must create at least one measurable roadmap goal.');
  }
  if (!Array.isArray(action.assignments) || !action.assignments.length) {
    throw new Error('The manager did not delegate any implementation work.');
  }
  const goalIds = new Set();
  const reservedWorkerIds = new Set(['task', 'orchestrator', 'compiler', 'result']);
  const goals = action.goals.map((goal) => {
    if (!goal || !validId(goal.id) || goalIds.has(goal.id)) {
      throw new Error('Roadmap goals need unique IDs containing only letters, numbers, dots, underscores, or hyphens.');
    }
    const title = typeof goal.title === 'string' ? goal.title.trim() : '';
    const acceptanceCriteria = Array.isArray(goal.acceptanceCriteria)
      ? goal.acceptanceCriteria.map((criterion) => typeof criterion === 'string' ? criterion.trim() : '')
      : [];
    if (!title || title.length > 160 || !acceptanceCriteria.length ||
        acceptanceCriteria.some((criterion) => !criterion || criterion.length > 500)) {
      throw new Error(`Roadmap goal "${goal.id}" needs a title and measurable acceptance criteria.`);
    }
    goalIds.add(goal.id);
    return { id: goal.id, title, acceptanceCriteria };
  });
  const workerIds = new Set();
  const assignments = action.assignments.map((assignment) => {
    if (!assignment || !validId(assignment.workerId) || reservedWorkerIds.has(assignment.workerId) ||
        /^reviewer-\d+$/.test(assignment.workerId) || workerIds.has(assignment.workerId)) {
      throw new Error('Every delegated workstream needs a unique valid workerId.');
    }
    const task = typeof assignment.task === 'string' ? assignment.task.trim() : '';
    if (!task || task.length > 5000) throw new Error(`The assignment for "${assignment.workerId}" is empty or too long.`);
    if (!Array.isArray(assignment.goalIds) || !assignment.goalIds.length ||
        assignment.goalIds.some((id) => !goalIds.has(id))) {
      throw new Error(`The assignment for "${assignment.workerId}" must reference one or more roadmap goals.`);
    }
    workerIds.add(assignment.workerId);
    const label = typeof assignment.label === 'string' ? assignment.label.trim() : '';
    const role = typeof assignment.role === 'string' ? assignment.role.trim() : '';
    const instructions = typeof assignment.instructions === 'string' ? assignment.instructions.trim() : '';
    if (label.length > 80 || role.length > 80 || instructions.length > 1000) {
      throw new Error(`The role details for "${assignment.workerId}" exceed their size limits.`);
    }
    return {
      workerId: assignment.workerId, task, goalIds: [...new Set(assignment.goalIds)],
      label, role, instructions
    };
  });
  const assignedGoalIds = new Set(assignments.flatMap((assignment) => assignment.goalIds));
  const unassignedGoals = goals.filter((goal) => !assignedGoalIds.has(goal.id));
  if (unassignedGoals.length) {
    throw new Error(`Every roadmap goal needs an owner; unassigned: ${unassignedGoals.map((goal) => goal.id).join(', ')}.`);
  }
  const summary = typeof action.summary === 'string' ? action.summary.trim().slice(0, 4000) : '';
  return { summary, goals, assignments };
}

export function validateGoalEvidence(evidence, goals) {
  if (!Array.isArray(evidence)) throw new Error('The manager did not provide completion evidence for each roadmap goal.');
  const byGoal = new Map();
  for (const item of evidence) {
    if (!item || typeof item.goalId !== 'string' || typeof item.evidence !== 'string' ||
        !item.evidence.trim() || item.evidence.length > 2000) continue;
    byGoal.set(item.goalId, item.evidence.trim());
  }
  const missing = goals.filter((goal) => !byGoal.has(goal.id));
  if (missing.length) {
    throw new Error(`Completion is blocked: missing evidence for ${missing.map((goal) => goal.title).join(', ')}.`);
  }
  return goals.map((goal) => ({ goalId: goal.id, evidence: byGoal.get(goal.id) }));
}

export function parseFlowAction(text) {
  const marker = new RegExp(`<${FLOW_ACTION_TAG}>\\s*([\\s\\S]*?)\\s*</${FLOW_ACTION_TAG}>`, 'i');
  const match = marker.exec(text);
  const candidates = match ? [match[1]] : [];
  for (const fence of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(fence[1]);
  candidates.push(text);
  for (const candidate of candidates) {
    let depth = 0;
    let start = -1;
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < candidate.length; index++) {
      const character = candidate[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === '{') {
        if (depth++ === 0) start = index;
      } else if (character === '}' && depth > 0 && --depth === 0) {
        const json = candidate.slice(start, index + 1);
        let action;
        try { action = JSON.parse(json); } catch { continue; }
        if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.action !== 'string') continue;
        const visibleText = match
          ? text.replace(match[0], '').trim()
          : text.replace(json, '').replace(/```(?:json)?|```/gi, '').trim();
        return { action, visibleText };
      }
    }
  }
  throw new Error(match
    ? 'The orchestrator returned malformed workflow action data.'
    : 'The orchestrator response did not include a valid workflow action.');
}
