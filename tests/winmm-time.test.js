import test from 'node:test';
import assert from 'node:assert/strict';
import { multimediaTimeApis } from '../src/winmm-time.js';
import { GuestPerformanceClock } from '../src/guest-clock.js';
const call = (r, name, args = []) => multimediaTimeApis['winmm.dll!' + name](r, (i) => args[i]);
test('WinMM milliseconds use the monotonic guest counter and wrap at 32 bits', () => {
  let now = 4_294_967_295_999_999n;
  const r = { performanceClock: new GuestPerformanceClock(() => now) };
  assert.deepEqual(call(r, 'timeGetTime'), { result: 0xffffffff, argc: 0 });
  now++;
  assert.equal(call(r, 'timeGetTime').result, 0);
  now = 1n;
  assert.equal(
    call(r, 'timeGetTime').result,
    0,
    'source clock reversal does not move virtual time back',
  );
});
test('WinMM timer resolution requests require a matching end and reject out-of-range periods', () => {
  const r = {};
  for (const period of [0, 1001, 0xffffffff])
    assert.equal(call(r, 'timeBeginPeriod', [period]).result, 97);
  for (let i = 0; i < 2; i++) assert.equal(call(r, 'timeBeginPeriod', [1]).result, 0);
  assert.equal(call(r, 'timeEndPeriod', [2]).result, 97);
  for (let i = 0; i < 2; i++) assert.equal(call(r, 'timeEndPeriod', [1]).result, 0);
  assert.equal(call(r, 'timeEndPeriod', [1]).result, 97);
  assert.equal(r.multimediaPeriods.size, 0);
});
