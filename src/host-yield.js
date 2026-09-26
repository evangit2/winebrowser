// Cooperative yields for the guest dispatch loop. `setTimeout(0)` is clamped to
// several milliseconds once timers are nested, which wastes wall-clock without
// executing guest code; a MessageChannel message is an ordinary macrotask task
// and is not timer-clamped. Fall back to a timer where MessageChannel is absent.

// setImmediate is an unclamped macrotask in Node; browsers omit it, so they use
// a MessageChannel message, which is also an ordinary (non-timer) task.
const hasImmediate = typeof setImmediate === 'function';

let channel = null;
const pending = [];

function ensureChannel() {
  if (channel) return channel;
  if (typeof MessageChannel !== 'function') return null;
  channel = new MessageChannel();
  channel.port1.onmessage = () => pending.shift()?.();
  return channel;
}

// Yield to the host event loop without a timer clamp. Prefer this for the
// high-frequency loop yield so guest execution keeps most of the wall clock.
export function yieldToHost() {
  if (hasImmediate) return new Promise((resolve) => setImmediate(resolve));
  const port = ensureChannel();
  if (!port) return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    pending.push(resolve);
    port.port2.postMessage(0);
  });
}

// Yield via a timer task. Used periodically so timer-based host work (input,
// stop requests, deadlines) is still observed despite the message-chain yield.
export function yieldToTimer() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
