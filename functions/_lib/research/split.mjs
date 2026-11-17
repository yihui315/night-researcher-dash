// Train / Validate / OOS data isolation.
//
// Snapshots are partitioned strictly by DATE so the out-of-sample (OOS) set never overlaps the
// in-sample (train + validate) sets. This is the backbone of honest strategy evaluation:
// a strategy is only promoted to the live pool after it passes on data it was not tuned on.

// config: { trainEnd: 'YYYY-MM-DD', validateEnd: 'YYYY-MM-DD' }  (inclusive day boundaries)
//   - snapshot UTC date <= trainEnd            -> train
//   - trainEnd < date <= validateEnd           -> validate
//   - date > validateEnd                       -> oos
export function splitByDate(snapshots, config = {}) {
  const trainEnd = config.trainEnd || null;
  const validateEnd = config.validateEnd || null;
  const train = [];
  const validate = [];
  const oos = [];
  for (const snap of snapshots) {
    const t = snap.timestampMs != null ? snap.timestampMs : Date.parse(snap.timestamp);
    if (!Number.isFinite(t)) continue;
    const date = new Date(t).toISOString().slice(0, 10);
    if (trainEnd && date <= trainEnd) train.push(snap);
    else if (validateEnd && date <= validateEnd) validate.push(snap);
    else oos.push(snap);
  }
  return { train, validate, oos };
}

// Classify a single snapshot's split label (used for labeling records).
export function classifySplit(snapshot, config = {}) {
  const trainEnd = config.trainEnd || null;
  const validateEnd = config.validateEnd || null;
  const t = snapshot.timestampMs != null ? snapshot.timestampMs : Date.parse(snapshot.timestamp);
  const date = new Date(t).toISOString().slice(0, 10);
  if (trainEnd && date <= trainEnd) return "train";
  if (validateEnd && date <= validateEnd) return "validate";
  return "oos";
}

// Assert that train/validate and oos are date-disjoint (defensive: returns boolean).
export function isOosIsolated(snapshots, config = {}) {
  const { train, validate, oos } = splitByDate(snapshots, config);
  if (oos.length === 0) return false; // nothing to isolate
  const trainValidateMax = Math.max(
    ...[...train, ...validate].map(s => (s.timestampMs != null ? s.timestampMs : Date.parse(s.timestamp)))
  );
  const oosMin = Math.min(...oos.map(s => (s.timestampMs != null ? s.timestampMs : Date.parse(s.timestamp))));
  return oosMin > trainValidateMax;
}
