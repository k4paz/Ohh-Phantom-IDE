import { esc } from './dom.js';

export function renderMarkdown(markdown, { allowImages = false } = {}) {
  const source = String(markdown ?? '');
  if (window.marked && window.DOMPurify) {
    const html = window.marked.parse(source, { gfm: true, breaks: false });
    return window.DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'form', 'input', 'iframe', ...(allowImages ? [] : ['img'])],
      FORBID_ATTR: ['style']
    });
  }
  const lines = esc(source).split('\n');
  let out = '';
  let code = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      out += code ? '</code></pre>' : '<pre><code>';
      code = !code;
    } else if (code) out += `${line}\n`;
    else {
      const heading = /^(#{1,6})\s+(.*)/.exec(line);
      if (heading) out += `<h${heading[1].length}>${heading[2]}</h${heading[1].length}>`;
      else if (/^\s*[-*]\s+/.test(line)) out += `<li>${line.replace(/^\s*[-*]\s+/, '')}</li>`;
      else if (!line.trim()) out += '<br>';
      else out += `<p>${line.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*]+)\*/g, '<i>$1</i>')}</p>`;
    }
  }
  return out;
}
