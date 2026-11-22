// Decodes a downloaded CSV into text. Raiser's Edge query exports are not always UTF-8: when the bytes are not valid UTF-8
// they are Windows-1252 (Latin-1), and reading those as UTF-8 turns every accented letter (n with tilde, e with acute) into the
// replacement character. Valid UTF-8 is read as UTF-8; anything else as Windows-1252.
function decodeCsv(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1252').decode(bytes); }
}
module.exports = { decodeCsv };
