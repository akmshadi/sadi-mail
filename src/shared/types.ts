// Shapes that cross the wire between the Worker API and any client (Sadi Mail's own, or a host app).

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export type Folder = 'inbox' | 'archive' | 'spam' | 'trash';
export type View = Folder | 'starred' | 'unread' | 'sent' | 'drafts' | 'scheduled' | 'snoozed';
export type AuthResult = 'pass' | 'fail' | 'none';
export type SendMode = 'dry-run' | 'cloudflare';

export interface BulkJobInfo {
  id: string;
  subject: string;
  fromEmail: string;
  by: string;
  total: number;
  /** How many people the job has worked through so far. */
  done: number;
  sent: number;
  failed: number;
  perMinute: number;
  status: 'running' | 'done' | 'cancelled';
  startAt: number;
  createdAt: number;
  finishedAt: number | null;
  lastError: string | null;
}

/** An account on a mail server outside Cloudflare. The password is never returned. */
export interface MailServerInfo {
  id: string;
  name: string;
  email: string;
  username: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: 'tls' | 'starttls' | 'none';
  imapHost: string;
  imapPort: number;
  imapSecurity: 'tls' | 'starttls' | 'none';
  sendEnabled: boolean;
  receiveEnabled: boolean;
  lastCheckedAt: number | null;
  lastReceivedAt: number | null;
  lastError: string | null;
  /** True once the inbox has been visited and Sadi Mail knows where new mail starts. */
  watching: boolean;
}

export interface Person {
  name: string;
  email: string;
}

export interface AddressInfo {
  id: string;
  mailboxId: string;
  email: string;
  displayName: string;
  signature: string;
  /** The same signature as HTML, used in rich-text mail. Empty when none is set. */
  signatureHtml: string;
  /** The fields the signature was built from, for editing it again. Null for an older plain signature. */
  signatureFields: import('./signature').SignatureFields | null;
  isDefault: boolean;
  discovered: boolean;
}

export interface MailboxInfo {
  id: string;
  name: string;
  color: string;
  /** The mailbox's saved company header and footer. */
  letterhead: import('./design').Letterhead;
  unread: number;
  addresses: AddressInfo[];
  /** What the signed-in person may do in this mailbox. */
  can: { send: boolean; edit: boolean; delete: boolean };
}

export interface Bootstrap {
  user: { id: string; name: string; role: Role; hasAvatar: boolean };
  mailboxes: MailboxInfo[];
  sendMode: SendMode;
  /** Addresses that really send through their own SMTP server, whatever the send mode says. */
  serverSenders: string[];
  ai: { connected: boolean };
  storage: { messages: number; bytes: number; lastReceivedAt: number | null };
}

export interface ThreadSummary {
  id: string;
  mailboxId: string;
  addressId: string;
  addressEmail: string;
  subject: string;
  folder: Folder;
  lastAt: number;
  fromName: string;
  fromEmail: string;
  snippet: string;
  messageCount: number;
  unread: boolean;
  starred: boolean;
  hasAttachment: boolean;
  flaggedAuth: boolean;
  needsReply: boolean;
  /** Set by the triage agent; false until it has read the conversation. */
  priority: boolean;
  category: string | null;
  /** You wrote last and nobody has answered. */
  followUp: boolean;
  labels: LabelInfo[];
  snoozedUntil: number | null;
  /** Who the latest message written here went to, at most three people. Empty when nothing was written here. */
  sentTo: Person[];
  /** Names of up to three attached files, and how many there are in all. */
  files: string[];
  fileCount: number;
  /** Which inbox section the conversation sits in. */
  section: InboxSection;
}

export interface AttachmentInfo {
  id: string;
  filename: string;
  mime: string;
  size: number;
  inline: boolean;
}

export interface MessageEvent {
  kind: string;
  detail: string;
  at: number;
  ms: number | null;
}

export interface MessageDetail {
  id: string;
  direction: 'in' | 'out';
  status: 'received' | 'draft' | 'scheduled' | 'sent' | 'dry_run' | 'failed';
  from: Person;
  to: Person[];
  cc: Person[];
  subject: string;
  at: number;
  scheduledFor: number | null;
  text: string;
  /** Cleaned HTML, safe to place in a sandboxed frame. Null when the message is text only. */
  html: string | null;
  hasRemoteImages: boolean;
  truncated: boolean;
  auth: { spf: AuthResult; dkim: AuthResult; dmarc: AuthResult };
  attachments: AttachmentInfo[];
  events: MessageEvent[];
  error: string | null;
}

export interface ThreadDetail extends ThreadSummary {
  messages: MessageDetail[];
  /** The address a reply should come from: the one this conversation arrived at. */
  replyFrom: string;
  earlier: { id: string; subject: string; at: number }[];
}

export interface SendRequest {
  fromAddressId: string;
  to: Person[];
  cc?: Person[];
  bcc?: Person[];
  subject: string;
  text: string;
  html?: string;
  /** Message being answered; sets the reply headers and keeps the thread together. */
  inReplyToMessageId?: string;
  /** Epoch ms. When set, the message waits in Scheduled until then. */
  scheduledFor?: number;
  /** Hold the message this many seconds so it can be taken back. */
  undoSeconds?: number;
  /** The saved draft being sent. Its attachments go with the message and the draft is removed. */
  draftId?: string;
  /** For a host application: the From address by its email, instead of `fromAddressId`. */
  fromEmail?: string;
  /** Where replies should go, when not the From address. */
  replyTo?: string;
  /** Extra headers. Only List-Unsubscribe, List-Unsubscribe-Post and X-* names are accepted. */
  headers?: Record<string, string>;
  /** Files sent with the message, base64. At most 10 files and 10 MB together. */
  attachments?: { filename: string; mime?: string; contentBase64: string }[];
  /** A caller's own key for this message. Sending the same key again returns the first result and sends nothing. */
  idempotencyKey?: string;
}

export interface SendResult {
  messageId: string;
  threadId: string;
  status: MessageDetail['status'];
  /** True when nothing left this server (dry-run mode). */
  dryRun: boolean;
}

export interface SystemStatus {
  receiving: { state: 'working' | 'untested'; lastReceivedAt: number | null };
  storage: { state: 'working'; messages: number; bytes: number };
  sending: { state: 'dry-run' | 'configured-untested' | 'working'; mode: SendMode };
  ai: { state: 'not-connected' | 'connected'; providers: { name: string; kind: string; model: string }[] };
  domains: { name: string; mailbox: string; addresses: number; catchAll: boolean }[];
  recent: { at: number; direction: 'in' | 'out'; from: string; to: string; status: string; ms: number | null }[];
}

export interface ApiError {
  error: string;
  message: string;
}

export interface Brief {
  summary: string;
  actions: { text: string; due: string }[];
  replies: string[];
  provider: string;
  model: string;
  at: number;
  /** A newer message has arrived since this was written. */
  stale: boolean;
}

export interface AgentNote {
  id: string;
  agent: string;
  kind: string;
  at: number;
  status: 'ok' | 'failed' | 'skipped';
  output: string | null;
  error: string | null;
}

export interface ThreadAi {
  brief: Brief | null;
  notes: AgentNote[];
  /** Agents a person can run on this conversation by hand. */
  agents: { id: string; name: string }[];
}

export type ProviderKind = 'workers-ai' | 'anthropic' | 'openai' | 'openai-compatible';

export interface ProviderInfo {
  id: string;
  kind: ProviderKind;
  name: string;
  model: string;
  baseUrl: string | null;
  keyLast4: string | null;
  priority: number;
  enabled: boolean;
  /** Ready to answer: the binding is on, or a key is stored. */
  usable: boolean;
}

export interface AgentInfo {
  id: string;
  name: string;
  kind: string;
  instructions: string;
  trigger: 'manual' | 'on-receive' | 'schedule';
  mailboxId: string | null;
  enabled: boolean;
  builtin: string | null;
  followUpDays: number;
  usesAi: boolean;
}

export interface AiOverview {
  providers: ProviderInfo[];
  agents: AgentInfo[];
  workersAiBinding: boolean;
  canStoreKeys: boolean;
  callsToday: number;
  dailyLimit: number;
  defaults: Record<ProviderKind, string>;
  runs: { id: string; at: number; kind: string; agent: string | null; status: string; provider: string | null; model: string | null; ms: number | null; tokensIn: number | null; tokensOut: number | null; error: string | null }[];
}

/** Extra limits on a message list. Times are milliseconds; null means no limit. */
export interface ListFilters {
  after: number | null;
  before: number | null;
  from: string;
  files: boolean;
}

export type InboxSection = 'primary' | 'social' | 'promotions' | 'updates' | 'forums';

export interface LabelInfo {
  id: string;
  name: string;
  color: string;
}

export interface DraftInput {
  id?: string;
  fromAddressId: string;
  to: Person[];
  cc: Person[];
  bcc: Person[];
  subject: string;
  text: string;
  html?: string;
  /** JSON of an Email Design Builder design (see src/shared/design.ts). Absent for a written message. */
  design?: string;
  inReplyToMessageId?: string;
  mode: 'new' | 'reply' | 'replyAll' | 'forward';
}

export interface DraftDetail extends DraftInput {
  id: string;
  threadId: string;
  savedAt: number;
  attachments: AttachmentInfo[];
}

export interface TemplateInfo {
  id: string;
  name: string;
  subject: string;
  body: string;
  /** JSON of an Email Design Builder design. A designed template's body is its plain-text version. */
  design?: string;
}

export interface RuleInfo {
  id: string;
  name: string;
  mailboxId: string | null;
  enabled: boolean;
  match: { from?: string; to?: string; subject?: string; body?: string; hasAttachment?: boolean };
  action: { labelId?: string; star?: boolean; markRead?: boolean; moveTo?: 'archive' | 'spam' | 'trash' };
}

export interface UserInfo {
  id: string;
  name: string;
  role: Role;
  status: 'active' | 'disabled';
  createdAt: number;
  grants: { mailboxId: string; read: boolean; send: boolean; edit: boolean; delete: boolean }[];
}
