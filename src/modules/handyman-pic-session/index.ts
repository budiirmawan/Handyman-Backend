/**
 * W03 PART 03C — bounded Tenant PIC session (BM Super App secure handoff).
 *
 * Deliberately narrow exports: the credential seam (admission, use,
 * revocation, introspection), the router, the BM-side signer used by
 * integration partners and tests, and the projection types. Nothing here
 * reaches a quotation, a decision, a binding, an Execution Scope, or any staff
 * surface — the decide path is 03E, the read path is 03D, and this module must
 * not become a second way to do either.
 */
export { createPicWorkspaceRouter } from './pic-workspace-session.routes';
export {
  admitPicWorkspace,
  canonicalPicWorkspaceAssertion,
  parsePicWorkspaceAssertion,
  readPicWorkspaceBearer,
  readPicWorkspaceSession,
  resolvePicWorkspacePrincipal,
  revokePicWorkspaceSession,
  signPicWorkspaceAssertion,
} from './pic-workspace-session.service';
export {
  PIC_WORKSPACE_MAX_TTL_SECONDS,
  PIC_WORKSPACE_PURPOSE,
  PIC_WORKSPACE_TOKEN_PREFIX,
  readPicWorkspaceRuntimeConfig,
  type PicWorkspaceAssertion,
  type PicWorkspacePrincipal,
  type PicWorkspaceRepresentation,
  type PublicPicWorkspaceSession,
} from './pic-workspace-session.types';
export {
  picWorkspaceRejectsContextError,
  picWorkspaceResourceNotFound,
  picWorkspaceUnauthorized,
} from './pic-workspace-session.errors';
