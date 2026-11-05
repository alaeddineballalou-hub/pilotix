// What a call may carry is counted before its schema checks it (Zod 3 checks every item of a list before its length).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { dispatch, inputTooBig, INPUT_LIMITS, proc } from '../index';

test('normal inputs pass, whatever their shape', () => {
  assert.equal(inputTooBig({}), null);
  assert.equal(inputTooBig(undefined), null);
  assert.equal(inputTooBig({ ids: Array.from({ length: 5000 }, (_, i) => i), q: 'x', nested: { a: [{ b: [1, 2, 3] }] } }), null);
});

test('a list too long, an object with too many keys, too many values, too deep: refused at once', () => {
  assert.match(String(inputTooBig({ ids: new Array(INPUT_LIMITS.items + 1).fill(0) })), /Liste trop longue/);
  assert.match(String(inputTooBig(Object.fromEntries(Array.from({ length: INPUT_LIMITS.items + 1 }, (_, i) => [`k${i}`, i])))), /Liste trop longue/);
  const wide = Array.from({ length: 40 }, () => new Array(15_000).fill(0)); // 600 000 values in lists that are each short enough
  assert.match(String(inputTooBig({ wide })), /trop gros/);
  let deep: unknown = 1;
  for (let i = 0; i < 100; i++) deep = [deep];
  assert.match(String(inputTooBig(deep)), /imbriqué/);
});

test('dispatch refuses it before the schema runs (no error per item piled up)', async () => {
  let checked = 0;
  const schema = z.object({ ids: z.array(z.number().refine(() => (checked++, false))).max(10) });
  const registry = { 'x.list': proc(null, schema, async () => 'ran') };
  const ctx: any = { session: { isAdmin: true, roles: [] } };
  await assert.rejects(dispatch(registry as any, 'x.list', ctx, { ids: new Array(1_000_000).fill(0) }), /Liste trop longue/);
  assert.equal(checked, 0, 'the schema looked at the items');
  await assert.rejects(dispatch(registry as any, 'x.list', ctx, { ids: [1, 2] }), /Champ invalide/);
});
