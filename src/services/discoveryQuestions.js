// Proactive discovery questions. A NEW guest conversation gets one question
// appended to the first reply (unless that first message was urgent or a
// human-handoff request, where bolting on an unrelated question would feel
// tone-deaf). Not asked again after that — one question per guest, not an
// interrogation.
//
// v1 deliberately doesn't try to parse the guest's answer out of free text —
// it's asked and answered right there in the conversation thread, which
// staff already see via "View full conversation". That's enough to prevent
// the reactive case (a guest mentioning an allergy only after food was
// already served) without building a full structured-intake flow.

const { query } = require('../db/pool');

async function maybeAppendQuestion({ hotelId, conversationId, tier }) {
  if (tier === 'urgent' || tier === 'human_requested') return null;

  const { rows: convRows } = await query(
    'SELECT discovery_question_asked FROM conversations WHERE id = $1',
    [conversationId]
  );
  if (!convRows[0] || convRows[0].discovery_question_asked) return null;

  const { rows } = await query(
    'SELECT question FROM discovery_questions WHERE hotel_id = $1 AND active = true ORDER BY sort_order ASC LIMIT 1',
    [hotelId]
  );
  if (!rows.length) return null;

  await query('UPDATE conversations SET discovery_question_asked = true WHERE id = $1', [conversationId]);
  return rows[0].question; // English text — caller translates if needed
}

module.exports = { maybeAppendQuestion };
