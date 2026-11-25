// « Occupé » and « Rappel » are actions, not statuses (the owner's rule, 25 Nov 2026 evening): an order still to call
// shows only its try, « Tentative 0N », and its line says what happens next (« Rappel 18:00 », « Occupé »). New calls
// work that way (orders.ts › setConf). The orders already in « Occupé » or « À rappeler » become « Tentative » here,
// once: the try they had (at least « Tentative 01 »), and an « À rappeler » keeps its time as its next call. Nothing
// else of an order changes; its history stays as it was written.
export default `
UPDATE orders SET conf_status = 'no_answer', attempts = GREATEST(attempts, 1), next_call_at = NULL,
       updated_at = now(), version = version + 1
 WHERE conf_status = 'busy';
UPDATE orders SET conf_status = 'no_answer', attempts = GREATEST(attempts, 1),
       updated_at = now(), version = version + 1
 WHERE conf_status = 'callback';
`;
