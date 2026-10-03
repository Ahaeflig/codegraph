import type { Edge } from '../types';

/**
 * Transport evidence records a real ABI hop, but does not establish which
 * operation a shared dispatcher runs. Its source-specific semantic edges are
 * inferred separately. Do not compose transport-only hops into call/impact
 * paths: doing so merges every operation through the shared dispatcher.
 *
 * Raw edge queries and findUsages deliberately retain this evidence. Only an
 * explicit boolean marker opts out; ordinary calls/references are unchanged.
 */
export function isSemanticEdge(edge: Edge): boolean {
  return edge.metadata?.transportOnly !== true;
}
