let pending = Promise.resolve();
/** Serialize native font requests so each guest receives its own selection. */
export function showFontPicker(dialog, request, active = () => true, stop = () => {}) {
  const result = pending.then(() => {
    if (!active()) return null;
    return new Promise((resolve) => {
      dialog.dataset.requestToken = String(request.token);
      const field = (name) => dialog.querySelector(`#font-${name}`);
      const initial = request.initial;
      for (const name of ['face', 'points', 'weight']) field(name).value = initial[name];
      for (const name of ['italic', 'underline', 'strikeout']) field(name).checked = initial[name];
      field('color').value =
        '#' +
        [initial.color & 255, (initial.color >> 8) & 255, (initial.color >> 16) & 255]
          .map((v) => v.toString(16).padStart(2, '0'))
          .join('');
      field('points').min = request.min;
      field('points').max = request.max;
      field('face').disabled = request.noFace;
      field('points').disabled = request.noSize;
      field('weight').disabled = field('italic').disabled = request.noStyle;
      field('effects').hidden = !request.effects;
      const selection = () => {
        const rgb = field('color')
          .value.slice(1)
          .match(/../g)
          .map((v) => parseInt(v, 16));
        return {
          face: field('face').value,
          points: +field('points').value,
          weight: +field('weight').value,
          italic: field('italic').checked,
          underline: field('underline').checked,
          strikeout: field('strikeout').checked,
          color: rgb[0] | (rgb[1] << 8) | (rgb[2] << 16),
        };
      };
      const update = () => {
        const value = selection(),
          preview = field('preview');
        preview.style.fontFamily = JSON.stringify(value.face);
        preview.style.fontSize = `${value.points}pt`;
        preview.style.fontWeight = value.weight;
        preview.style.fontStyle = value.italic ? 'italic' : 'normal';
        preview.style.textDecoration =
          [value.underline ? 'underline' : '', value.strikeout ? 'line-through' : '']
            .filter(Boolean)
            .join(' ') || 'none';
        preview.style.color = request.effects ? field('color').value : '#000000';
      };
      let answer = null;
      field('form').oninput = update;
      field('form').onsubmit = (event) => {
        event.preventDefault();
        if (!field('form').reportValidity()) return;
        answer = selection();
        dialog.close();
      };
      field('cancel').onclick = () => dialog.close();
      field('stop').onclick = () => {
        dialog.close();
        stop();
      };
      dialog.oncancel = (event) => {
        event.preventDefault();
        dialog.close();
      };
      dialog.onclose = () => {
        resolve(answer);
      };
      update();
      dialog.showModal();
      field('face').focus();
    });
  });
  pending = result.catch(() => null);
  return result;
}
