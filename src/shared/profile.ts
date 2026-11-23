// A person's information card. It describes the person, not an address: the signature says how a
// message from one address closes, the card tells the AI who it is writing for.

export const TONES = ['neutral', 'friendly', 'formal', 'direct'] as const;
export type Tone = (typeof TONES)[number];

export interface ProfileFields {
  name: string;
  title: string;
  company: string;
  phone: string;
  location: string;
  /** Languages the person writes in, as they typed them: "English, Bangla, German". */
  languages: string;
  tone: Tone;
  /** Free text: what they do, who they usually write to, how they like to sound. */
  about: string;
}

export const EMPTY_PROFILE: ProfileFields = { name: '', title: '', company: '', phone: '', location: '', languages: '', tone: 'neutral', about: '' };

const line = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').trim().slice(0, max) : '');

export function parseProfile(input: unknown): ProfileFields {
  const v = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return {
    name: line(v.name, 80), title: line(v.title, 80), company: line(v.company, 80), phone: line(v.phone, 40), location: line(v.location, 80),
    languages: line(v.languages, 120), tone: (TONES as readonly string[]).includes(String(v.tone)) ? (v.tone as Tone) : 'neutral',
    about: typeof v.about === 'string' ? v.about.replace(/\r/g, '').trim().slice(0, 800) : '',
  };
}

const TONE_TEXT: Record<Tone, string> = {
  neutral: '',
  friendly: 'warm and friendly',
  formal: 'formal and polite',
  direct: 'short and direct',
};

/** Exactly what the AI is told about the person. Empty when the card is empty. Shown to the person as it is. */
export function profileForAi(f: ProfileFields): string {
  const rows = [
    f.name && `Name: ${f.name}`,
    (f.title || f.company) && `Role: ${[f.title, f.company].filter(Boolean).join(' at ')}`,
    f.phone && `Phone: ${f.phone}`,
    f.location && `Location: ${f.location}`,
    f.languages && `Writes in: ${f.languages}`,
    TONE_TEXT[f.tone] && `Preferred tone: ${TONE_TEXT[f.tone]}`,
    f.about && `About them: ${f.about}`,
  ].filter(Boolean);
  return rows.join('\n');
}
