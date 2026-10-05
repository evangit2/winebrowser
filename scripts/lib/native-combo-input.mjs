import { expect } from '@playwright/test';
export async function nativeComboList(combo) {
  const id = await combo.getAttribute('data-window-id');
  return combo.page().locator(`[data-control-type="listbox"][data-parent-id="${id}"]`);
}
export async function selectNativeCombo(combo, option) {
  // Keyboard presses do not perform Playwright click-style visibility waits.
  // Property sheets may still be showing the target native page after a tab click.
  await expect(combo).toBeVisible();
  await expect(combo).toHaveAttribute('aria-disabled', 'false');
  const simple = (await combo.getAttribute('data-combo-type')) === '1';
  if (!simple) {
    await combo.press('F4');
    await expect(combo).toHaveAttribute('aria-expanded', 'true');
  }
  const list = await nativeComboList(combo);
  const row =
    option.index === undefined
      ? list.getByRole('option', { name: option.label, exact: true })
      : list.getByRole('option').nth(option.index);
  await row.click();
  if (!simple) await expect(combo).toHaveAttribute('aria-expanded', 'false');
}
export function nativeComboEdit(combo) {
  return combo.locator('..').locator('input[data-control-type="edit"]');
}
export async function nativeComboText(combo) {
  return combo
    .locator('..')
    .evaluate(
      (element) =>
        element.querySelector('.virtual-desktop-combo-text')?.textContent ??
        element.querySelector('input')?.value ??
        '',
    );
}
