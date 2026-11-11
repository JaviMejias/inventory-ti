import { Prisma, Role, type PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import { requireAuthenticated, requireCsrf, requireRole } from '../auth/service.js';
import { ApiError } from '../lib/errors.js';
import { applicationIdSchema, applicationListSchema, pilotApplySchema } from './apply-schemas.js';
import { applyImportPilot, getImportApplication, listImportApplications } from './apply-service.js';
import { pilotPlanSchema } from './plan-schemas.js';
import { planImportPilot } from './plan-service.js';
import { batchCreateSchema, batchIdSchema, batchListSchema, decisionListSchema, reviewDecisionSchema } from './review-schemas.js';
import { appendReviewDecision, createImportBatch, getImportBatch, getImportFreshness, getImportSnapshot, listImportBatches, listReviewDecisions } from './review-service.js';
import { previewBodyLimit } from './schemas.js';
import { sourcePageSchema, sourceRevisionSchema } from './source-schemas.js';
import { identityRevisionSchema } from './identity-schemas.js';
import { appendIdentityRevision, appendSourceRevision, getResolvedPreview, getSourceCatalog, listSourceRevisions } from './source-service.js';
import { historyCaptureIdSchema, historyCaptureSchema, historyPageSchema } from './history-schemas.js';
import { captureHistoricalEvidence, getHistoryCapture, listAssetImportedEvidence, listHistoryCaptures, previewHistoricalEvidence } from './history-service.js';
import { closedAssignmentPlanSchema } from './assignment-plan-schemas.js';
import { planClosedAssignments } from './assignment-plan-service.js';
import { assignmentApplicationParamsSchema, closedAssignmentApplySchema } from './assignment-apply-schemas.js';
import { applyClosedAssignments, getAssignmentApplication, listAssignmentApplications } from './assignment-apply-service.js';
import { assignmentCorrectionParamsSchema, assignmentCorrectionPlanSchema } from './assignment-correction-schemas.js';
import { planAssignmentCorrection } from './assignment-correction-service.js';
import { assignmentCorrectionApplySchema, assignmentCorrectionReceiptParamsSchema } from './assignment-correction-apply-schemas.js';
import { applyAssignmentCorrection, getAssignmentCorrection, listAssignmentCorrections } from './assignment-correction-apply-service.js';
import { evidenceAmendmentParamsSchema, evidenceAmendmentPlanSchema, evidenceAmendmentSchema } from './evidence-amendment-schemas.js';
import { amendHistoricalEvidence, getEvidenceAmendment, listEvidenceAmendments, planEvidenceAmendment } from './evidence-amendment-service.js';
import { historicalRetirementPlanSchema } from './retirement-plan-schemas.js';
import { planHistoricalRetirement } from './retirement-plan-service.js';
import { historicalRetirementApplySchema, retirementApplicationParamsSchema } from './retirement-apply-schemas.js';
import { applyHistoricalRetirement, getRetirementApplication, listRetirementApplications } from './retirement-apply-service.js';
import { retirementReconciliationSchema } from './retirement-reconciliation-schemas.js';
import { reconcileHistoricalRetirement } from './retirement-reconciliation-service.js';
import { retirementDocumentApplySchema, retirementDocumentParamsSchema, retirementDocumentPlanSchema } from './retirement-document-schemas.js';
import { getRetirementDocument, listRetirementDocuments, planRetirementDocument, recordRetirementDocument } from './retirement-document-service.js';
import { identityGroupPlanSchema } from './identity-group-plan-schemas.js';
import { planIdentityGroups } from './identity-group-plan-service.js';
import { identityGroupReleaseSchema, identityGroupReviewParamsSchema, identityGroupReviewSchema } from './identity-group-review-schemas.js';
import { getIdentityGroupReview, listIdentityGroupReviews, releaseIdentityGroupReview, saveIdentityGroupReview } from './identity-group-review-service.js';
import { identityGroupProjectionQuerySchema } from './identity-group-projection.js';
import { getIdentityGroupProjection } from './identity-group-projection-service.js';
import { identityGroupDecisionListSchema, identityGroupDecisionParamsSchema, identityGroupDecisionSchema } from './identity-group-decision-schemas.js';
import { appendIdentityGroupDecision, getIdentityGroupDecision, listIdentityGroupDecisions } from './identity-group-decision-service.js';
import { identityGroupPilotSchema } from './identity-group-pilot-schemas.js';
import { planIdentityGroupPilot } from './identity-group-pilot-service.js';
import { identityGroupApplicationParamsSchema, identityGroupApplySchema } from './identity-group-apply-schemas.js';
import { applyIdentityGroupPilot, getIdentityGroupApplication, listIdentityGroupApplications } from './identity-group-apply-service.js';
import { identityGroupHistoryParamsSchema, identityGroupHistoryPlanSchema } from './identity-group-history-schemas.js';
import { planGroupHistoryLink } from './identity-group-history-service.js';
import { groupHistoryApplySchema, groupHistoryReceiptParamsSchema } from './identity-group-history-apply-schemas.js';
import { applyGroupHistoryLinks, getGroupHistoryApplication, listGroupHistoryApplications } from './identity-group-history-apply-service.js';
import { groupClosedAssignmentPlanSchema } from './group-assignment-plan-schemas.js';
import { planGroupClosedAssignments } from './group-assignment-plan-service.js';
import { groupAssignmentApplicationParamsSchema, groupClosedAssignmentApplySchema } from './group-assignment-apply-schemas.js';
import { applyGroupClosedAssignments, getGroupAssignmentApplication, listGroupAssignmentApplications } from './group-assignment-apply-service.js';
import { groupAssignmentCorrectionParamsSchema, groupAssignmentCorrectionPlanSchema } from './group-assignment-correction-schemas.js';
import { planGroupAssignmentCorrection } from './group-assignment-correction-service.js';
import { groupCorrectionApplySchema, groupCorrectionReceiptParamsSchema } from './group-correction-apply-schemas.js';
import { applyGroupAssignmentCorrection, getGroupAssignmentCorrection, listGroupAssignmentCorrections } from './group-correction-apply-service.js';
import { groupRetirementPlanSchema } from './group-retirement-plan-schemas.js';
import { planGroupRetirement } from './group-retirement-plan-service.js';
import { groupRetirementApplySchema, groupRetirementReceiptParamsSchema } from './group-retirement-apply-schemas.js';
import { applyGroupRetirement, getGroupRetirement, listGroupRetirements } from './group-retirement-apply-service.js';
import { groupRetirementReconciliationSchema } from './group-retirement-reconciliation-schemas.js';
import { reconcileGroupRetirement } from './group-retirement-reconciliation-service.js';
import { groupRetirementDocumentApplySchema, groupRetirementDocumentParamsSchema, groupRetirementDocumentPlanSchema } from './group-retirement-document-schemas.js';
import { planGroupRetirementDocument } from './group-retirement-document-plan-service.js';
import { getGroupRetirementDocument, listGroupRetirementDocuments, recordGroupRetirementDocument } from './group-retirement-document-service.js';

function parse<T>(schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false } }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid import review request');
  return result.data;
}

export async function withReviewStorage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const model = error.meta?.modelName;
      if ((['P2021','P2022'].includes(error.code) && model === 'ImportAssignmentCorrection') || (error.code === 'P2010' && error.meta?.code === '42P01' && /\bImportAssignmentCorrection\b/.test(String(error.meta?.message)))) throw new ApiError(503, 'IMPORT_REVIEW_NOT_READY', 'Legacy correction storage is not installed');
      if ((['P2021','P2022'].includes(error.code) && model === 'ImportGroupRetirementDocument') ||
        (error.code === 'P2010' && error.meta?.code === '42P01' && /\bImportGroupRetirementDocument\b/.test(String(error.meta?.message)))) throw new ApiError(503, 'IMPORT_REVIEW_NOT_READY', 'Group documentary storage is not installed');
      if ((['P2021', 'P2022'].includes(error.code) && model === 'ImportRetirementReconciliation') ||
        (error.code === 'P2010' && error.meta?.code === '42P01' && /\bImportRetirementReconciliation\b/.test(String(error.meta?.message)))) {
        throw new ApiError(503, 'IMPORT_REVIEW_NOT_READY', 'Document reconciliation storage is not installed; complete the planned database migration');
      }
      const missingModel = ['P2021', 'P2022'].includes(error.code) && ['ImportBatch', 'ImportReviewDecision', 'ImportApplication', 'ImportApplicationItem', 'ImportSourceRevision', 'ImportHistoryCapture', 'ImportHistoricalEvidence', 'ImportAssignmentApplication', 'ImportAssignmentItem', 'ImportAssignmentEvidenceUse', 'ImportEvidenceAmendment', 'ImportRetirementApplication', 'ImportIdentityGroupReview', 'ImportIdentityGroupRow', 'ImportIdentityGroupRelease', 'ImportIdentityGroupDecision'].includes(String(model));
      const missingRawTable = error.code === 'P2010' && error.meta?.code === '42P01' && typeof error.meta?.message === 'string' && /\b(?:ImportBatch|ImportReviewDecision|ImportApplication|ImportApplicationItem|ImportSourceRevision|ImportHistoryCapture|ImportHistoricalEvidence|ImportAssignmentApplication|ImportAssignmentItem|ImportAssignmentEvidenceUse|ImportEvidenceAmendment|ImportHistoricalEvidenceCurrent|ImportRetirementApplication|ImportIdentityGroupDecision)\b/.test(error.meta.message);
      const missingGroupApplication = ['P2021', 'P2022'].includes(error.code) && ['ImportIdentityGroupApplication', 'ImportIdentityGroupApplicationItem', 'ImportIdentityGroupRowUse', 'ImportGroupRetirementApplication', 'ImportGroupRetirementRowUse'].includes(String(model));
      const missingGroupRaw = error.code === 'P2010' && error.meta?.code === '42P01' && typeof error.meta?.message === 'string' && /\b(?:ImportIdentityGroupApplication|ImportIdentityGroupApplicationItem|ImportIdentityGroupRowUse|ImportGroupRetirementApplication|ImportGroupRetirementRowUse)\b/.test(error.meta.message);
      const missingGroupHistory = ['P2021', 'P2022'].includes(error.code) && ['ImportGroupHistoryApplication', 'ImportGroupHistoryLink'].includes(String(model));
      const missingGroupAssignment = ['P2021', 'P2022'].includes(error.code) && ['ImportGroupAssignmentApplication', 'ImportGroupAssignmentItem', 'ImportGroupAssignmentEvidenceUse', 'ImportGroupAssignmentCorrection'].includes(String(model));
      if (error.code === 'P2010' && error.meta?.code === '42P01' && /AssignmentEffective/.test(String(error.meta?.message))) throw new ApiError(503, 'IMPORT_REVIEW_NOT_READY', 'Effective history storage is not installed');
      if (missingModel || missingRawTable || missingGroupApplication || missingGroupRaw || missingGroupHistory || missingGroupAssignment) throw new ApiError(503, 'IMPORT_REVIEW_NOT_READY', 'Import review storage is not installed; complete the planned database migration');
    }
    throw error;
  }
}

export function registerImportReviewRoutes(app: FastifyInstance, database: PrismaClient): void {
  const jefeOnly = requireRole(database, Role.JEFE);
  const historyItemPath = '/inventory/imports/batches/:id/identity-group-reviews/:reviewId/applications/:applicationId/items/:itemId';
  const retirementPath = '/inventory/imports/batches/:id/identity-group-reviews/:reviewId';
  app.post(retirementPath + '/retirement-document-plan', { preHandler: [jefeOnly, requireCsrf] }, async (request) => {
    const params = parse(identityGroupReviewParamsSchema, request.params); parse(identityGroupProjectionQuerySchema, request.query);
    return withReviewStorage(() => planGroupRetirementDocument(database, params.id, params.reviewId, parse(groupRetirementDocumentPlanSchema, request.body)));
  });
  app.post(retirementPath + '/retirement-document-plan/confirm', { preHandler: [jefeOnly, requireCsrf] }, async (request, reply) => {
    const params = parse(identityGroupReviewParamsSchema, request.params); parse(identityGroupProjectionQuerySchema, request.query);
    const result = await withReviewStorage(() => recordGroupRetirementDocument(database, params.id, params.reviewId, parse(groupRetirementDocumentApplySchema, request.body), request.auth!.user.id));
    return reply.status(result.reused ? 200 : 201).send(result);
  });
  app.get(retirementPath + '/retirement-documents', { preHandler: jefeOnly }, async (request) => {
    const params = parse(identityGroupReviewParamsSchema, request.params);
    return withReviewStorage(() => listGroupRetirementDocuments(database, params.id, params.reviewId, parse(historyPageSchema, request.query)));
  });
  app.get(retirementPath + '/retirement-documents/:reconciliationId', { preHandler: jefeOnly }, async (request) => {
    const params = parse(groupRetirementDocumentParamsSchema, request.params); parse(identityGroupProjectionQuerySchema, request.query);
    return withReviewStorage(() => getGroupRetirementDocument(database, params.id, params.reviewId, params.reconciliationId));
  });
  app.post(retirementPath + '/retirement-reconciliation', { preHandler: [jefeOnly, requireCsrf] }, async (request) => {
    const params = parse(identityGroupReviewParamsSchema, request.params); parse(identityGroupProjectionQuerySchema, request.query);
    return withReviewStorage(() => reconcileGroupRetirement(database, params.id, params.reviewId, parse(groupRetirementReconciliationSchema, request.body)));
  });
  app.post(retirementPath + '/retirement-plan/apply', { preHandler: [jefeOnly, requireCsrf] }, async (request, reply) => {
    const params = parse(identityGroupReviewParamsSchema, request.params); parse(identityGroupProjectionQuerySchema, request.query);
    const result = await withReviewStorage(() => applyGroupRetirement(database, params.id, params.reviewId, parse(groupRetirementApplySchema, request.body), request.auth!.user.id));
    return reply.status(result.reused ? 200 : 201).send(result);
  });
  app.get(retirementPath + '/retirement-applications', { preHandler: jefeOnly }, async (request) => {
    const params = parse(identityGroupReviewParamsSchema, request.params);
    return withReviewStorage(() => listGroupRetirements(database, params.id, params.reviewId, parse(historyPageSchema, request.query)));
  });
  app.get(retirementPath + '/retirement-applications/:groupRetirementApplicationId', { preHandler: jefeOnly }, async (request) => {
    const params = parse(groupRetirementReceiptParamsSchema, request.params); parse(identityGroupProjectionQuerySchema, request.query);
    return withReviewStorage(() => getGroupRetirement(database, params.id, params.reviewId, params.groupRetirementApplicationId));
  });
  app.post('/inventory/imports/batches/:id/identity-group-reviews/:reviewId/retirement-plan', { preHandler: [jefeOnly, requireCsrf] }, async (request) => {
    const params = parse(identityGroupReviewParamsSchema, request.params);
    parse(identityGroupProjectionQuerySchema, request.query);
    return withReviewStorage(() => planGroupRetirement(database, params.id, params.reviewId,
      parse(groupRetirementPlanSchema, request.body)));
  });
  const correctionPath = historyItemPath + '/closed-assignment-applications/:groupApplicationId/items/:assignmentItemId';
  const correctionParents = (params: { id: string; reviewId: string; applicationId: string; itemId: string; groupApplicationId: string; assignmentItemId: string }) => ({
    ...params, batchId: params.id
  });
  app.post(correctionPath + '/correction-plan/apply', { preHandler: [jefeOnly, requireCsrf] }, async (request, reply) => {
    const params = parse(groupAssignmentCorrectionParamsSchema, request.params);
    parse(identityGroupProjectionQuerySchema, request.query);
    const result = await withReviewStorage(() => applyGroupAssignmentCorrection(database, correctionParents(params), parse(groupCorrectionApplySchema, request.body), request.auth!.user.id));
    return reply.status(result.reused ? 200 : 201).send(result);
  });
  app.get(correctionPath + '/corrections', { preHandler: jefeOnly }, async (request) => {
    const params = parse(groupAssignmentCorrectionParamsSchema, request.params);
    return withReviewStorage(() => listGroupAssignmentCorrections(database, correctionParents(params), parse(historyPageSchema, request.query)));
  });
  app.get(correctionPath + '/corrections/:correctionId', { preHandler: jefeOnly }, async (request) => {
    const params = parse(groupCorrectionReceiptParamsSchema, request.params);
    parse(identityGroupProjectionQuerySchema, request.query);
    return withReviewStorage(() => getGroupAssignmentCorrection(database, correctionParents(params), params.correctionId));
  });
  app.post(historyItemPath + '/closed-assignment-applications/:groupApplicationId/items/:assignmentItemId/correction-plan',
    { preHandler: [jefeOnly, requireCsrf] }, async (request) => {
      const params = parse(groupAssignmentCorrectionParamsSchema, request.params);
      parse(identityGroupProjectionQuerySchema, request.query);
      return withReviewStorage(() => planGroupAssignmentCorrection(database, params.id, params.reviewId, params.applicationId, params.itemId,
        params.groupApplicationId, params.assignmentItemId, parse(groupAssignmentCorrectionPlanSchema, request.body)));
    });
  app.post(historyItemPath + '/closed-assignment-plan/apply', { preHandler: [jefeOnly, requireCsrf] }, async (request, reply) => {
    const params = parse(identityGroupHistoryParamsSchema, request.params);
    parse(identityGroupProjectionQuerySchema, request.query);
    const result = await withReviewStorage(() => applyGroupClosedAssignments(database, params.id, params.reviewId, params.applicationId, params.itemId,
      parse(groupClosedAssignmentApplySchema, request.body), request.auth!.user.id));
    return reply.status(result.reused ? 200 : 201).send(result);
  });
  app.get(historyItemPath + '/closed-assignment-applications', { preHandler: jefeOnly }, async (request) => {
    const params = parse(identityGroupHistoryParamsSchema, request.params);
    return withReviewStorage(() => listGroupAssignmentApplications(database, params.id, params.reviewId, params.applicationId, params.itemId, parse(historyPageSchema, request.query)));
  });
  app.get(historyItemPath + '/closed-assignment-applications/:groupApplicationId', { preHandler: jefeOnly }, async (request) => {
    const params = parse(groupAssignmentApplicationParamsSchema, request.params);
    parse(identityGroupProjectionQuerySchema, request.query);
    return withReviewStorage(() => getGroupAssignmentApplication(database, params.id, params.reviewId, params.applicationId, params.itemId, params.groupApplicationId));
  });
  app.post(historyItemPath + '/closed-assignment-plan', { preHandler: [jefeOnly, requireCsrf] }, async (request) => {
    const params = parse(identityGroupHistoryParamsSchema, request.params);
    parse(identityGroupProjectionQuerySchema, request.query);
    return withReviewStorage(() => planGroupClosedAssignments(database, params.id, params.reviewId, params.applicationId, params.itemId,
      parse(groupClosedAssignmentPlanSchema, request.body)));
  });
  app.post(historyItemPath + '/history-link-plan/apply', { preHandler: [jefeOnly, requireCsrf] }, async (request, reply) => {
    const params = parse(identityGroupHistoryParamsSchema, request.params);
    parse(identityGroupProjectionQuerySchema, request.query);
    const result = await withReviewStorage(() => applyGroupHistoryLinks(database, params.id, params.reviewId, params.applicationId, params.itemId,
      parse(groupHistoryApplySchema, request.body), request.auth!.user.id));
    return reply.status(result.reused ? 200 : 201).send(result);
  });
  app.get(historyItemPath + '/history-link-applications', { preHandler: jefeOnly }, async (request) => {
    const params = parse(identityGroupHistoryParamsSchema, request.params);
    return withReviewStorage(() => listGroupHistoryApplications(database, params.id, params.reviewId, params.applicationId, params.itemId, parse(historyPageSchema, request.query)));
  });
  app.get(historyItemPath + '/history-link-applications/:historyApplicationId', { preHandler: jefeOnly }, async (request) => {
    const params = parse(groupHistoryReceiptParamsSchema, request.params);
    parse(identityGroupProjectionQuerySchema, request.query);
    return withReviewStorage(() => getGroupHistoryApplication(database, params.id, params.reviewId, params.applicationId, params.itemId, params.historyApplicationId));
  });
  app.post('/inventory/imports/batches/:id/identity-group-reviews/:reviewId/applications/:applicationId/items/:itemId/history-link-plan', { preHandler: [jefeOnly, requireCsrf] }, async (request) => {
    const params = parse(identityGroupHistoryParamsSchema, request.params);
    parse(identityGroupProjectionQuerySchema, request.query);
    return withReviewStorage(() => planGroupHistoryLink(database, params.id, params.reviewId, params.applicationId, params.itemId, parse(identityGroupHistoryPlanSchema, request.body)));
  });
  app.post('/inventory/imports/batches/:id/identity-group-reviews/:reviewId/pilot-plan/apply', { preHandler: [jefeOnly, requireCsrf] }, async (request, reply) => {
    const params = parse(identityGroupReviewParamsSchema, request.params);
    parse(identityGroupProjectionQuerySchema, request.query);
    const result = await withReviewStorage(() => applyIdentityGroupPilot(database, params.id, params.reviewId, parse(identityGroupApplySchema, request.body), request.auth!.user.id));
    return reply.status(result.reused ? 200 : 201).send(result);
  });
  app.get('/inventory/imports/batches/:id/identity-group-reviews/:reviewId/applications', { preHandler: jefeOnly }, async (request) => {
    const params = parse(identityGroupReviewParamsSchema, request.params);
    return withReviewStorage(() => listIdentityGroupApplications(database, params.id, params.reviewId, parse(historyPageSchema, request.query)));
  });
  app.get('/inventory/imports/batches/:id/identity-group-reviews/:reviewId/applications/:applicationId', { preHandler: jefeOnly }, async (request) => {
    const params = parse(identityGroupApplicationParamsSchema, request.params);
    parse(identityGroupProjectionQuerySchema, request.query);
    return withReviewStorage(() => getIdentityGroupApplication(database, params.id, params.reviewId, params.applicationId));
  });
  app.post('/inventory/imports/batches/:id/identity-group-reviews/:reviewId/pilot-plan', { preHandler: [jefeOnly, requireCsrf] }, async (request) => {
    const params = parse(identityGroupReviewParamsSchema, request.params);
    parse(identityGroupProjectionQuerySchema, request.query);
    return withReviewStorage(() => planIdentityGroupPilot(database, params.id, params.reviewId, parse(identityGroupPilotSchema, request.body)));
  });
  app.post('/inventory/imports/batches/:id/identity-group-reviews/:reviewId/decisions', { preHandler: [jefeOnly, requireCsrf] }, async (request, reply) => {
    const params = parse(identityGroupReviewParamsSchema, request.params);
    const result = await withReviewStorage(() => appendIdentityGroupDecision(database, params.id, params.reviewId, parse(identityGroupDecisionSchema, request.body), request.auth!.user.id));
    return reply.status(result.reused ? 200 : 201).send(result);
  });
  app.get('/inventory/imports/batches/:id/identity-group-reviews/:reviewId/decisions', { preHandler: jefeOnly }, async (request) => {
    const params = parse(identityGroupReviewParamsSchema, request.params);
    return withReviewStorage(() => listIdentityGroupDecisions(database, params.id, params.reviewId, parse(identityGroupDecisionListSchema, request.query)));
  });
  app.get('/inventory/imports/batches/:id/identity-group-reviews/:reviewId/decisions/:decisionId', { preHandler: jefeOnly }, async (request) => {
    const params = parse(identityGroupDecisionParamsSchema, request.params);
    parse(identityGroupProjectionQuerySchema, request.query);
    return withReviewStorage(() => getIdentityGroupDecision(database, params.id, params.reviewId, params.decisionId));
  });
  app.get('/inventory/imports/batches/:id/identity-group-reviews/:reviewId/effective-preview', { preHandler: jefeOnly }, async (request) => {
    const params = parse(identityGroupReviewParamsSchema, request.params);
    parse(identityGroupProjectionQuerySchema, request.query);
    return withReviewStorage(() => getIdentityGroupProjection(database, params.id, params.reviewId));
  });
  app.post('/inventory/imports/batches/:id/identity-group-reviews', { preHandler: [jefeOnly, requireCsrf] }, async (request, reply) => {
    const result = await withReviewStorage(() => saveIdentityGroupReview(database, parse(batchIdSchema, request.params).id, parse(identityGroupReviewSchema, request.body), request.auth!.user.id));
    return reply.status(result.reused ? 200 : 201).send(result);
  });
  app.get('/inventory/imports/batches/:id/identity-group-reviews', { preHandler: jefeOnly }, async (request) =>
    withReviewStorage(() => listIdentityGroupReviews(database, parse(batchIdSchema, request.params).id, parse(historyPageSchema, request.query))));
  app.get('/inventory/imports/batches/:id/identity-group-reviews/:reviewId', { preHandler: jefeOnly }, async (request) => {
    const params = parse(identityGroupReviewParamsSchema, request.params);
    return withReviewStorage(() => getIdentityGroupReview(database, params.id, params.reviewId));
  });
  app.post('/inventory/imports/batches/:id/identity-group-reviews/:reviewId/release', { preHandler: [jefeOnly, requireCsrf] }, async (request, reply) => {
    const params = parse(identityGroupReviewParamsSchema, request.params);
    const result = await withReviewStorage(() => releaseIdentityGroupReview(database, params.id, params.reviewId, parse(identityGroupReleaseSchema, request.body), request.auth!.user.id));
    return reply.status(result.reused ? 200 : 201).send(result);
  });
  app.post('/inventory/imports/batches/:id/identity-group-plan', { preHandler: [jefeOnly, requireCsrf] }, async (request) =>
    withReviewStorage(() => planIdentityGroups(database, parse(batchIdSchema, request.params).id, parse(identityGroupPlanSchema, request.body))));
  app.post('/assets/:id/imported-retirement-reconciliation', { preHandler: [jefeOnly, requireCsrf] }, async (request) =>
    withReviewStorage(() => reconcileHistoricalRetirement(database, parse(batchIdSchema, request.params).id, parse(retirementReconciliationSchema, request.body))));
  app.post('/assets/:id/imported-retirement-document-plan', { preHandler: [jefeOnly, requireCsrf] }, async (request) =>
    withReviewStorage(() => planRetirementDocument(database, parse(batchIdSchema, request.params).id, parse(retirementDocumentPlanSchema, request.body))));
  app.post('/assets/:id/imported-retirement-document-plan/confirm', { preHandler: [jefeOnly, requireCsrf] }, async (request, reply) => {
    const result = await withReviewStorage(() => recordRetirementDocument(database, parse(batchIdSchema, request.params).id,
      parse(retirementDocumentApplySchema, request.body), request.auth!.user.id));
    return reply.status(result.reused ? 200 : 201).send(result);
  });
  app.get('/assets/:id/imported-retirement-documents', { preHandler: jefeOnly }, async (request) =>
    withReviewStorage(() => listRetirementDocuments(database, parse(batchIdSchema, request.params).id, parse(historyPageSchema, request.query))));
  app.get('/assets/:id/imported-retirement-documents/:reconciliationId', { preHandler: jefeOnly }, async (request) => {
    const params = parse(retirementDocumentParamsSchema, request.params);
    return withReviewStorage(() => getRetirementDocument(database, params.id, params.reconciliationId));
  });
  app.post('/assets/:id/imported-retirement-plan/apply', { preHandler: [jefeOnly, requireCsrf] }, async (request, reply) => {
    const result = await withReviewStorage(() => applyHistoricalRetirement(database, parse(batchIdSchema, request.params).id, parse(historicalRetirementApplySchema, request.body), request.auth!.user.id));
    return reply.status(result.reused ? 200 : 201).send(result);
  });
  app.get('/assets/:id/imported-retirement-applications', { preHandler: jefeOnly }, async (request) =>
    withReviewStorage(() => listRetirementApplications(database, parse(batchIdSchema, request.params).id, parse(historyPageSchema, request.query))));
  app.get('/assets/:id/imported-retirement-applications/:applicationId', { preHandler: jefeOnly }, async (request) => {
    const params = parse(retirementApplicationParamsSchema, request.params);
    return withReviewStorage(() => getRetirementApplication(database, params.id, params.applicationId));
  });
  app.post('/assets/:id/imported-retirement-plan', { preHandler: [jefeOnly, requireCsrf] }, async (request) =>
    withReviewStorage(() => planHistoricalRetirement(database, parse(batchIdSchema, request.params).id, parse(historicalRetirementPlanSchema, request.body))));
  app.post('/inventory/imports/evidence/:id/amendment-plan', { preHandler: [jefeOnly, requireCsrf] }, async (request) =>
    withReviewStorage(() => planEvidenceAmendment(database, parse(batchIdSchema, request.params).id, parse(evidenceAmendmentPlanSchema, request.body).assetId)));
  app.post('/inventory/imports/evidence/:id/amendments', { preHandler: [jefeOnly, requireCsrf] }, async (request, reply) => {
    const result = await withReviewStorage(() => amendHistoricalEvidence(database, parse(batchIdSchema, request.params).id, parse(evidenceAmendmentSchema, request.body), request.auth!.user.id));
    return reply.status(result.reused ? 200 : 201).send(result);
  });
  app.get('/inventory/imports/evidence/:id/amendments', { preHandler: jefeOnly }, async (request) =>
    withReviewStorage(() => listEvidenceAmendments(database, parse(batchIdSchema, request.params).id, parse(historyPageSchema, request.query))));
  app.get('/inventory/imports/evidence/:id/amendments/:amendmentId', { preHandler: jefeOnly }, async (request) => {
    const params = parse(evidenceAmendmentParamsSchema, request.params);
    return withReviewStorage(() => getEvidenceAmendment(database, params.id, params.amendmentId));
  });
  const legacyCorrectionPath = '/assets/:id/imported-assignment-applications/:applicationId/items/:assignmentItemId';
  app.post(legacyCorrectionPath + '/correction-plan/apply', { preHandler: [jefeOnly, requireCsrf] }, async (request, reply) => {
    const params = parse(assignmentCorrectionParamsSchema, request.params); parse(identityGroupProjectionQuerySchema, request.query);
    const result = await withReviewStorage(() => applyAssignmentCorrection(database, params.id, params.applicationId, params.assignmentItemId, parse(assignmentCorrectionApplySchema, request.body), request.auth!.user.id));
    return reply.status(result.reused ? 200 : 201).send(result);
  });
  app.get(legacyCorrectionPath + '/corrections', { preHandler: jefeOnly }, async (request) => {
    const params = parse(assignmentCorrectionParamsSchema, request.params);
    return withReviewStorage(() => listAssignmentCorrections(database, params.id, params.applicationId, params.assignmentItemId, parse(historyPageSchema, request.query)));
  });
  app.get(legacyCorrectionPath + '/corrections/:correctionId', { preHandler: jefeOnly }, async (request) => {
    const params = parse(assignmentCorrectionReceiptParamsSchema, request.params); parse(identityGroupProjectionQuerySchema, request.query);
    return withReviewStorage(() => getAssignmentCorrection(database, params.id, params.applicationId, params.assignmentItemId, params.correctionId));
  });
  app.post(legacyCorrectionPath + '/correction-plan', { preHandler: [jefeOnly, requireCsrf] }, async (request) => {
    const params = parse(assignmentCorrectionParamsSchema, request.params); parse(identityGroupProjectionQuerySchema, request.query);
    return withReviewStorage(() => planAssignmentCorrection(database, params.id, params.applicationId, params.assignmentItemId, parse(assignmentCorrectionPlanSchema, request.body)));
  });
  app.post('/assets/:id/imported-assignment-plan/apply', { preHandler: [jefeOnly, requireCsrf] }, async (request, reply) => {
    const result = await withReviewStorage(() => applyClosedAssignments(database, parse(batchIdSchema, request.params).id, parse(closedAssignmentApplySchema, request.body), request.auth!.user.id));
    return reply.status(result.reused ? 200 : 201).send(result);
  });
  app.get('/assets/:id/imported-assignment-applications', { preHandler: jefeOnly }, async (request) =>
    withReviewStorage(() => listAssignmentApplications(database, parse(batchIdSchema, request.params).id, parse(historyPageSchema, request.query))));
  app.get('/assets/:id/imported-assignment-applications/:applicationId', { preHandler: jefeOnly }, async (request) => {
    const params = parse(assignmentApplicationParamsSchema, request.params);
    return withReviewStorage(() => getAssignmentApplication(database, params.id, params.applicationId));
  });
  app.post('/assets/:id/imported-assignment-plan', { preHandler: [jefeOnly, requireCsrf] }, async (request) =>
    withReviewStorage(() => planClosedAssignments(database, parse(batchIdSchema, request.params).id, parse(closedAssignmentPlanSchema, request.body))));
  app.get('/inventory/imports/batches/:id/history-preview', { preHandler: jefeOnly }, async (request) =>
    withReviewStorage(() => previewHistoricalEvidence(database, parse(batchIdSchema, request.params).id, parse(historyPageSchema, request.query))));
  app.post('/inventory/imports/batches/:id/history-captures', { preHandler: [jefeOnly, requireCsrf] }, async (request, reply) => {
    const result = await withReviewStorage(() => captureHistoricalEvidence(database, parse(batchIdSchema, request.params).id, parse(historyCaptureSchema, request.body), request.auth!.user.id));
    return reply.status(result.reused ? 200 : 201).send(result);
  });
  app.get('/inventory/imports/batches/:id/history-captures', { preHandler: jefeOnly }, async (request) =>
    withReviewStorage(() => listHistoryCaptures(database, parse(batchIdSchema, request.params).id, parse(historyPageSchema, request.query))));
  app.get('/inventory/imports/batches/:id/history-captures/:captureId', { preHandler: jefeOnly }, async (request) => {
    const params = parse(historyCaptureIdSchema, request.params);
    return withReviewStorage(() => getHistoryCapture(database, params.id, params.captureId));
  });
  app.get('/assets/:id/imported-evidence', { preHandler: requireAuthenticated(database) }, async (request) =>
    withReviewStorage(() => listAssetImportedEvidence(database, parse(batchIdSchema, request.params).id, parse(historyPageSchema, request.query))));
  app.post('/inventory/imports/batches/:id/identity-revisions', { preHandler: [jefeOnly, requireCsrf] }, async (request, reply) => {
    const result = await withReviewStorage(() => appendIdentityRevision(database, parse(batchIdSchema, request.params).id, parse(identityRevisionSchema, request.body), request.auth!.user.id));
    return reply.status(result.reused ? 200 : 201).send(result);
  });
  app.post('/inventory/imports/batches/:id/source-revisions', { preHandler: [jefeOnly, requireCsrf] }, async (request, reply) => {
    const result = await withReviewStorage(() => appendSourceRevision(database, parse(batchIdSchema, request.params).id, parse(sourceRevisionSchema, request.body), request.auth!.user.id));
    return reply.status(result.reused ? 200 : 201).send(result);
  });
  app.get('/inventory/imports/batches/:id/source-revisions', { preHandler: jefeOnly }, async (request) =>
    withReviewStorage(() => listSourceRevisions(database, parse(batchIdSchema, request.params).id, parse(sourcePageSchema, request.query))));
  app.get('/inventory/imports/batches/:id/resolved-preview', { preHandler: jefeOnly }, async (request) =>
    withReviewStorage(() => getResolvedPreview(database, parse(batchIdSchema, request.params).id)));
  app.get('/inventory/imports/batches/:id/catalog-review', { preHandler: jefeOnly }, async (request) =>
    withReviewStorage(() => getSourceCatalog(database, parse(batchIdSchema, request.params).id, parse(sourcePageSchema, request.query))));
  app.post('/inventory/imports/batches/:id/apply', { preHandler: [jefeOnly, requireCsrf] }, async (request, reply) => {
    const result = await withReviewStorage(() => applyImportPilot(database, parse(batchIdSchema, request.params).id, parse(pilotApplySchema, request.body), request.auth!.user.id));
    return reply.status(result.reused ? 200 : 201).send(result);
  });
  app.get('/inventory/imports/batches/:id/applications', { preHandler: jefeOnly }, async (request) =>
    withReviewStorage(() => listImportApplications(database, parse(batchIdSchema, request.params).id, parse(applicationListSchema, request.query))));
  app.get('/inventory/imports/batches/:id/applications/:applicationId', { preHandler: jefeOnly }, async (request) => {
    const params = parse(applicationIdSchema, request.params);
    return withReviewStorage(() => getImportApplication(database, params.id, params.applicationId));
  });
  app.post('/inventory/imports/batches/:id/plan', { preHandler: [jefeOnly, requireCsrf] }, async (request) =>
    withReviewStorage(() => planImportPilot(database, parse(batchIdSchema, request.params).id, parse(pilotPlanSchema, request.body))));
  app.post('/inventory/imports/batches', { bodyLimit: previewBodyLimit, preHandler: [jefeOnly, requireCsrf] }, async (request, reply) => {
    const result = await withReviewStorage(() => createImportBatch(database, parse(batchCreateSchema, request.body), request.auth!.user.id));
    return reply.status(result.reused ? 200 : 201).send(result);
  });
  app.get('/inventory/imports/batches', { preHandler: jefeOnly }, async (request) => withReviewStorage(() => listImportBatches(database, parse(batchListSchema, request.query))));
  app.get('/inventory/imports/batches/:id', { preHandler: jefeOnly }, async (request) => withReviewStorage(() => getImportBatch(database, parse(batchIdSchema, request.params).id)));
  app.get('/inventory/imports/batches/:id/preview', { preHandler: jefeOnly }, async (request) => withReviewStorage(() => getImportSnapshot(database, parse(batchIdSchema, request.params).id)));
  app.get('/inventory/imports/batches/:id/freshness', { preHandler: jefeOnly }, async (request) => withReviewStorage(() => getImportFreshness(database, parse(batchIdSchema, request.params).id)));
  app.get('/inventory/imports/batches/:id/decisions', { preHandler: jefeOnly }, async (request) => withReviewStorage(() => listReviewDecisions(database, parse(batchIdSchema, request.params).id, parse(decisionListSchema, request.query))));
  app.post('/inventory/imports/batches/:id/decisions', { preHandler: [jefeOnly, requireCsrf] }, async (request, reply) => {
    const result = await withReviewStorage(() => appendReviewDecision(database, parse(batchIdSchema, request.params).id, parse(reviewDecisionSchema, request.body), request.auth!.user.id));
    return reply.status(result.reused ? 200 : 201).send(result);
  });
}
