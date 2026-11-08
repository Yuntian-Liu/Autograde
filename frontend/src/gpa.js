export const GPA_BY_RATING = {
  "A+": 4.33,
  A: 4.00,
  "A-": 3.67,
  "B+": 3.33,
  B: 3.00,
  "B-": 2.67,
  "C+": 2.33,
  C: 2.00,
  "C-": 1.67,
  D: 1.33,
  E: 1.00,
  F: 0.00,
};

export function gpaForRating(rating) {
  return Object.hasOwn(GPA_BY_RATING, rating) ? GPA_BY_RATING[rating] : null;
}

export function fmtGpa(value) {
  return value === null || value === undefined ? "—" : Number(value).toFixed(2);
}
