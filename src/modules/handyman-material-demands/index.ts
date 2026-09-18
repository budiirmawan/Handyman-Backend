export * from './handyman-material-demand.types';
export * from './handyman-material-demand.errors';
export * from './handyman-material-demand.repository';
export * from './handyman-material-demand.service';
// Run-2 keeps its inventory bridge in a focused module but re-exports the
// command surface here beside the demand authority for direct service callers.
export * from '../handyman-material-inventory';
