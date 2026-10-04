export function stripCaptionMnemonics(text) {
  let rendered = '';
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '&' || index === text.length - 1) {
      rendered += text[index];
    } else if (text[index + 1] === '&') {
      rendered += '&';
      index++;
    } else {
      index++;
      rendered += text[index];
    }
  }
  return rendered;
}
