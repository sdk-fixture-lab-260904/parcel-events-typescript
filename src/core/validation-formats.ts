function validIPv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every(part => /^(0|[1-9][0-9]{0,2})$/.test(part)
    && !part.includes('\n') && Number(part) <= 255);
}
function validIPv6(value: string): boolean {
  if (value.length > 45 || !/^[0-9a-fA-F:.]+$/.test(value) || value.includes('\n')) return false;
  let normalized = value;
  if (value.includes('.')) {
    const colon = value.lastIndexOf(':');
    if (colon < 0 || !validIPv4(value.slice(colon + 1))) return false;
    normalized = value.slice(0, colon + 1) + '0:0';
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return false;
  const groups = halves.flatMap(half => half === '' ? [] : half.split(':'));
  if (!groups.every(group => /^[0-9a-fA-F]{1,4}$/.test(group))) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

/** RFC 3339 calendar validation without permissive host date parsing. */
function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null || match[0] !== value) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
}
function validTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[zZ]|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (match === null || match[0] !== value) return false;
  const hour = Number(match[1]), minute = Number(match[2]), second = Number(match[3]);
  const offsetHour = Number(match[5] ?? 0), offsetMinute = Number(match[6] ?? 0);
  if (hour > 23 || minute > 59 || second > 60 || offsetHour > 23 || offsetMinute > 59) return false;
  const offset = (offsetHour * 60 + offsetMinute) * (match[4] === '-' ? -1 : 1);
  return second !== 60 || ((hour * 60 + minute - offset + 1440) % 1440 === 1439);
}
/** Unknown/custom formats remain annotations; supported formats are asserted. */
export function matchesFormat(format: string, value: string): boolean {
  if (format === 'ipv4') return validIPv4(value);
  if (format === 'ipv6') return validIPv6(value);
  if (format === 'date') return validDate(value);
  if (format === 'time') return validTime(value);
  if (format === 'date-time') return value.length >= 20 && /^[tT]$/.test(value[10] ?? '')
    && validDate(value.slice(0, 10)) && validTime(value.slice(11));
  if (format === 'uuid') return value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  return true;
}
