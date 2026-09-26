export const DEPTH_COMPARE = Object.freeze([
  null,
  'never',
  'less',
  'equal',
  'less-equal',
  'greater',
  'not-equal',
  'greater-equal',
  'always',
]);
export const CULL_MODE = Object.freeze([null, 'none', 'cw', 'ccw']);
export function primitiveState(mode) {
  return {
    topology: 'triangle-list',
    frontFace: 'ccw',
    cullMode: mode === 'cw' ? 'back' : mode === 'ccw' ? 'front' : 'none',
  };
}
export function validRasterState(command) {
  return (
    CULL_MODE.includes(command.cullMode) &&
    command.cullMode !== null &&
    DEPTH_COMPARE.slice(1).includes(command.depthCompare ?? 'less-equal')
  );
}
