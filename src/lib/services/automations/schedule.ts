export type Schedule = 'hourly' | 'daily' | 'weekdays' | 'weekly';

// Calendar arithmetic keeps wall-clock times stable across daylight-saving changes.
export function nextOccurrence(schedule: Schedule, time: string, day: number, after: number): number {
  const [hour, minute] = time.split(':').map(Number);
  if (!/^\d{2}:\d{2}$/.test(time) || hour > 23 || minute > 59 || !Number.isInteger(day) || day < 0 || day > 6) throw new Error('Invalid schedule');
  const next = new Date(after);
  next.setSeconds(0, 0);
  if (schedule === 'hourly') {
    next.setMinutes(minute);
    if (next.getTime() <= after) next.setHours(next.getHours() + 1);
    return next.getTime();
  }
  next.setHours(hour, minute, 0, 0);
  for (let i = 0; i < 9; i++) {
    const weekday = next.getDay();
    if (next.getTime() > after && (schedule === 'daily' || (schedule === 'weekdays' && weekday > 0 && weekday < 6) || (schedule === 'weekly' && weekday === day))) return next.getTime();
    next.setDate(next.getDate() + 1);
  }
  throw new Error('Could not compute next run');
}
