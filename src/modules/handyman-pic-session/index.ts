/**
 * W03 PART 03C — bounded Tenant PIC session (BM Super App secure handoff).
 *
 * Deliberately narrow exports: the credential seam (admission, use,
 * revocation, introspection) plus the ONE seam business surfaces are allowed to
 * use it through (`withPicWorkspaceSession`, `assertPicWorkspaceSessionCurrent`),
 * the router, the BM-side signer used by integration partners and tests, and the
 * projection types. Nothing here reaches a quotation, a decision, a binding, an
 * Execution Scope, or any staff surface — the decide path is 03E, the read path
 * is 03D, and this module must not become a second way to do either. It is also
 * not a place to re-implement authentication: 03D/03E call the two functions
 * above so that a business route can never be "authenticated" more weakly than
 * the session endpoint itself.
 */
export { createPicWorkspaceRouter } from './pic-workspace-session.routes';
export {
  admitPicWorkspace,
  assertPicWorkspaceSessionCurrent,
  canonicalPicWorkspaceAssertion,
  parsePicWorkspaceAssertion,
  readPicWorkspaceBearer,
  readPicWorkspaceSession,
  resolvePicWorkspacePrincipal,
  revokePicWorkspaceSession,
  signPicWorkspaceAssertion,
  withPicWorkspaceSession,
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
