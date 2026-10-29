// The courier's refusal must say WHICH field is wrong, not only « One or more validation errors occurred ».
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errText } from '../couriers/util';

test('validation errors: the fields and their reasons follow the title', () => {
  const zr = { title: 'One or more validation errors occurred.', status: 400, errors: { 'Customer.Phone.Number1': ['The phone number is not valid.'] }, traceId: '00-x' };
  assert.equal(errText(zr), 'One or more validation errors occurred. — Customer.Phone.Number1 : The phone number is not valid.');
});

test('list forms: {code, description} and {propertyName, errorMessage}', () => {
  assert.match(errText({ detail: 'One or more validation errors occurred', errors: [{ code: 'Parcel.Amount', description: 'Amount must be positive' }] }), /Parcel\.Amount : Amount must be positive/);
  assert.match(
    errText({ error: { code: 'Validation', description: 'One or more validation errors occurred' }, validationErrors: [{ propertyName: 'DeliveryAddress.DistrictTerritoryId', errorMessage: 'Commune not in this wilaya' }] }),
    /DistrictTerritoryId : Commune not in this wilaya/,
  );
});

test('a plain answer stays as it was', () => {
  assert.equal(errText({ title: 'Not found', status: 404 }), 'Not found');
  assert.equal(errText('plain text'), 'plain text');
  assert.equal(errText({ detail: 'The parcel is not in a locked state.' }), 'The parcel is not in a locked state.');
});
