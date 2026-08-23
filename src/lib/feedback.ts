// ---------------------------------------------------------------------------
// Odd Saint — customer support / feedback submission
//
// HONEST SCOPE NOTE: a real spam/abuse classifier needs a model behind an
// API key, which this free-tier app doesn't run. What's implemented here is
// a lightweight pre-filter that catches obviously-junk submissions (too
// short, link-spam, repeated-character spam) before they ever reach the
// admin review queue. It is NOT a substitute for actual moderation — every
// submission that passes the pre-filter still lands as `status: 'pending'`
// and stays invisible to everyone except its author and admins until an
// admin explicitly approves it (see supabase/migrations/002_batch_updates.sql).
// ---------------------------------------------------------------------------
import { supabase } from './supabaseClient';

export type FeedbackCategory = 'usability' | 'performance' | 'bug' | 'support_request' | 'general';

const MIN_LENGTH = 8;
const MAX_LENGTH = 2000;
const LINK_SPAM_PATTERN = /(https?:\/\/[^\s]+){2,}/i; // 2+ links in one message = likely spam
const REPEAT_CHAR_PATTERN = /(.)\1{7,}/; // e.g. "aaaaaaaa" or "!!!!!!!!"

export function prefilterFeedback(message: string): { ok: boolean; reason?: string } {
  const trimmed = message.trim();
  if (trimmed.length < MIN_LENGTH) {
    return { ok: false, reason: 'Please tell us a bit more — message is too short.' };
  }
  if (trimmed.length > MAX_LENGTH) {
    return { ok: false, reason: `Please keep your message under ${MAX_LENGTH} characters.` };
  }
  if (LINK_SPAM_PATTERN.test(trimmed)) {
    return { ok: false, reason: 'Please remove links from your message.' };
  }
  if (REPEAT_CHAR_PATTERN.test(trimmed)) {
    return { ok: false, reason: 'That message looks like spam — please rephrase.' };
  }
  return { ok: true };
}

export async function submitFeedback(params: {
  userId: string | null;
  email: string | null;
  category: FeedbackCategory;
  message: string;
}): Promise<{ success: boolean; error?: string }> {
  const check = prefilterFeedback(params.message);
  if (!check.ok) return { success: false, error: check.reason };

  const { error } = await supabase.from('feedback').insert({
    user_id: params.userId,
    email: params.email,
    category: params.category,
    message: params.message.trim(),
    status: 'pending',
  });

  if (error) return { success: false, error: error.message };
  return { success: true };
}
