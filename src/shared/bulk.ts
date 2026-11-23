// Bulk sending: reading a pasted list of people, and filling each person's details into the message.

export interface BulkPerson { name: string; email: string }
export const BULK_MAX = 1000;
export const BULK_RATES = [5, 10, 20] as const;

const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/** One person per line: an address, "Name <address>", "address, Name" or "Name, address". Repeats are dropped. */
export function parseRecipients(input: string): { people: BulkPerson[]; invalid: string[]; duplicates: number } {
  const people: BulkPerson[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const raw of input.split(/[\r\n;]+/)) {
    const line = raw.trim();
    if (!line) continue;
    let name = '';
    let email = '';
    const angled = /^(.*?)<([^>]+)>\s*$/.exec(line);
    if (angled) { name = angled[1]!.trim().replace(/^["']|["']$/g, ''); email = angled[2]!.trim(); }
    else {
      const parts = line.split(/[,\t]/).map((p) => p.trim()).filter(Boolean);
      const at = parts.findIndex((p) => EMAIL.test(p));
      if (at >= 0) { email = parts[at]!; name = parts.filter((_, i) => i !== at).join(' ').replace(/^["']|["']$/g, ''); }
      else email = line;
    }
    email = email.toLowerCase();
    if (!EMAIL.test(email)) { invalid.push(line.slice(0, 80)); continue; }
    if (seen.has(email)) { duplicates++; continue; }
    seen.add(email);
    people.push({ name: name.slice(0, 80), email });
  }
  return { people, invalid, duplicates };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Replace {{name}}, {{first_name}} and {{email}}. A missing name falls back to "there", so "Hi {{first_name}}" still reads well. */
export function personalise(template: string, person: BulkPerson, html = false): string {
  const name = person.name || 'there';
  const values: Record<string, string> = { name, first_name: name.split(/\s+/)[0] ?? name, email: person.email };
  return template.replace(/\{\{\s*(name|first_name|email)\s*\}\}/gi, (_, key: string) => { const v = values[key.toLowerCase()]!; return html ? esc(v) : v; });
}
