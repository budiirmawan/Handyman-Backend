import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  buildPaginationMeta,
  parsePagination,
} from '../../shared/pagination';
import {
  parseCreateReportArchiveBody,
  parseReportArchiveId,
  parseReportArchiveListQuery,
  parseReportIdempotencyKey,
} from './reporting-archive.validation';
import { reportArchiveService } from './reporting-archive.service';
import {
  downloadReportArchive,
  generateReportArchive,
} from './reporting-archive-generation.service';

function userId(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export async function createReportArchiveHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const request = await reportArchiveService.createReportArchive(
      parseCreateReportArchiveBody(req.body),
      userId(req),
      parseReportIdempotencyKey(req.get('Idempotency-Key')),
    );
    sendSuccess(res, await generateReportArchive(request.id), 201);
  } catch (error) {
    next(error);
  }
}

export async function getReportArchiveHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await reportArchiveService.getReportArchive(
        parseReportArchiveId(param(req.params.id)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function downloadReportArchiveHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const artifact = await downloadReportArchive(
      parseReportArchiveId(param(req.params.id)),
      userId(req),
    );
    res
      .status(200)
      .set('Content-Type', artifact.contentType)
      .set('Content-Length', String(artifact.fileSize))
      .set(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
      )
      .send(artifact.buffer);
  } catch (error) {
    next(error);
  }
}

export async function listReportArchivesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = req.query as Record<string, unknown>;
    const pagination = parsePagination(query);
    const result = await reportArchiveService.listReportArchives(
      parseReportArchiveListQuery(query),
      userId(req),
      pagination.limit,
      pagination.offset,
    );
    sendSuccess(
      res,
      result.items,
      200,
      buildPaginationMeta(
        pagination.page,
        pagination.pageSize,
        result.total,
      ),
    );
  } catch (error) {
    next(error);
  }
}
