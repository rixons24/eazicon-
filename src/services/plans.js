// Plan definitions and enforcement. Every paid call goes through checkAndTick()
// which increments usage BEFORE any LLM/translation/STT/TTS spend happens.

const PLAN_LIMITS = {
  free:     { messagesPerMonth: 150,      voice: false, languages: 1,       llmModel: 'llama-3.1-8b-instant' },
  standard: { messagesPerMonth: Infinity, voice: false, languages: Infinity, llmModel: null },
  premium:  { messagesPerMonth: Infinity, voice: true,  languages: Infinity, llmModel: null },
  trial:    { messagesPerMonth: Infinity, voice: true,  languages: Infinity, llmModel: null, trialDays: 7 },
};

function getPlan(hotel) {
  return PLAN_LIMITS[hotel.plan] || PLAN_LIMITS.free;
}

// Returns { allowed: bool, reason?: string }.
// Does NOT mutate state — call tickUsage() separately after a successful send.
function checkLimit(hotel) {
  const plan = getPlan(hotel);
  if (hotel.plan === 'trial' && hotel.trial_started_at) {
    const days = (Date.now() - new Date(hotel.trial_started_at).getTime()) / 86400000;
    if (days > plan.trialDays) return { allowed: false, reason: 'trial_expired' };
  }
  if (hotel.usage_messages_month >= plan.messagesPerMonth) {
    return { allowed: false, reason: 'monthly_limit' };
  }
  return { allowed: true };
}

// Increment usage counter and roll over the month if we've crossed into a new one.
// Called after a message is successfully processed, not before.
async function tickUsage(query, hotelId) {
  await query(
    `UPDATE hotels
     SET usage_messages_month = CASE
       WHEN DATE_TRUNC('month', usage_reset_at) < DATE_TRUNC('month', NOW())
         THEN 1
       ELSE usage_messages_month + 1
     END,
     usage_reset_at = CASE
       WHEN DATE_TRUNC('month', usage_reset_at) < DATE_TRUNC('month', NOW())
         THEN NOW()
       ELSE usage_reset_at
     END
     WHERE id = $1`,
    [hotelId]
  );
}

module.exports = { PLAN_LIMITS, getPlan, checkLimit, tickUsage };
