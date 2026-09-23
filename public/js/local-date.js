// The phone's calendar date (YYYY-MM-DD) at a timestamp. A run's prescription
// is the one active on the user's day: pinned by the server from this at
// start, and fetched for display with the same date, so the two agree.
export function localISODate(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
