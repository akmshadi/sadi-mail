// Small text-level helpers for wrangler.jsonc. The file has comments, so it is never
// JSON.parse'd and never rewritten from an object: every edit changes only the characters
// it has to, and all comments and spacing stay as they were.

// Returns a copy of `text` of the same length with comments blanked out. With
// `maskStrings`, the contents of string literals are blanked too, so braces and
// keys inside strings cannot be mistaken for structure.
export function blank(text, { maskStrings = false } = {}) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && n === '*') {
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { out += text[i] === '\n' ? '\n' : ' '; i++; }
      if (i < text.length) { out += '  '; i += 2; }
    } else if (c === '"') {
      out += '"'; i++;
      while (i < text.length && text[i] !== '"') {
        const esc = text[i] === '\\';
        out += maskStrings ? '_' : text[i];
        i++;
        if (esc && i < text.length) { out += maskStrings ? '_' : text[i]; i++; }
      }
      if (i < text.length) { out += '"'; i++; }
    } else { out += c; i++; }
  }
  return out;
}

// Index range [open, close] of the `{ ... }` block that follows `"name":`.
function blockRange(text, name) {
  const visible = blank(text);
  const m = new RegExp(`"${name}"\\s*:\\s*\\{`).exec(visible);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const structure = blank(text, { maskStrings: true });
  let depth = 0;
  for (let i = open; i < structure.length; i++) {
    if (structure[i] === '{') depth++;
    else if (structure[i] === '}' && --depth === 0) return [open, i];
  }
  return null;
}

const STRING = '"(?:[^"\\\\]|\\\\.)*"';

export function getVar(text, key) {
  const r = blockRange(text, 'vars');
  if (!r) return undefined;
  const m = new RegExp(`"${key}"\\s*:\\s*(${STRING})`).exec(blank(text).slice(r[0], r[1]));
  return m ? JSON.parse(m[1]) : undefined;
}

// Set a string value inside "vars", replacing it in place or appending a new entry.
export function setVar(text, key, value) {
  const r = blockRange(text, 'vars');
  if (!r) throw new Error('wrangler.jsonc has no "vars" block');
  const visible = blank(text);
  const re = new RegExp(`("${key}"\\s*:\\s*)${STRING}`);
  const m = re.exec(visible.slice(r[0], r[1]));
  const json = JSON.stringify(value);
  if (m) {
    const start = r[0] + m.index + m[1].length;
    return text.slice(0, start) + json + text.slice(start + m[0].length - m[1].length);
  }
  let last = r[1] - 1;
  while (last > r[0] && /\s/.test(visible[last])) last--;
  const comma = visible[last] === '{' || visible[last] === ',' ? '' : ',';
  return text.slice(0, last + 1) + `${comma}\n    ${JSON.stringify(key)}: ${json}` + text.slice(last + 1);
}

export function getDatabaseId(text) {
  const m = new RegExp(`"database_id"\\s*:\\s*(${STRING})`).exec(blank(text));
  return m ? JSON.parse(m[1]) : undefined;
}

export function setDatabaseId(text, id) {
  const m = new RegExp(`("database_id"\\s*:\\s*)${STRING}`).exec(blank(text));
  if (!m) throw new Error('wrangler.jsonc has no "database_id" to update');
  const start = m.index + m[1].length;
  return text.slice(0, start) + JSON.stringify(id) + text.slice(m.index + m[0].length);
}

// True when a top-level binding such as "ai" is present and not commented out.
export function hasBinding(text, key) {
  return new RegExp(`"${key}"\\s*:\\s*\\{`).test(blank(text));
}

export const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';
