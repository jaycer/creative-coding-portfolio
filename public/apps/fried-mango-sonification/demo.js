// demo.js — an invented job search, so the page plays before you give it yours.
//
// Nobody's real search: the numbers come from a fixed seed. It has the shape a
// real one tends to have, which is what makes it a fair demo: a burst at the
// start, a first interview after a few weeks, a slow middle, a second wind,
// and an offer near the end.

export function demoSearch() {
  let seed = 20260610;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const days = 120;
  // How hard the search is being worked, day by day, from 0 to 1.
  const effort = (d) => {
    const weekend = d % 7 >= 5 ? 0.25 : 1;
    const shape = d < 30 ? 1 : d < 62 ? 0.35 : d < 100 ? 0.85 : 0.3;
    return weekend * shape;
  };

  const captured = [];
  const jobs = [];
  for (let d = 0; d < days; d++) {
    const e = effort(d);
    const surge = d >= 66 && d <= 72 ? 6 : 1;
    captured.push(Math.round(e * surge * (8 + rand() * 30)));
    const found = Math.floor(e * rand() * 5.5);
    for (let i = 0; i < found; i++) {
      const applied = rand() < 0.75 ? Math.min(days - 1, d + Math.floor(rand() * 3)) : -1;
      const interview = applied >= 0 && rand() < 0.1 ? applied + 6 + Math.floor(rand() * 12) : -1;
      jobs.push([d, applied, interview < days ? interview : -1, -1, -1]);
    }
  }
  // Two offers, each on a job that reached an interview.
  const interviewed = jobs.filter((j) => j[2] >= 0).sort((a, b) => a[2] - b[2]);
  const early = interviewed.find((j) => j[2] >= 34);
  if (early) early[3] = Math.min(days - 1, early[2] + 5);
  const late = [...interviewed].reverse().find((j) => j[2] <= days - 6 && j !== early);
  if (late) { late[3] = days - 2; late[2] = Math.min(late[2], days - 8); }

  const firstInterview = interviewed.length ? interviewed[0][2] : 20;
  return {
    title: 'A job search',
    start: '2026-01-05',
    days,
    jobs,
    captured,
    milestones: [
      [0, 'Day 1. The first applications go out.'],
      [firstInterview, 'The first interview.'],
      ...(early ? [[early[3], 'A first offer, part time.']] : []),
      [66, 'A wider search. Postings arrive by the hundred.'],
      [days - 2, 'Offer signed. Full time.'],
    ],
  };
}
