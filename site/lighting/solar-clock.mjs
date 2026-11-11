/* Adapted from MIT-licensed Isometric Toronto software. See LICENSE-TORONTO.txt
 * and README.md for exact source URLs, deployment hashes and modifications.
 * No Toronto artwork, model weights or municipal data are included.
 */
export const MISSISSAUGA = Object.freeze({ latitude: 43.589, longitude: -79.644, timeZone: 'America/Toronto' });
export const WINDOW_SHARE_POINTS = Object.freeze([
  [0,.27], [1,.22], [3,.13], [5,.13], [6.5,.24], [8,.3],
  [12,.3], [16,.48], [18.5,.55], [21,.5], [23,.36], [24,.27],
].map(Object.freeze));
const DEG = Math.PI / 180;
const clamp = n => Math.min(1, Math.max(0, n));
function timestamp(value) {
  const ms = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(ms)) throw new TypeError('Expected a finite epoch-millisecond timestamp or Date');
  return ms;
}
function number(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}

/** Solar altitude in degrees; east-positive longitude. No weather/API calls. */
export function solarAltitude(time, latitude = MISSISSAUGA.latitude, longitude = MISSISSAUGA.longitude) {
  number(latitude, 'latitude'); number(longitude, 'longitude');
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new RangeError('Invalid geographic coordinates');
  const days = timestamp(time) / 86400000 + 2440587.5 - 2451545;
  const century = days / 36525;
  const meanLongitude = (280.46646 + century * (36000.76983 + century * .0003032)) % 360;
  const meanAnomaly = (357.52911 + century * (35999.05029 - .0001537 * century)) * DEG;
  const equation = Math.sin(meanAnomaly) * (1.914602 - century * (.004817 + .000014 * century))
    + Math.sin(2 * meanAnomaly) * (.019993 - .000101 * century) + Math.sin(3 * meanAnomaly) * .000289;
  const omega = (125.04 - 1934.136 * century) * DEG;
  const apparentLongitude = (meanLongitude + equation - .00569 - .00478 * Math.sin(omega)) * DEG;
  const obliquity = (23 + (26 + (21.448 - century * (46.815 + century * (.00059 - century * .001813))) / 60) / 60
    + .00256 * Math.cos(omega)) * DEG;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(apparentLongitude));
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(apparentLongitude), Math.cos(apparentLongitude));
  const hourAngle = (280.46061837 + 360.98564736629 * days + .000387933 * century ** 2
    - century ** 3 / 38710000 + longitude) * DEG - rightAscension;
  return Math.asin(Math.sin(latitude * DEG) * Math.sin(declination)
    + Math.cos(latitude * DEG) * Math.cos(declination) * Math.cos(hourAngle)) / DEG;
}

/** 0 by day, 1 after civil twilight; continuous through dawn/dusk. */
export function nightFromAltitude(altitude) {
  const t = clamp((-.833 - number(altitude, 'altitude')) / 5.167);
  return t * t * (3 - 2 * t);
}
export function windowShare(hour) {
  const h = ((number(hour, 'hour') % 24) + 24) % 24;
  for (let i = 1; i < WINDOW_SHARE_POINTS.length; i++) {
    const [b, y] = WINDOW_SHARE_POINTS[i], [a, x] = WINDOW_SHARE_POINTS[i - 1];
    if (h <= b) return x + (y - x) * (h - a) / (b - a);
  }
  return WINDOW_SHARE_POINTS[0][1];
}
const formatters = new Map();
export function localParts(time, timeZone = MISSISSAUGA.timeZone) {
  if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {
    timeZone, year:'numeric', month:'numeric', day:'numeric', hour:'numeric', minute:'numeric', second:'numeric', hourCycle:'h23',
  }));
  const p = Object.fromEntries(formatters.get(timeZone).formatToParts(new Date(timestamp(time)))
    .filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return { ...p, hour: p.hour % 24 };
}
export function localHour(time, timeZone = MISSISSAUGA.timeZone) {
  const p = localParts(time, timeZone);
  return p.hour + p.minute / 60 + p.second / 3600;
}
const civilMillis = p => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);

/** Preview an hour on this local date, honoring DST gaps/folds without a fixed UTC offset.
 * compatible/earlier choose the first repeated hour; later chooses the second.
 * For a missing spring hour, compatible/later advance across the gap; earlier goes back.
 */
export function dateAtLocalHour(time, hour, timeZone = MISSISSAUGA.timeZone, disambiguation = 'compatible') {
  if (!['compatible','earlier','later','reject'].includes(disambiguation)) throw new RangeError('Invalid DST disambiguation');
  if (!Number.isFinite(hour) || hour < 0 || hour >= 24) throw new RangeError('Preview hour must be in [0,24)');
  const p = localParts(time, timeZone);
  const desired = Date.UTC(p.year, p.month - 1, p.day) + Math.min(86399, Math.round(hour * 3600)) * 1000;
  const offsets = new Set();
  for (let delta = -36; delta <= 36; delta += 12) {
    const sample = desired + delta * 3600000;
    offsets.add(civilMillis(localParts(sample, timeZone)) - sample);
  }
  const candidates = [...offsets].map(offset => {
    const ms = desired - offset;
    return { ms, difference: civilMillis(localParts(ms, timeZone)) - desired };
  }).sort((a,b) => a.ms - b.ms);
  const matches = candidates.filter(c => c.difference === 0);
  if (matches.length === 1) return matches[0].ms;
  if (disambiguation === 'reject') throw new RangeError('Local hour is ambiguous or nonexistent because of DST');
  if (matches.length) return (disambiguation === 'later' ? matches.at(-1) : matches[0]).ms;
  const forward = candidates.filter(c => c.difference > 0).sort((a,b) => a.difference - b.difference);
  const backward = candidates.filter(c => c.difference < 0).sort((a,b) => b.difference - a.difference);
  const result = disambiguation === 'earlier' ? backward[0] : forward[0];
  if (!result) throw new RangeError('Could not resolve the requested local hour');
  return result.ms;
}

/** Pull-based clock: no timers, DOM/global hooks, rendering or network side effects. */
export function createSolarClock({ latitude = MISSISSAUGA.latitude, longitude = MISSISSAUGA.longitude,
  timeZone = MISSISSAUGA.timeZone, now = Date.now } = {}) {
  let mode = 'auto', previewTime = null;
  function getState() {
    const time = previewTime ?? timestamp(now());
    const altitude = solarAltitude(time, latitude, longitude);
    const autoNight = nightFromAltitude(altitude);
    const actualHour = localHour(time, timeZone);
    // Like Toronto, daytime forced-night previews use an evening occupancy, not noon.
    // Explicit manual-hour previews always retain the chosen hour's occupancy.
    const occupancyHour = mode === 'night' && previewTime === null && autoNight < .5 ? 21.5 : actualHour;
    const night = mode === 'day' ? 0 : mode === 'night' ? 1 : autoNight;
    return { timestamp:time, source:previewTime === null ? 'real' : 'preview', mode, timeZone,
      latitude, longitude, altitude, autoNight, night, level:1-night, hour:actualHour,
      occupancyHour, share:windowShare(occupancyHour) };
  }
  return {
    getState,
    setMode(value) {
      if (!['auto','day','night'].includes(value)) throw new RangeError('Mode must be auto, day or night');
      mode = value; return getState();
    },
    setTime(value) { previewTime = timestamp(value); return getState(); },
    setHour(hour, { date = previewTime ?? now(), disambiguation = 'compatible' } = {}) {
      previewTime = dateAtLocalHour(date, hour, timeZone, disambiguation); return getState();
    },
    useRealTime() { previewTime = null; return getState(); },
  };
}
