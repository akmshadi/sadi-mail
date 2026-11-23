// Which inbox section a new conversation belongs in. Decided from the message's own headers and
// sender, with no AI call, so it costs nothing and works the moment mail arrives.

export const SECTIONS = ['primary', 'social', 'promotions', 'updates', 'forums'] as const;
export type Section = (typeof SECTIONS)[number];

const SOCIAL = /(^|\.)(facebookmail\.com|facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|tiktok\.com|youtube\.com|pinterest\.com|snapchat\.com|reddit\.com|redditmail\.com|discord\.com|whatsapp\.com|telegram\.org|threads\.net|medium\.com|quora\.com|tumblr\.com|mastodon\.social|bsky\.app|nextdoor\.com|meetup\.com|strava\.com)$/i;
const FORUM_HOST = /(^|\.)(googlegroups\.com|groups\.io|discoursemail\.com|freelists\.org|lists\.[a-z0-9.-]+|listserv\.[a-z0-9.-]+)$/i;
const PROMO_LOCAL = /^(news|newsletter|newsletters|marketing|promo|promos|promotions|offers|offer|deals|sales|sale|shop|store|hello|hi|team|info|digest|weekly|updates-marketing)([+._-]|$)/i;
const PROMO_SUBJECT = /(\b\d{1,2}\s?% off\b|\bsale\b|\bdeal(s)?\b|\bdiscount\b|\bcoupon\b|\bpromo code\b|\bfree shipping\b|\blimited time\b|\blast chance\b|\bblack friday\b|\bcyber monday\b|\bsave (up to|\$|€|£|৳)|\bnew arrivals\b|\bexclusive offer\b|\bissue\s?#?\d+\b|\bnewsletter\b|\bwebinar\b)/i;
const UPDATE_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|notification|notifications|notify|alerts?|security|account|accounts|billing|invoice|invoices|receipt|receipts|orders?|shipping|shipment|delivery|support|service|system|admin|mailer-daemon|postmaster|verify|verification|confirm|confirmation|payments?|statements?|bounce|bounces|auto|automated)([+._-]|$)/i;
const UPDATE_SUBJECT = /(\breceipt\b|\binvoice\b|\border (confirmation|#|no|number)|\byour order\b|\bshipped\b|\bout for delivery\b|\bdelivered\b|\btracking\b|\bpayment (received|confirmation|failed|due)|\bstatement\b|\bpassword\b|\bverification code\b|\bverify your\b|\bconfirm your\b|\bsecurity alert\b|\bsign-?in\b|\bnew login\b|\bone-?time (code|password)\b|\botp\b|\bbooking\b|\breservation\b|\bticket\b|\brenewal\b|\bsubscription\b|\breminder\b)/i;

export interface SectionInput {
  fromEmail: string;
  subject: string;
  /** Returns a header value by lower-case name, or null. */
  header: (name: string) => string | null;
}

export function sectionOf(m: SectionInput): Section {
  const at = m.fromEmail.lastIndexOf('@');
  const local = at > 0 ? m.fromEmail.slice(0, at) : m.fromEmail;
  const host = at > 0 ? m.fromEmail.slice(at + 1) : '';
  const listId = m.header('list-id');
  const unsubscribe = m.header('list-unsubscribe');
  const precedence = (m.header('precedence') ?? '').toLowerCase();
  const auto = /^(auto-generated|auto-replied)/i.test(m.header('auto-submitted') ?? '');

  if (SOCIAL.test(host)) return 'social';
  // Receipts, codes and alerts come first: a shop's order confirmation carries an unsubscribe link too.
  if (UPDATE_SUBJECT.test(m.subject) && (UPDATE_LOCAL.test(local) || unsubscribe || auto || precedence === 'bulk')) return 'updates';
  // A discussion list: it has a List-Id and people post to it (List-Post), or it lives on a list host.
  if (FORUM_HOST.test(host) || (listId && m.header('list-post') && !PROMO_SUBJECT.test(m.subject))) return 'forums';
  if (unsubscribe || precedence === 'bulk' || precedence === 'list') {
    if (PROMO_SUBJECT.test(m.subject) || PROMO_LOCAL.test(local) || listId) return 'promotions';
    return UPDATE_LOCAL.test(local) ? 'updates' : 'promotions';
  }
  if (auto || UPDATE_LOCAL.test(local)) return 'updates';
  return 'primary';
}

export const isSection = (v: unknown): v is Section => typeof v === 'string' && (SECTIONS as readonly string[]).includes(v);
