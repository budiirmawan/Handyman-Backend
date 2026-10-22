import type { NextFunction, Request, Response } from 'express';

import { workforceCertificationService } from './workforce-certification.service';
import {
  validateCertificationIdParam,
  validateCreateWorkforceCertificationInput,
  validateDeactivateWorkforceCertificationInput,
  validateListExpiringWorkforceCertificationsFilter,
  validateListWorkforceCertificationsFilter,
  validateUpdateWorkforceCertificationInput,
  validateVerifyWorkforceCertificationInput,
  validateWorkforceIdParam,
} from './workforce-certification.validation';

export const workforceCertificationController = {
  async listWorkforceCertifications(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const workforceId = validateWorkforceIdParam(req.params.workforceId);
      const filter = validateListWorkforceCertificationsFilter(req.query);
      const data =
        await workforceCertificationService.listWorkforceCertifications(
          workforceId,
          filter,
          req.auth,
        );
      res.status(200).json({ data });
    } catch (err) {
      next(err);
    }
  },

  async getWorkforceCertification(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const workforceId = validateWorkforceIdParam(req.params.workforceId);
      const certificationId = validateCertificationIdParam(
        req.params.certificationId,
      );
      const data =
        await workforceCertificationService.getWorkforceCertificationById(
          workforceId,
          certificationId,
          req.auth,
        );
      res.status(200).json({ data });
    } catch (err) {
      next(err);
    }
  },

  async createWorkforceCertification(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const workforceId = validateWorkforceIdParam(req.params.workforceId);
      const input = validateCreateWorkforceCertificationInput(req.body);
      const data =
        await workforceCertificationService.createWorkforceCertification(
          workforceId,
          input,
          req.auth,
        );
      res.status(201).json({ data });
    } catch (err) {
      next(err);
    }
  },

  async updateWorkforceCertification(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const workforceId = validateWorkforceIdParam(req.params.workforceId);
      const certificationId = validateCertificationIdParam(
        req.params.certificationId,
      );
      const input = validateUpdateWorkforceCertificationInput(req.body);
      const data =
        await workforceCertificationService.updateWorkforceCertification(
          workforceId,
          certificationId,
          input,
          req.auth,
        );
      res.status(200).json({ data });
    } catch (err) {
      next(err);
    }
  },

  async verifyWorkforceCertification(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const workforceId = validateWorkforceIdParam(req.params.workforceId);
      const certificationId = validateCertificationIdParam(
        req.params.certificationId,
      );
      const input = validateVerifyWorkforceCertificationInput(req.body);
      const data =
        await workforceCertificationService.verifyWorkforceCertification(
          workforceId,
          certificationId,
          input,
          req.auth,
        );
      res.status(200).json({ data });
    } catch (err) {
      next(err);
    }
  },

  async deactivateWorkforceCertification(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const workforceId = validateWorkforceIdParam(req.params.workforceId);
      const certificationId = validateCertificationIdParam(
        req.params.certificationId,
      );
      const input = validateDeactivateWorkforceCertificationInput(req.body);
      const data =
        await workforceCertificationService.deactivateWorkforceCertification(
          workforceId,
          certificationId,
          input,
          req.auth,
        );
      res.status(200).json({ data });
    } catch (err) {
      next(err);
    }
  },

  async listExpiringWorkforceCertifications(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const filter = validateListExpiringWorkforceCertificationsFilter(
        req.query,
      );
      const data =
        await workforceCertificationService.listExpiringWorkforceCertifications(
          filter,
          req.auth,
        );
      res.status(200).json({ data });
    } catch (err) {
      next(err);
    }
  },
};
