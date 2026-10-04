let pending = Promise.resolve();
const toHex = (value) =>
  '#' +
  [value & 255, (value >>> 8) & 255, (value >>> 16) & 255]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
const fromHex = (value) => {
  const rgb = value
    .slice(1)
    .match(/../g)
    .map((v) => parseInt(v, 16));
  return rgb[0] | (rgb[1] << 8) | (rgb[2] << 16);
};
const BASIC = [
  0x000000, 0x808080, 0xc0c0c0, 0xffffff, 0x000080, 0x0000ff, 0x008080, 0x00ffff, 0x008000,
  0x00ff00, 0x808000, 0xffff00, 0x800000, 0xff0000, 0x800080, 0xff00ff,
];
export function showColorPicker(dialog, request, active = () => true, stop = () => {}) {
  const result = pending.then(() => {
    if (!active()) return null;
    return new Promise((resolve) => {
      const field = (name) => dialog.querySelector(`#color-${name}`);
      const customColors = request.customColors.slice();
      let value = request.initial,
        slot = request.nextCustomSlot ?? 0,
        accepted = false;
      dialog.dataset.requestToken = String(request.token);
      function update() {
        field('rgb').value = toHex(value);
        for (const [i, name] of ['red', 'green', 'blue'].entries())
          field(name).value = (value >>> (i * 8)) & 255;
        field('preview').style.backgroundColor = toHex(value);
        field('preview').textContent = toHex(value).toUpperCase();
        field('preview').style.color =
          (value & 255) * 0.299 + ((value >>> 8) & 255) * 0.587 + ((value >>> 16) & 255) * 0.114 >
          140
            ? 'black'
            : 'white';
      }
      function swatches(colors, container, custom) {
        container.replaceChildren(
          ...colors.map((color, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'color-swatch';
            button.style.backgroundColor = toHex(color);
            button.setAttribute(
              'aria-label',
              `${custom ? 'Custom' : 'Basic'} color ${index + 1}: ${toHex(color)}`,
            );
            if (custom) {
              button.setAttribute('aria-pressed', String(index === slot));
              button.dataset.colorSlot = index;
            }
            button.onclick = () => {
              value = color;
              if (custom) {
                slot = index;
                renderCustom();
              }
              update();
            };
            return button;
          }),
        );
      }
      const renderCustom = () => swatches(customColors, field('custom'), true);
      swatches(BASIC, field('basic'), false);
      renderCustom();
      field('advanced').hidden = !request.fullOpen;
      field('expand').disabled = request.preventFullOpen || request.fullOpen;
      field('expand').onclick = () => {
        field('advanced').hidden = false;
        field('expand').disabled = true;
      };
      field('rgb').oninput = () => {
        value = fromHex(field('rgb').value);
        update();
      };
      for (const name of ['red', 'green', 'blue'])
        field(name).oninput = () => {
          const values = ['red', 'green', 'blue'].map((n) => +field(n).value);
          if (values.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
            value = values[0] | (values[1] << 8) | (values[2] << 16);
            update();
          }
        };
      field('add').onclick = () => {
        customColors[slot] = value;
        slot = slot < 8 ? slot + 8 : (slot - 7) % 8;
        renderCustom();
      };
      field('form').onsubmit = (event) => {
        event.preventDefault();
        if (!field('form').reportValidity()) return;
        accepted = true;
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
      dialog.onclose = () =>
        resolve({ accepted, color: value, customColors, nextCustomSlot: slot });
      update();
      dialog.showModal();
      field('cancel').focus();
    });
  });
  pending = result.catch(() => null);
  return result;
}
