// Digit contracts: pricing and settlement are pure functions, so they can be pinned down without a
// database. Run with `node --test tests/`.
const test = require('node:test');
const assert = require('node:assert');

(async () => {
  const { digitMultiplierBp, lastDigitOf, digitOutcome } = await import('../src/cloud/trading.js');

  test('even and odd pay 1.92x (4% margin on a 50/50 outcome)', () => {
    assert.equal(digitMultiplierBp('DIGITEVEN', 0), 19200);
    assert.equal(digitMultiplierBp('DIGITODD', 0), 19200);
  });

  test('over/under are priced from the barrier', () => {
    assert.equal(digitMultiplierBp('DIGITOVER', 3), 16000);   // p = 6/10
    assert.equal(digitMultiplierBp('DIGITOVER', 8), 96000);   // p = 1/10
    assert.equal(digitMultiplierBp('DIGITUNDER', 2), 48000);  // p = 2/10
    assert.equal(digitMultiplierBp('DIGITOVER', 9), null);    // cannot win
    assert.equal(digitMultiplierBp('DIGITUNDER', 0), null);   // cannot win
  });

  test('match and differ are priced from a one-in-ten chance', () => {
    assert.equal(digitMultiplierBp('DIGITMATCH', 5), 96000);
    assert.equal(digitMultiplierBp('DIGITDIFF', 5), 10667);
  });

  test('the last digit is taken at the market precision', () => {
    assert.equal(lastDigitOf(1723.51, 2), 1);
    assert.equal(lastDigitOf(1723.5, 2), 0);
    assert.equal(lastDigitOf(1.08734, 5), 4);
  });

  test('each digit contract settles the way its name says', () => {
    assert.equal(digitOutcome('DIGITEVEN', null, 4), 'WON');
    assert.equal(digitOutcome('DIGITEVEN', null, 7), 'LOST');
    assert.equal(digitOutcome('DIGITODD', null, 7), 'WON');
    assert.equal(digitOutcome('DIGITOVER', 3, 4), 'WON');
    assert.equal(digitOutcome('DIGITOVER', 3, 3), 'LOST');
    assert.equal(digitOutcome('DIGITUNDER', 5, 4), 'WON');
    assert.equal(digitOutcome('DIGITUNDER', 5, 5), 'LOST');
    assert.equal(digitOutcome('DIGITMATCH', 5, 5), 'WON');
    assert.equal(digitOutcome('DIGITMATCH', 5, 6), 'LOST');
    assert.equal(digitOutcome('DIGITDIFF', 5, 6), 'WON');
    assert.equal(digitOutcome('DIGITDIFF', 5, 5), 'LOST');
  });
})();
