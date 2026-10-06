// The client's calendar day for an epoch ms. tzOffsetMin is what the
// browser's Date#getTimezoneOffset returns (minutes behind UTC).
export function localDate(ms, tzOffsetMin = 0) {
  return new Date(ms - tzOffsetMin * 60_000).toISOString().slice(0, 10);
}
