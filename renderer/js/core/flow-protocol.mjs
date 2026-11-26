export const FLOW_ACTION_TAG = 'PHANTOM_FLOW_ACTION';

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
