'use strict';

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const toCents = (value, label = 'Amount') => {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(Math.round(n * 100) - n * 100) > 1e-6) {
    throw new HttpError(400, `${label} must be a number with at most 2 decimals`);
  }
  return Math.round(n * 100);
};
const fromCents = (c) => c / 100;

const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please log in' }));
const requireAdmin = (req, res, next) =>
  (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' }));

module.exports = { HttpError, toCents, fromCents, requireUser, requireAdmin };
