import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  clockInHandler,
  clockOutHandler,
  getCurrentAttendanceHandler,
} from './attendance.controller';

/**
 * CR-BE-MOB-05 PART 02 — Workforce Attendance endpoints.
 *
 *   POST /attendance/clock-in      — open an attendance record (201)
 *   POST /attendance/clock-out     — close the caller's open record
 *   GET  /attendance/current       — the caller's open record, or null
 *
 * Authentication + RBAC. Self-service: the caller's Workforce Profile and
 * open record are resolved from the authenticated session — never from a
 * caller-supplied identity. Clock-in asserts BE-02F/G Building access and
 * binds the applicable ACTIVE roster row when one exists. Timestamps are
 * backend-set (database clock). No attendance administration surface is
 * exposed here — clock-in/out is the worker's own attendance, gated by the
 * dedicated `attendance.manage` / `attendance.read` codes.
 */
export function createAttendanceRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('attendance.manage');
  const read = requirePermission('attendance.read');

  router.post('/attendance/clock-in', auth, manage, clockInHandler);
  router.post('/attendance/clock-out', auth, manage, clockOutHandler);
  router.get('/attendance/current', auth, read, getCurrentAttendanceHandler);

  return router;
}
